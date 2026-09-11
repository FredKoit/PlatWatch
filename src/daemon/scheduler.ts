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
  run(signal: AbortSignal): Promise<void>;
}

const key = (name: string) => `job:${name}:lastRun`;

export function lastRun(db: Db, name: string): string | null {
  return getMeta(db, key(name));
}

export function markRun(db: Db, name: string, at = new Date().toISOString()): void {
  setMeta(db, key(name), at);
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
  onFinish?: (job: string, ms: number) => void;
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
    opts.onStart?.(job.name);
    void job
      .run(opts.signal)
      .then(() => {
        // Stamped on completion, so a job that takes longer than its interval
        // does not immediately become due again.
        markRun(db, job.name);
        opts.onFinish?.(job.name, Date.now() - started);
      })
      .catch((err: unknown) => {
        // Still stamped: a failing job must back off to its interval rather
        // than retry in a tight loop against a service that is already unhappy.
        markRun(db, job.name);
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
      const t = setTimeout(resolve, tickMs);
      opts.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}
