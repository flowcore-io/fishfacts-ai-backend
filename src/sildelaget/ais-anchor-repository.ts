import type { Database } from "@/db/client";
import { type SQL, sql } from "drizzle-orm";
import type {
  SildelagetAisAnchor,
  SildelagetAisAnchorStatus,
  SildelagetAisRun,
} from "./ais-anchor";

/** A report waiting for (or due a re-run of) its derived position. */
export type SildelagetAnchorCandidate = {
  innmeldingId: string;
  reportedDate: string | null;
  reportedTime: string | null;
  vesselName: string | null;
  registrationMark: string | null;
  reportedLatitude: number | null;
  reportedLongitude: number | null;
};

/** A stored anchor, as served on /api/catch. */
export type SildelagetAisAnchorRecord = SildelagetAisAnchor & {
  computedAt: string;
};

type AnchorDbRow = {
  innmelding_id: string;
  status: string;
  vessel_id: number | string | null;
  reported_at: Date | string | null;
  reported_latitude: number | string | null;
  reported_longitude: number | string | null;
  window_from: Date | string;
  window_to: Date | string;
  fix_count: number | string;
  runs: unknown;
  computed_at: Date | string;
};

const ANCHOR_COLUMNS = sql`
  a.innmelding_id,
  a.status,
  a.vessel_id,
  a.reported_at,
  a.reported_latitude,
  a.reported_longitude,
  a.window_from,
  a.window_to,
  a.fix_count,
  a.runs,
  a.computed_at
`;

export class SildelagetAisAnchorRepository {
  constructor(private readonly db: Database) {}

  /**
   * Reports in the window that need deriving: never derived, derived under a
   * different threshold set, derived before the report itself last changed —
   * or derived to a non-ok status recently enough to be worth asking again.
   * `recompute` takes everything in the window regardless.
   *
   * That last clause is what keeps a temporary answer temporary. A report
   * stored as no-vessel (registry did not have the vessel yet) or no-track
   * (AIS ingest had not caught up with the window yet) would otherwise be
   * final the moment it was written, because nothing else in this predicate
   * ever looks at it again.
   *
   * Planned as a Seq Scan, and left that way on purpose: the OR-chain spans
   * both sides of the LEFT JOIN, so no index on `status` is sargable here.
   * Measured at 66 ms over 20k entries × 20k anchors, once an hour.
   */
  async listCandidates(options: {
    from: string;
    to: string;
    paramsHash: string;
    recompute: boolean;
    limit: number;
    /** Non-ok statuses to re-derive. Empty ⇒ no status-based retry. */
    retryStatuses: string[];
    /**
     * Leave a stored answer alone for this long before asking again.
     * Converted to whole minutes for MAKE_INTERVAL, whose parameters are
     * integers — `hours => 0.5` is not a slow query, it is a failed run.
     */
    retryAfterHours: number;
    /** Only retry reports dated on or after this (journal-local) date. */
    retryReportedFrom: string;
  }): Promise<SildelagetAnchorCandidate[]> {
    const retry =
      options.retryStatuses.length === 0
        ? sql`FALSE`
        : sql`(
            a.status IN (${sql.join(
              options.retryStatuses.map((status) => sql`${status}`),
              sql`, `,
            )})
            AND a.computed_at < NOW() - MAKE_INTERVAL(mins => ${Math.round(
              options.retryAfterHours * 60,
            )})
            AND e.reported_date >= ${options.retryReportedFrom}
          )`;
    const staleness = options.recompute
      ? sql`TRUE`
      : sql`(
          a.innmelding_id IS NULL
          OR a.params_hash <> ${options.paramsHash}
          OR a.computed_at < e.updated_at
          OR ${retry}
        )`;
    const rows = await execRows<{
      innmelding_id: string;
      reported_date: string | null;
      reported_time: string | null;
      vessel_name: string | null;
      registration_mark: string | null;
      reported_latitude: number | string | null;
      reported_longitude: number | string | null;
    }>(
      this.db,
      sql`
        SELECT
          e.innmelding_id,
          e.reported_date,
          e.reported_time,
          e.vessel_name,
          e.registration_mark,
          r.route_center_latitude  AS reported_latitude,
          r.route_center_longitude AS reported_longitude
        FROM sildelaget_catch_entries e
        LEFT JOIN sildelaget_catch_ais_anchors a
          ON a.innmelding_id = e.innmelding_id
        -- The report's own coordinate: the LAST cast/tow line that carries one,
        -- which is the point the bubble layer places the report on today.
        LEFT JOIN LATERAL (
          SELECT l.route_center_latitude, l.route_center_longitude
          FROM sildelaget_catch_lines l
          WHERE l.innmelding_id = e.innmelding_id
            AND l.route_center_latitude IS NOT NULL
            AND l.route_center_longitude IS NOT NULL
          ORDER BY l.line_index DESC
          LIMIT 1
        ) r ON TRUE
        WHERE e.reported_date IS NOT NULL
          -- A date this shape is one reportEpochMs can read. Anything else has
          -- no window to look in and would be re-listed, re-resolved and
          -- skipped on every run, forever. Character classes, not \\d: this
          -- SQL is a TS template literal, where a backslash escape is eaten
          -- before Postgres ever sees it (\\d becomes a literal 'd').
          AND e.reported_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND e.reported_date >= ${options.from}
          AND e.reported_date <= ${options.to}
          AND ${staleness}
        ORDER BY e.reported_date DESC, e.innmelding_id DESC
        LIMIT ${options.limit}
      `,
    );
    return rows.map((row) => ({
      innmeldingId: row.innmelding_id,
      reportedDate: row.reported_date,
      reportedTime: row.reported_time,
      vesselName: row.vessel_name,
      registrationMark: row.registration_mark,
      reportedLatitude: numberOrNull(row.reported_latitude),
      reportedLongitude: numberOrNull(row.reported_longitude),
    }));
  }

