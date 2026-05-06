import type { z } from "zod";

export type JobRunStatus =
  | "idle"
  | "running"
  | "success"
  | "error"
  | "cancelled";

export type JobLatestItem = {
  signature: string;
  title: string;
  url: string;
  status: "current" | "archived" | "unknown";
  publishedAt?: string;
  createdAt?: string;
  jmNumber?: string;
  validFrom?: string;
  validTo?: string;
  category?: string;
  bodyMarkdown?: string;
  contentHash?: string;
  lastCheckedAt?: string;
};

export type JobState = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunStatus: JobRunStatus;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastCheckedAt?: string;
  lastDurationMs?: number;
  listingFingerprint?: string;
  cursor?: {
    mode: "announcement";
    lastProcessedUrl?: string;
    processedCount?: number;
    totalCount?: number;
    updatedAt: string;
  };
  latestItems: JobLatestItem[];
  progress?: {
    phase: string;
    message?: string;
    percent?: number;
    pagesProcessed?: number;
    pagesTotal?: number;
    itemsDiscovered?: number;
    knownItems?: number;
    skippedExisting?: number;
    detailsProcessed?: number;
    detailsTotal?: number;
    updatedAt: string;
  };
  metrics: {
    runs: number;
    successes: number;
    failures: number;
    newDataEvents: number;
  };
};

export type JobRunRecord = {
  runId: string;
  jobId: string;
  startedAt: string;
  finishedAt?: string;
  status: JobRunStatus;
  trigger: "manual" | "cron";
  args?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  changed?: boolean;
};

export type PersistedJobState = {
  schemaVersion: 1;
  updatedAt: string;
  job: JobState;
  runs: JobRunRecord[];
};

export type JobExecutionResult = {
  checkedAt: string;
  changed: boolean;
  latestItems: JobLatestItem[];
  message: string;
};

export type JobDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny> = {
  id: string;
  name: string;
  schedule: string;
  inputSchema: TArgs;
  execute: (
    previous: JobState | undefined,
    args: z.infer<TArgs>,
    context: {
      signal: AbortSignal;
      isStopRequested: () => boolean;
      reportProgress: (
        progress: Partial<NonNullable<JobState["progress"]>>,
      ) => void;
      checkpoint?: (
        update: (state: PersistedJobState) => void,
      ) => Promise<void>;
    },
  ) => Promise<JobExecutionResult>;
};
