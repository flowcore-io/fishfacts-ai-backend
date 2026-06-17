import type { Env } from "@/env";
import type { RowDataPacket } from "mysql2";
import type { Pool } from "mysql2/promise";
import { getAisPool } from "./mysql-pool";
import type {
  AisBucketKeyset,
  AisFix,
  AisSource,
  AisTailCursor,
} from "./types";

const HOUR_MS = 3_600_000;

type LocationRow = RowDataPacket & {
  id: number;
  vessel_id: number;
  source_id: number | null;
  latitude: string | null;
  longitude: string | null;
  speed: string | null;
  heading: string | null;
  course: string | null;
  status: string | null;
  timestamp: string | null;
  stamp_created: string | null;
};

const SELECT_COLS =
  "id, vessel_id, source_id, latitude, longitude, speed, heading, course, status, timestamp, stamp_created";

export class MysqlAisSource implements AisSource {
  constructor(private readonly env: Env) {}

  private pool(): Promise<Pool> {
    return getAisPool(this.env);
  }

  async fetchFixesAfterIngest(
    cursor: AisTailCursor,
    limit: number,
  ): Promise<AisFix[]> {
    const pool = await this.pool();
    const s = isoToMysql(cursor.stampCreated);
    const [rows] = await pool.query<LocationRow[]>(
      `SELECT ${SELECT_COLS} FROM location
       WHERE stamp_created > ? OR (stamp_created = ? AND id > ?)
       ORDER BY stamp_created, id
       LIMIT ?`,
      [s, s, cursor.lastId, limit],
    );
    return rows.map(toFix);
  }

  async streamBucket(
    bucketStart: string,
    after: AisBucketKeyset | null,
    limit: number,
  ): Promise<AisFix[]> {
    const pool = await this.pool();
    const start = isoToMysql(bucketStart);
    const end = isoToMysql(bucketEnd(bucketStart));
    if (after) {
      const a = isoToMysql(after.ts);
      const [rows] = await pool.query<LocationRow[]>(
        `SELECT ${SELECT_COLS} FROM location
         WHERE timestamp >= ? AND timestamp < ?
           AND (timestamp > ? OR (timestamp = ? AND id > ?))
         ORDER BY timestamp, id
         LIMIT ?`,
        [start, end, a, a, after.id, limit],
      );
      return rows.map(toFix);
    }
    const [rows] = await pool.query<LocationRow[]>(
      `SELECT ${SELECT_COLS} FROM location
       WHERE timestamp >= ? AND timestamp < ?
       ORDER BY timestamp, id
       LIMIT ?`,
      [start, end, limit],
    );
    return rows.map(toFix);
  }

  async countBucket(bucketStart: string): Promise<number> {
    const pool = await this.pool();
    const [rows] = await pool.query<(RowDataPacket & { c: number })[]>(
      "SELECT COUNT(*) AS c FROM location WHERE timestamp >= ? AND timestamp < ?",
      [isoToMysql(bucketStart), isoToMysql(bucketEnd(bucketStart))],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async minEventTime(): Promise<string | null> {
    const pool = await this.pool();
    const [rows] = await pool.query<(RowDataPacket & { m: string | null })[]>(
      "SELECT MIN(timestamp) AS m FROM location",
    );
    const m = rows[0]?.m;
    return m ? mysqlToIso(m) : null;
  }

  async close(): Promise<void> {
    // Pool/connector lifecycle is shared and owned by mysql-pool's closeAisPool().
  }
}

function toFix(row: LocationRow): AisFix {
  return {
    sourceId: Number(row.id),
    vesselId: Number(row.vessel_id),
    vesselSourceId: row.source_id === null ? null : Number(row.source_id),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    speed: nnum(row.speed),
    heading: nnum(row.heading),
    course: nnum(row.course),
    status: row.status,
    eventTime: row.timestamp
      ? mysqlToIso(row.timestamp)
      : row.stamp_created
        ? mysqlToIso(row.stamp_created)
        : new Date(0).toISOString(),
    ingestTime: row.stamp_created
      ? mysqlToIso(row.stamp_created)
      : new Date(0).toISOString(),
  };
}

function num(value: string | null): number {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nnum(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) → ISO 'YYYY-MM-DDTHH:MM:SS.000Z'. */
function mysqlToIso(value: string): string {
  return `${value.replace(" ", "T")}.000Z`;
}

/** ISO → 'YYYY-MM-DD HH:MM:SS' (UTC) for binding into queries. */
function isoToMysql(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

function bucketEnd(bucketStart: string): string {
  return new Date(new Date(bucketStart).getTime() + HOUR_MS).toISOString();
}