  /** Upsert derived anchors — one statement per row, all in one transaction. */
  async upsertMany(
    anchors: SildelagetAisAnchor[],
    params: Record<string, unknown>,
    paramsHash: string,
  ): Promise<number> {
    if (anchors.length === 0) return 0;
    await this.db.transaction(async (tx) => {
      for (const anchor of anchors) {
        await tx.execute(sql`
          INSERT INTO sildelaget_catch_ais_anchors (
            innmelding_id, status, vessel_id, reported_at,
            reported_latitude, reported_longitude,
            window_from, window_to, fix_count, runs, params, params_hash,
            computed_at
          ) VALUES (
            ${anchor.innmeldingId},
            ${anchor.status},
            ${anchor.vesselId},
            ${anchor.reportedAt},
            ${anchor.reportedLatitude},
            ${anchor.reportedLongitude},
            ${anchor.windowFrom},
            ${anchor.windowTo},
            ${anchor.fixCount},
            ${JSON.stringify(anchor.runs)}::jsonb,
            ${JSON.stringify(params)}::jsonb,
            ${paramsHash},
            NOW()
          )
          ON CONFLICT (innmelding_id) DO UPDATE SET
            status              = EXCLUDED.status,
            vessel_id           = EXCLUDED.vessel_id,
            reported_at         = EXCLUDED.reported_at,
            reported_latitude   = EXCLUDED.reported_latitude,
            reported_longitude  = EXCLUDED.reported_longitude,
            window_from         = EXCLUDED.window_from,
            window_to           = EXCLUDED.window_to,
            fix_count           = EXCLUDED.fix_count,
            runs                = EXCLUDED.runs,
            params              = EXCLUDED.params,
            params_hash         = EXCLUDED.params_hash,
            computed_at         = EXCLUDED.computed_at
        `);
      }
    });
    return anchors.length;
  }

  /** Stored anchors for a set of reports, keyed by innmelding id. */
  async loadByInnmeldingIds(
    innmeldingIds: string[],
  ): Promise<Map<string, SildelagetAisAnchorRecord>> {
    const byId = new Map<string, SildelagetAisAnchorRecord>();
    if (innmeldingIds.length === 0) return byId;
    const rows = await execRows<AnchorDbRow>(
      this.db,
      sql`
        SELECT ${ANCHOR_COLUMNS}
        FROM sildelaget_catch_ais_anchors a
        WHERE a.innmelding_id IN (${sql.join(
          innmeldingIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      `,
    );
    for (const row of rows) {
      byId.set(row.innmelding_id, toAnchorRecord(row));
    }
    return byId;
  }

  /**
   * Anchors for every report in a date range — the /api/catch bubble layer
   * wants them all at once, not per report.
   */
  async loadForDateRange(range: {
    from: string;
    to: string;
    conditions?: SQL[];
  }): Promise<SildelagetAisAnchorRecord[]> {
    const extra = range.conditions ?? [];
    const rows = await execRows<AnchorDbRow>(
      this.db,
      sql`
        SELECT DISTINCT ${ANCHOR_COLUMNS}
        FROM sildelaget_catch_ais_anchors a
        JOIN sildelaget_catch_entries e ON e.innmelding_id = a.innmelding_id
        LEFT JOIN sildelaget_catch_lines l ON l.innmelding_id = e.innmelding_id
        WHERE e.reported_date IS NOT NULL
          AND e.reported_date >= ${range.from}
          AND e.reported_date <= ${range.to}
          ${extra.length > 0 ? sql`AND ${andAll(extra)}` : sql``}
        ORDER BY a.innmelding_id
      `,
    );
    return rows.map(toAnchorRecord);
  }
}

export function toAnchorRecord(row: AnchorDbRow): SildelagetAisAnchorRecord {
  return {
    innmeldingId: row.innmelding_id,
    status: row.status as SildelagetAisAnchorStatus,
    vesselId: numberOrNull(row.vessel_id),
    reportedAt: isoOrNull(row.reported_at),
    reportedLatitude: numberOrNull(row.reported_latitude),
    reportedLongitude: numberOrNull(row.reported_longitude),
    windowFrom: isoOrNull(row.window_from) ?? "",
    windowTo: isoOrNull(row.window_to) ?? "",
    fixCount: Number(row.fix_count ?? 0),
    runs: Array.isArray(row.runs) ? (row.runs as SildelagetAisRun[]) : [],
    computedAt: isoOrNull(row.computed_at) ?? "",
  };
}

function andAll(conditions: SQL[]): SQL {
  let combined = conditions[0] as SQL;
  for (let i = 1; i < conditions.length; i++) {
    combined = sql`${combined} AND ${conditions[i]}`;
  }
  return combined;
}

async function execRows<T extends Record<string, unknown>>(
  db: Database,
  query: SQL,
): Promise<T[]> {
  const result = await db.execute<T>(query);
  if (Array.isArray(result)) return result as T[];
  return ((result as unknown as { rows?: T[] }).rows ?? []) as T[];
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? (parsed as number) : null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string"
    ? new Date(value).toISOString()
    : value.toISOString();
}
