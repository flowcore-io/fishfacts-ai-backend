import { Buffer } from "node:buffer";
import type { Database } from "@/db/client";
import { sildelagetCatchEntries, sildelagetCatchLines } from "@/db/schema";
import type { SildelagetCatchEntryObserved } from "@/events/contracts";
import { type SQL, eq, sql } from "drizzle-orm";

export type CatchFilters = {
  from: string;
  to: string;
  species?: string;
  vesselName?: string;
  registrationMark?: string;
};

export type FullCatchFilters = CatchFilters & {
  innmeldingId?: string;
  q?: string;
  limit: number;
  cursor?: string | null;
};

export type FishfactsCatchResponse = {
  code: 0;
  errors: [];
  message: "";
  data: {
    catches: DayCatchResponse[];
    locations: [];
  };
};

export type DayCatchResponse = {
  date: string;
  totalFullWeightKg: number;
  totalGuttedWeightKg: number;
  totalWeightKg: number;
  catches: CatchResponse[];
};

export type CatchResponse = {
  specie: string;
  fullWeightKg: number;
  guttedWeightKg: number;
  weightKg: number;
};

export type SildelagetCatchLineRecord =
  SildelagetCatchEntryObserved["lines"][number] & {
    innmeldingId: string;
    sourceEventId: string;
    createdAt: string;
    updatedAt: string;
  };

export type SildelagetCatchEntryRecord = Omit<
  SildelagetCatchEntryObserved,
  "lines"
> & {
  sourceEventId: string;
  createdAt: string;
  updatedAt: string;
  lines: SildelagetCatchLineRecord[];
};

export type CatchFullPage = {
  rows: SildelagetCatchEntryRecord[];
  nextCursor: string | null;
};

type AggregateRow = {
  reported_date: string;
  species: string;
  weight_kg: number | string | null;
};

