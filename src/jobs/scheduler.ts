import type { Env } from "@/env";
import type { JobRunner } from "./runner";

function parseField(field: string, min: number, max: number, value: number) {
  if (field === "*") return true;
  for (const segment of field.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    if (trimmed.includes("/")) {
      const [base, stepRaw] = trimmed.split("/");
      const step = Number(stepRaw);
      const [start, end] =
        base === "*"
          ? [min, max]
          : base.includes("-")
            ? base.split("-").map(Number)
            : [Number(base), Number(base)];
      if (value >= start && value <= end && (value - start) % step === 0) {
        return true;
      }
      continue;
    }
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map(Number);
      if (value >= start && value <= end) return true;
      continue;
    }
    if (Number(trimmed) === value) return true;
  }
  return false;
}

function cronMatches(schedule: string, now: Date) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule
    .trim()
    .split(/\s+/);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return false;
  return (
    parseField(minute, 0, 59, now.getUTCMinutes()) &&
    parseField(hour, 0, 23, now.getUTCHours()) &&
    parseField(dayOfMonth, 1, 31, now.getUTCDate()) &&
    parseField(month, 1, 12, now.getUTCMonth() + 1) &&
    parseField(dayOfWeek, 0, 6, now.getUTCDay())
  );
}

export class JobScheduler {
  private timer: Timer | null = null;
  private readonly lastFiredByJob = new Map<string, string>();

  constructor(
    private readonly env: Env,
    private readonly runner: JobRunner,
  ) {}

  start() {
    if (!this.env.JOB_SCHEDULER_ENABLED || this.timer) return;
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.env.JOB_SCHEDULER_TICK_MS,
    );
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    const now = new Date();
    const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
    for (const job of this.runner.definitions()) {
      if (!cronMatches(job.schedule, now)) continue;
      if (this.lastFiredByJob.get(job.id) === bucket) continue;
      this.lastFiredByJob.set(job.id, bucket);
      await this.runner
        .runJob(job.id, "cron", job.inputSchema.parse({}))
        .catch((error) => {
          console.error("[Jobs] Scheduled run failed", {
            jobId: job.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}
