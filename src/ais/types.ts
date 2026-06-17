/**
 * Source-agnostic AIS types. The MySQL replica is one implementation of
 * `AisSource`; a future Kafka stream is another. Everything downstream (event
 * contract, writer, pathway, ClickHouse projector) only ever sees `AisFix`, so
 * swapping the source touches nothing but `src/ais/*-source.ts`.
 */

/** A normalized vessel position fix (one row of `location`). */
export type AisFix = {
  /** location.id — idempotency key (ClickHouse ReplacingMergeTree sort key). */
  sourceId: number;
  vesselId: number;
  /** location.source_id (AIS feed source), nullable. */
  vesselSourceId: number | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  course: number | null;
  status: string | null;
  /** ISO UTC from location.timestamp — AIS event time (backdatable). */
  eventTime: string;
  /** ISO UTC from location.stamp_created — ingest time (monotonic). */
  ingestTime: string;
};

/** Tail cursor: keyset on (stamp_created, id). */
export type AisTailCursor = { stampCreated: string; lastId: number };

/** Within-bucket keyset for backfill: (timestamp, id). */
export type AisBucketKeyset = { ts: string; id: number };

export interface AisSource {
  /**
   * Tail: rows strictly after the keyset cursor, ascending by (stamp_created, id).
   * Pure keyset pagination — lookback/seeding handled by the caller.
   */
  fetchFixesAfterIngest(
    cursor: AisTailCursor,
    limit: number,
  ): Promise<AisFix[]>;

  /**
   * Backfill: rows within [bucketStart, bucketStart+1h), ascending by
   * (timestamp, id), strictly after `after` when provided. ONE linear stream
   * per bucket (see plan constraint #1).
   */
  streamBucket(
    bucketStart: string,
    after: AisBucketKeyset | null,
    limit: number,
  ): Promise<AisFix[]>;

  /** Source row count for the hour bucket [bucketStart, bucketStart+1h). */
  countBucket(bucketStart: string): Promise<number>;

  /** Earliest `timestamp` in the source, ISO UTC (null if empty). */
  minEventTime(): Promise<string | null>;

  close(): Promise<void>;
}