type EntryDbRow = {
  innmelding_id: string;
  reported_date: string | null;
  reported_time: string | null;
  vessel_name: string | null;
  registration_mark: string | null;
  entry_hash: string;
  source_url: string;
  raw_entry: Record<string, unknown>;
  source_event_id: string;
  checked_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type LineDbRow = {
  line_key: string;
  innmelding_id: string;
  line_index: number;
  fishing_start_date: string | null;
  fishing_start_time: string | null;
  species: string | null;
  tonnes: number | string | null;
  weight_kg: number | string | null;
  average: number | string | null;
  catch_type: string | null;
  sales_type: string | null;
  gear: string | null;
  route: string | null;
  use: string | null;
  pct1: number | string | null;
  pct2: number | string | null;
  pct3: number | string | null;
  pct4: number | string | null;
  assortment: string | null;
  offer_east_south: string | null;
  offer_east_south_date: string | null;
  offer_east_south_time: string | null;
  offer_east_north: string | null;
  offer_east_north_date: string | null;
  offer_east_north_time: string | null;
  offer_west_south: string | null;
  offer_west_south_date: string | null;
  offer_west_south_time: string | null;
  offer_west_north: string | null;
  offer_west_north_date: string | null;
  offer_west_north_time: string | null;
  leased_vessel: string | null;
  economic_zone: string | null;
  municipality: string | null;
  co_fisher: string | null;
  buyer: string | null;
  receiver: string | null;
  nationality: string | null;
  raw_row: Record<string, unknown>;
  source_event_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const ENTRY_COLUMNS = sql`
  e.innmelding_id,
  e.reported_date,
  e.reported_time,
  e.vessel_name,
  e.registration_mark,
  e.entry_hash,
  e.source_url,
  e.raw_entry,
  e.source_event_id,
  e.checked_at,
  e.created_at,
  e.updated_at
`;

const LINE_COLUMNS = sql`
  l.line_key,
  l.innmelding_id,
  l.line_index,
  l.fishing_start_date,
  l.fishing_start_time,
  l.species,
  l.tonnes,
  l.weight_kg,
  l.average,
  l.catch_type,
  l.sales_type,
  l.gear,
  l.route,
  l.use,
  l.pct1,
  l.pct2,
  l.pct3,
  l.pct4,
  l.assortment,
  l.offer_east_south,
  l.offer_east_south_date,
  l.offer_east_south_time,
  l.offer_east_north,
  l.offer_east_north_date,
  l.offer_east_north_time,
  l.offer_west_south,
  l.offer_west_south_date,
  l.offer_west_south_time,
  l.offer_west_north,
  l.offer_west_north_date,
  l.offer_west_north_time,
  l.leased_vessel,
  l.economic_zone,
  l.municipality,
  l.co_fisher,
  l.buyer,
  l.receiver,
  l.nationality,
  l.raw_row,
  l.source_event_id,
  l.created_at,
  l.updated_at
`;

export class SildelagetCatchRepository {
  constructor(private readonly db: Database) {}

  async getEntryHashes(): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        innmeldingId: sildelagetCatchEntries.innmeldingId,
        entryHash: sildelagetCatchEntries.entryHash,
      })
      .from(sildelagetCatchEntries);
    return new Map(rows.map((row) => [row.innmeldingId, row.entryHash]));
  }

  async upsertObservedEntry(
    eventId: string,
    payload: SildelagetCatchEntryObserved,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ entryHash: sildelagetCatchEntries.entryHash })
        .from(sildelagetCatchEntries)
        .where(eq(sildelagetCatchEntries.innmeldingId, payload.innmeldingId))
        .limit(1);

      if (existing[0]?.entryHash === payload.entryHash) {
        return false;
      }

      const now = new Date();
      await tx
        .insert(sildelagetCatchEntries)
        .values({
          innmeldingId: payload.innmeldingId,
          reportedDate: payload.reportedDate,
          reportedTime: payload.reportedTime,
          vesselName: payload.vesselName,
          registrationMark: payload.registrationMark,
          entryHash: payload.entryHash,
          sourceUrl: payload.sourceUrl,
          rawEntry: payload.rawEntry,
          sourceEventId: eventId,
          checkedAt: new Date(payload.checkedAt),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: sildelagetCatchEntries.innmeldingId,
          set: {
            reportedDate: payload.reportedDate,
            reportedTime: payload.reportedTime,
            vesselName: payload.vesselName,
            registrationMark: payload.registrationMark,
            entryHash: payload.entryHash,
            sourceUrl: payload.sourceUrl,
            rawEntry: payload.rawEntry,
            sourceEventId: eventId,
            checkedAt: new Date(payload.checkedAt),
            updatedAt: now,
          },
        });

      await tx
        .delete(sildelagetCatchLines)
        .where(eq(sildelagetCatchLines.innmeldingId, payload.innmeldingId));

      if (payload.lines.length > 0) {
        await tx.insert(sildelagetCatchLines).values(
          payload.lines.map((line) => ({
            lineKey: line.lineKey,
            innmeldingId: payload.innmeldingId,
            lineIndex: line.lineIndex,
            fishingStartDate: line.fishingStartDate,
            fishingStartTime: line.fishingStartTime,
            species: line.species,
            tonnes: line.tonnes,
            weightKg: line.weightKg,
            average: line.average,
            catchType: line.catchType,
            salesType: line.salesType,
            gear: line.gear,
            route: line.route,
            use: line.use,
            pct1: line.pct1,
            pct2: line.pct2,
            pct3: line.pct3,
            pct4: line.pct4,
            assortment: line.assortment,
            offerEastSouth: line.offerEastSouth,
            offerEastSouthDate: line.offerEastSouthDate,
            offerEastSouthTime: line.offerEastSouthTime,
            offerEastNorth: line.offerEastNorth,
            offerEastNorthDate: line.offerEastNorthDate,
            offerEastNorthTime: line.offerEastNorthTime,
            offerWestSouth: line.offerWestSouth,
            offerWestSouthDate: line.offerWestSouthDate,
            offerWestSouthTime: line.offerWestSouthTime,
            offerWestNorth: line.offerWestNorth,
            offerWestNorthDate: line.offerWestNorthDate,
            offerWestNorthTime: line.offerWestNorthTime,
            leasedVessel: line.leasedVessel,
            economicZone: line.economicZone,
            municipality: line.municipality,
            coFisher: line.coFisher,
            buyer: line.buyer,
            receiver: line.receiver,
            nationality: line.nationality,
            rawRow: line.rawRow,
            sourceEventId: eventId,
            updatedAt: now,
          })),
        );
      }

      return true;
    });
  }

  async aggregateFishfactsCatches(
    filters: CatchFilters,
  ): Promise<FishfactsCatchResponse> {
    const conditions = aggregateConditions(filters);
    const rows = await execRows<AggregateRow>(
      this.db,
      sql`
        SELECT
          e.reported_date,
          l.species,
          SUM(COALESCE(l.weight_kg, l.tonnes * 1000, 0)) AS weight_kg
        FROM sildelaget_catch_entries e
        JOIN sildelaget_catch_lines l ON l.innmelding_id = e.innmelding_id
        ${whereClause(conditions)}
        GROUP BY e.reported_date, l.species
        ORDER BY e.reported_date DESC, l.species ASC
      `,
    );

    const days = new Map<string, DayCatchResponse>();
    for (const row of rows) {
      const weightKg = numberFromDb(row.weight_kg);
      const existing = days.get(row.reported_date) ?? {
        date: row.reported_date,
        totalFullWeightKg: 0,
        totalGuttedWeightKg: 0,
        totalWeightKg: 0,
        catches: [],
      };
      existing.catches.push({
        specie: row.species,
        fullWeightKg: weightKg,
        guttedWeightKg: 0,
        weightKg,
      });
      existing.totalFullWeightKg += weightKg;
      existing.totalWeightKg += weightKg;
      days.set(row.reported_date, existing);
    }

    return {
      code: 0,
      errors: [],
      message: "",
      data: {
        catches: Array.from(days.values()),
        locations: [],
      },
    };
  }

  async listFull(filters: FullCatchFilters): Promise<CatchFullPage> {
    const limit = clampLimit(filters.limit);
    const cursor = decodeCursor(filters.cursor);
    const conditions = fullEntryConditions(filters, cursor);
    const entryRows = await execRows<EntryDbRow>(
      this.db,
      sql`
        SELECT DISTINCT ${ENTRY_COLUMNS}
        FROM sildelaget_catch_entries e
        LEFT JOIN sildelaget_catch_lines l ON l.innmelding_id = e.innmelding_id
        ${whereClause(conditions)}
        ORDER BY e.reported_date DESC NULLS LAST, e.innmelding_id DESC
        LIMIT ${limit + 1}
      `,
    );
    const pageRows = entryRows.slice(0, limit);
    const nextRow = entryRows.length > limit ? pageRows.at(-1) : undefined;
    const linesByEntry = await this.loadLines(
      pageRows.map((row) => row.innmelding_id),
      filters.species,
    );
    return {
      rows: pageRows.map((row) => toEntryRecord(row, linesByEntry)),
      nextCursor: nextRow
        ? encodeCursor(nextRow.reported_date, nextRow.innmelding_id)
        : null,
    };
  }

  private async loadLines(
    innmeldingIds: string[],
    species?: string,
  ): Promise<Map<string, SildelagetCatchLineRecord[]>> {
    const byEntry = new Map<string, SildelagetCatchLineRecord[]>();
    if (innmeldingIds.length === 0) return byEntry;
    const conditions: SQL[] = [
      sql`l.innmelding_id IN (${sql.join(
        innmeldingIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    ];
    if (species) conditions.push(sql`l.species ILIKE ${species}`);
    const rows = await execRows<LineDbRow>(
      this.db,
      sql`
        SELECT ${LINE_COLUMNS}
        FROM sildelaget_catch_lines l
        ${whereClause(conditions)}
        ORDER BY l.innmelding_id, l.line_index ASC
      `,
    );
    for (const row of rows) {
      const line = toLineRecord(row);
      const lines = byEntry.get(line.innmeldingId) ?? [];
      lines.push(line);
      byEntry.set(line.innmeldingId, lines);
    }
    return byEntry;
  }
}

function aggregateConditions(filters: CatchFilters): SQL[] {
  return [
    sql`e.reported_date IS NOT NULL`,
    sql`l.species IS NOT NULL`,
    sql`e.reported_date >= ${filters.from}`,
    sql`e.reported_date <= ${filters.to}`,
    ...sharedFilterConditions(filters),
  ];
}

function fullEntryConditions(
  filters: FullCatchFilters,
  cursor: DecodedCursor | null,
): SQL[] {
  const conditions: SQL[] = [
    sql`e.reported_date IS NOT NULL`,
    sql`e.reported_date >= ${filters.from}`,
    sql`e.reported_date <= ${filters.to}`,
    ...sharedFilterConditions(filters),
  ];
  if (filters.innmeldingId) {
    conditions.push(sql`e.innmelding_id = ${filters.innmeldingId}`);
  }
  if (filters.q) {
    const q = `%${filters.q}%`;
    conditions.push(sql`(
      e.innmelding_id ILIKE ${q}
      OR e.vessel_name ILIKE ${q}
      OR e.registration_mark ILIKE ${q}
      OR l.species ILIKE ${q}
      OR l.buyer ILIKE ${q}
      OR l.receiver ILIKE ${q}
    )`);
  }
  if (cursor) {
    conditions.push(sql`(
      e.reported_date < ${cursor.reportedDate}
      OR (
        e.reported_date = ${cursor.reportedDate}
        AND e.innmelding_id < ${cursor.innmeldingId}
      )
    )`);
  }
  return conditions;
}

function sharedFilterConditions(filters: CatchFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.species) conditions.push(sql`l.species ILIKE ${filters.species}`);
  if (filters.vesselName) {
    conditions.push(sql`e.vessel_name ILIKE ${`%${filters.vesselName}%`}`);
  }
  if (filters.registrationMark) {
    conditions.push(
      sql`e.registration_mark ILIKE ${`%${filters.registrationMark}%`}`,
    );
  }
  return conditions;
}

function whereClause(conditions: SQL[]): SQL {
  if (conditions.length === 0) return sql``;
  let combined: SQL = conditions[0] as SQL;
  for (let i = 1; i < conditions.length; i++) {
    combined = sql`${combined} AND ${conditions[i]}`;
  }
  return sql`WHERE ${combined}`;
}

async function execRows<T extends Record<string, unknown>>(
  db: Database,
  query: SQL,
): Promise<T[]> {
  const result = await db.execute<T>(query);
  if (Array.isArray(result)) return result as T[];
  return ((result as unknown as { rows?: T[] }).rows ?? []) as T[];
}

function toEntryRecord(
  row: EntryDbRow,
  linesByEntry: Map<string, SildelagetCatchLineRecord[]>,
): SildelagetCatchEntryRecord {
  return {
    innmeldingId: row.innmelding_id,
    reportedDate: row.reported_date,
    reportedTime: row.reported_time,
    vesselName: row.vessel_name,
    registrationMark: row.registration_mark,
    entryHash: row.entry_hash,
    sourceUrl: row.source_url,
    checkedAt: dateToIso(row.checked_at),
    rawEntry: row.raw_entry ?? {},
    sourceEventId: row.source_event_id,
    createdAt: dateToIso(row.created_at),
    updatedAt: dateToIso(row.updated_at),
    lines: linesByEntry.get(row.innmelding_id) ?? [],
  };
}

function toLineRecord(row: LineDbRow): SildelagetCatchLineRecord {
  return {
    lineKey: row.line_key,
    innmeldingId: row.innmelding_id,
    lineIndex: row.line_index,
    fishingStartDate: row.fishing_start_date,
    fishingStartTime: row.fishing_start_time,
    species: row.species,
    tonnes: nullableNumberFromDb(row.tonnes),
    weightKg: nullableNumberFromDb(row.weight_kg),
    average: nullableNumberFromDb(row.average),
    catchType: row.catch_type,
    salesType: row.sales_type,
    gear: row.gear,
    route: row.route,
    use: row.use,
    pct1: nullableNumberFromDb(row.pct1),
    pct2: nullableNumberFromDb(row.pct2),
    pct3: nullableNumberFromDb(row.pct3),
    pct4: nullableNumberFromDb(row.pct4),
    assortment: row.assortment,
    offerEastSouth: row.offer_east_south,
    offerEastSouthDate: row.offer_east_south_date,
    offerEastSouthTime: row.offer_east_south_time,
    offerEastNorth: row.offer_east_north,
    offerEastNorthDate: row.offer_east_north_date,
    offerEastNorthTime: row.offer_east_north_time,
    offerWestSouth: row.offer_west_south,
    offerWestSouthDate: row.offer_west_south_date,
    offerWestSouthTime: row.offer_west_south_time,
    offerWestNorth: row.offer_west_north,
    offerWestNorthDate: row.offer_west_north_date,
    offerWestNorthTime: row.offer_west_north_time,
    leasedVessel: row.leased_vessel,
    economicZone: row.economic_zone,
    municipality: row.municipality,
    coFisher: row.co_fisher,
    buyer: row.buyer,
    receiver: row.receiver,
    nationality: row.nationality,
    rawRow: row.raw_row ?? {},
    sourceEventId: row.source_event_id,
    createdAt: dateToIso(row.created_at),
    updatedAt: dateToIso(row.updated_at),
  };
}

function dateToIso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function numberFromDb(value: number | string | null): number {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? (parsed as number) : 0;
}

function nullableNumberFromDb(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? (parsed as number) : null;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.floor(limit), 1), 200);
}

type DecodedCursor = {
  reportedDate: string;
  innmeldingId: string;
};

function encodeCursor(
  reportedDate: string | null,
  innmeldingId: string,
): string {
  return Buffer.from(
    JSON.stringify({ reportedDate: reportedDate ?? "", innmeldingId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<DecodedCursor>;
    if (
      typeof parsed.reportedDate !== "string" ||
      typeof parsed.innmeldingId !== "string"
    ) {
      return null;
    }
    return {
      reportedDate: parsed.reportedDate,
      innmeldingId: parsed.innmeldingId,
    };
  } catch {
    return null;
  }
}
