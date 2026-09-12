import type { Db } from "../db/index";
import { getMeta, setMeta } from "../db/index";

/**
 * A minimal persistent scheduler.
 *
 * Last-run times live in `meta`, so restarting the daemon does not re-trigger
 * every job — which matters when one of them is a 22-minute crawl.
 */

export interface Job {
  name: string;
  everyMs: number;
  /** Run at startup if it has never run before. */
  runOnFirstStart?: boolean;
  /**
   * Jobs sharing a group never run at the same time. Defaults to the job's own
   * name, which gives self-exclusion only.
   *
   * Two twenty-minute crawls interleaving at 1.5 req/s each finish later than
   * the same two run back to back, and neither is usable meanwhile. Grouping
   * them serialises the bulk work while leaving short, high-priority jobs free.
   */
  group?: string;
  /**
   * Resolve "idle" when there was nothing to do. The watchlist runs every five
   * minutes and the part-list check hourly, and both usually have nothing to
   * do; logging "started / done in 0.0s" for each was most of the log.
   *
   * Resolve `{ retryInMs }` to run again sooner than `everyMs` — a sweep cut
   * short by an outage should resume when the market is back, not six hours on.
   */
  run(signal: AbortSignal): Promise<void | "idle" | { retryInMs: number }>;
  /** Retry delay after an exception; defaults to min(5 minutes, normal interval). */
  errorRetryMs?: number;
}

const key = (name: string) => `job:${name}:lastRun`;
const stateKey = (name: string, field: string) => `job:${name}:${field}`;

export function lastRun(db: Db, name: string): string | null {
  return getMeta(db, key(name));
}

export function markRun(db: Db, name: string, at = new Date().toISOString()): void {
  setMeta(db, key(name), at);
}

export interface JobHealth {
  name: string;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export function schedulerHealth(db: Db): JobHealth[] {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'job:%'").all() as Array<{key:string;value:string}>;
  const jobs = new Map<string, JobHealth>();
  for (const row of rows) {
    const match = /^job:(.+):(lastAttempt|lastSuccess|lastError|failures)$/.exec(row.key);
    if (!match) continue;
    const health = jobs.get(match[1]!) ?? { name: match[1]!, lastAttempt:null, lastSuccess:null, lastError:null, consecutiveFailures:0 };
    if (match[2] === "lastAttempt") health.lastAttempt = row.value || null;
    if (match[2] === "lastSuccess") health.lastSuccess = row.value || null;
    if (match[2] === "lastError") health.lastError = row.value || null;
    if (match[2] === "failures") health.consecutiveFailures = Number(row.value) || 0;
    jobs.set(health.name, health);
  }
  return [...jobs.values()].sort((a,b) => a.name.localeCompare(b.name));
}

/**
 * Whether a job should run now.
 *
 * `runOnFirstStart: false` means "wait one interval before the first run" —
 * NOT "never run". It used to return false whenever there was no last run, and
 * since a job that never runs never records one, such a job was never due. The
 * watchlist refresh sat in that state from the day it was written: starred
 * items were never refreshed, silently. With no last run, the interval is now
 * counted from when the scheduler started instead.
 */
export function isDue(
  last: string | null,
  everyMs: number,
  now: number,
  runOnFirstStart = true,
  startedAt = now,
): boolean {
  if (last === null) return runOnFirstStart || now - startedAt >= everyMs;
  const at = Date.parse(last);
  if (Number.isNaN(at)) return true;
  return now - at >= everyMs;
}

export interface SchedulerOptions {
  signal: AbortSignal;
  /** How often to re-check what is due. */
  tickMs?: number;
  onStart?: (job: string) => void;
  onFinish?: (job: string, ms: number, idle: boolean) => void;
  onError?: (job: string, err: unknown) => void;
}

/**
 * Run jobs on their schedules until aborted.
 *
 * Jobs may overlap each other — a five-minute watchlist refresh must not wait
 * out a sweep — but never themselves. Fairness between overlapping jobs is the
 * rate limiter's business, via PRIORITY, not the scheduler's.
 */
export async function runScheduler(db: Db, jobs: Job[], opts: SchedulerOptions): Promise<void> {
  const tickMs = opts.tickMs ?? 30_000;
  // The reference point for jobs that wait one interval before their first run.
  const startedAt = Date.now();
  const running = new Set<string>();
  const groupOf = (job: Job) => job.group ?? job.name;

  const launch = (job: Job) => {
    running.add(groupOf(job));
    const started = Date.now();
    setMeta(db, stateKey(job.name, "lastAttempt"), new Date(started).toISOString());
    opts.onStart?.(job.name);
    void job
      .run(opts.signal)
      .then((result) => {
        // Stamped on completion, so a job that takes longer than its interval
        // does not immediately become due again. A retry is stamped as if the
        // job had last run `everyMs - retryInMs` ago, so it falls due after
        // `retryInMs` through the same check as every other run.
        const retry = typeof result === "object" && result ? result.retryInMs : null;
        markRun(
          db,
          job.name,
          retry !== null
            ? new Date(Date.now() - job.everyMs + Math.max(0, retry)).toISOString()
            : undefined,
        );
        setMeta(db, stateKey(job.name, "lastSuccess"), new Date().toISOString());
        setMeta(db, stateKey(job.name, "lastError"), "");
        setMeta(db, stateKey(job.name, "failures"), "0");
        opts.onFinish?.(job.name, Date.now() - started, result === "idle");
      })
      .catch((err: unknown) => {
        const failures = Number(getMeta(db, stateKey(job.name, "failures")) ?? 0) + 1;
        const base = Math.max(1, job.errorRetryMs ?? Math.min(5 * 60_000, job.everyMs));
        const retryIn = Math.min(job.everyMs, base * 2 ** Math.min(failures - 1, 5));
        markRun(db, job.name, new Date(Date.now() - job.everyMs + retryIn).toISOString());
        setMeta(db, stateKey(job.name, "lastError"), err instanceof Error ? err.message : String(err));
        setMeta(db, stateKey(job.name, "failures"), String(failures));
        opts.onError?.(job.name, err);
      })
      .finally(() => running.delete(groupOf(job)));
  };

  while (!opts.signal.aborted) {
    const now = Date.now();
    for (const job of jobs) {
      if (running.has(groupOf(job))) continue;
      if (isDue(lastRun(db, job.name), job.everyMs, now, job.runOnFirstStart ?? true, startedAt)) {
        launch(job);
      }
    }

    await new Promise<void>((resolve) => {
      const onAbort = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => {
        opts.signal.removeEventListener("abort", onAbort);
        resolve();
      }, tickMs);
      opts.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
