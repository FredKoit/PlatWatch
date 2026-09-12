import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/index";
import { isDue, lastRun, markRun, runScheduler, schedulerHealth, type Job } from "./scheduler";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const HOUR = 3_600_000;

test("a job that has never run is due at startup", () => {
  assert.equal(isDue(null, 6 * HOUR, NOW), true);
});

test("a job can wait one interval before its first run", () => {
  const started = NOW;
  assert.equal(isDue(null, 5 * 60_000, started, false, started), false, "not at startup");
  assert.equal(
    isDue(null, 5 * 60_000, started + 5 * 60_000, false, started),
    true,
    "but once one interval has passed, it runs",
  );
});

test("regression: waiting for the first run is not the same as never running", () => {
  // The old check returned false whenever there was no last run. A job that
  // never runs never records one, so the watchlist refresh was never due —
  // from the day it was written. This test used to assert only the first half.
  const started = NOW;
  const muchLater = started + 30 * 24 * HOUR;
  assert.equal(isDue(null, 5 * 60_000, muchLater, false, started), true);
});

test("a job is not due again until its interval has passed", () => {
  const fiveHoursAgo = new Date(NOW - 5 * HOUR).toISOString();
  assert.equal(isDue(fiveHoursAgo, 6 * HOUR, NOW), false);

  const sevenHoursAgo = new Date(NOW - 7 * HOUR).toISOString();
  assert.equal(isDue(sevenHoursAgo, 6 * HOUR, NOW), true);
});

test("an unreadable timestamp is treated as due rather than never", () => {
  assert.equal(isDue("not a date", 6 * HOUR, NOW), true);
});

test("last-run survives a restart", () => {
  const db = openDb(":memory:");
  assert.equal(lastRun(db, "sweep"), null);
  markRun(db, "sweep", "2026-09-10T06:00:00Z");
  assert.equal(lastRun(db, "sweep"), "2026-09-10T06:00:00Z");
  // The point: a restart at 07:00 must not re-trigger a 22-minute crawl.
  assert.equal(isDue(lastRun(db, "sweep"), 6 * HOUR, Date.parse("2026-09-10T07:00:00Z")), false);
  db.close();
});

test("a due job runs, and is not launched again while still running", async () => {
  const db = openDb(":memory:");
  const controller = new AbortController();
  let starts = 0;
  let release: () => void = () => {};

  const job: Job = {
    name: "slow",
    everyMs: 1,
    run: () => {
      starts++;
      return new Promise<void>((r) => {
        release = r;
      });
    },
  };

  const loop = runScheduler(db, [job], { signal: controller.signal, tickMs: 5 });
  // Aborted in `finally`: a failed assertion must fail the test, not leave the
  // loop ticking and the whole suite hung.
  try {
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(starts, 1, "many ticks passed but the job is still running");
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(starts > 1, "once finished it becomes eligible again");
  } finally {
    controller.abort();
    await loop;
    db.close();
  }
});

test("a failing job backs off to its interval instead of retrying tightly", async () => {
  const db = openDb(":memory:");
  const controller = new AbortController();
  const errors: string[] = [];
  let runs = 0;

  const job: Job = {
    name: "broken",
    everyMs: HOUR,
    run: async () => {
      runs++;
      throw new Error("upstream is down");
    },
  };

  const loop = runScheduler(db, [job], {
    signal: controller.signal,
    tickMs: 5,
    onError: (name, err) => errors.push(`${name}:${(err as Error).message}`),
  });
  try {
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(runs, 1, "a failure must not become a hot loop");
    assert.deepEqual(errors, ["broken:upstream is down"]);
    assert.ok(lastRun(db, "broken"), "the attempt is stamped even though it failed");
  } finally {
    controller.abort();
    await loop;
    db.close();
  }
});

test("jobs in the same group never run together", async () => {
  const db = openDb(":memory:");
  const controller = new AbortController();
  const active = new Set<string>();
  let overlapped = false;

  const bulk = (name: string): Job => ({
    name,
    group: "bulk",
    everyMs: HOUR,
    run: async () => {
      active.add(name);
      if (active.size > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 30));
      active.delete(name);
    },
  });

  const loop = runScheduler(db, [bulk("sweep"), bulk("stats")], {
    signal: controller.signal,
    tickMs: 5,
  });
  try {
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(overlapped, false, "two long crawls must not halve each other's rate");
    assert.ok(lastRun(db, "sweep") && lastRun(db, "stats"), "both still ran, just in turn");
  } finally {
    controller.abort();
    await loop;
    db.close();
  }
});

test("independent jobs overlap rather than queueing behind each other", async () => {
  const db = openDb(":memory:");
  const controller = new AbortController();
  const active = new Set<string>();
  let sawBothAtOnce = false;

  const make = (name: string, ms: number): Job => ({
    name,
    everyMs: HOUR,
    run: async () => {
      active.add(name);
      if (active.size > 1) sawBothAtOnce = true;
      await new Promise((r) => setTimeout(r, ms));
      active.delete(name);
    },
  });

  const loop = runScheduler(db, [make("sweep", 60), make("watchlist", 20)], {
    signal: controller.signal,
    tickMs: 5,
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(sawBothAtOnce, "a short refresh must not wait out a long crawl");
  } finally {
    controller.abort();
    await loop;
    db.close();
  }
});

test("a job that waits for its first interval does eventually run", async () => {
  // The end-to-end version: through runScheduler, not just isDue.
  //
  // Real timers, so the margins are wide: this used to check at 15ms for a job
  // due at 40ms, and a busy machine firing the timer late made it fail — and a
  // failure skipped the abort, leaving the loop ticking and the suite hung.
  const db = openDb(":memory:");
  const controller = new AbortController();
  let runs = 0;
  const loop = runScheduler(
    db,
    [{ name: "watchlist", everyMs: 1_000, runOnFirstStart: false, run: async () => void runs++ }],
    { signal: controller.signal, tickMs: 5 },
  );
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runs, 0, "it waits at startup");

    await new Promise((r) => setTimeout(r, 1_100));
    assert.ok(runs >= 1, "and then it runs — the old scheduler never ran it at all");
  } finally {
    controller.abort();
    await loop;
    db.close();
  }
});

test("a job can ask to run again sooner than its interval", async () => {
  // A sweep cut short by an outage resumes when the market is back, not six
  // hours later — by resolving { retryInMs }.
  const db = openDb(":memory:");
  const controller = new AbortController();
  let runs = 0;
  const loop = runScheduler(
    db,
    [{ name: "sweep", everyMs: HOUR, run: async () => (++runs === 1 ? { retryInMs: 20 } : undefined) }],
    { signal: controller.signal, tickMs: 5 },
  );
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs, 2, "retried once, soon; then back on the hourly interval");
  } finally {
    controller.abort();
    await loop;
    db.close();
  }
});

test("failures record health and retry sooner with bounded backoff", async () => {
  const db = openDb(":memory:");
  const controller = new AbortController();
  let runs = 0;
  const loop = runScheduler(db, [{
    name: "recovering", everyMs: HOUR, errorRetryMs: 20,
    run: async () => { runs++; throw new Error("temporary outage"); },
  }], { signal: controller.signal, tickMs: 5 });
  try {
    await new Promise((r) => setTimeout(r, 90));
    assert.ok(runs >= 2 && runs <= 4, `bounded retries, got ${runs}`);
    const health = schedulerHealth(db).find((j) => j.name === "recovering")!;
    assert.equal(health.lastSuccess, null);
    assert.equal(health.lastError, "temporary outage");
    assert.equal(health.consecutiveFailures, runs);
  } finally { controller.abort(); await loop; db.close(); }
});
