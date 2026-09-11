/**
 * PlatWatch daemon — the whole system in one process.
 *
 *   tsx scripts/daemon.ts
 *   tsx scripts/daemon.ts --port 8080 --poll 90
 *   tsx scripts/daemon.ts --no-watch      — scheduler + UI, no live sniper
 *   tsx scripts/daemon.ts --no-toast      — no Windows notifications
 *   tsx scripts/daemon.ts --log .cache/platwatch.log   — for running unattended
 *
 * Only one runs at a time. The UI port is the lock: binding it is atomic and
 * the OS releases it on crash or reboot, so there is no stale lock to clear.
 *
 * Why one process: the rate limiter is per-process. Running `serve`, `watch`
 * and `ingest` separately gives each its own 3 req/s budget and puts 9 req/s at
 * a small volunteer-run service. Here every job shares one limiter, and
 * PRIORITY keeps the live poll ahead of a 22-minute crawl.
 *
 * Set DISCORD_WEBHOOK_URL to push alerts to a phone.
 */
import { openDb, startSweep } from "../src/db/index";
import { rotatingWriter } from "../src/daemon/logfile";
import { applyRetention, RETENTION_DAYS } from "../src/db/retention";
import { PRIORITY } from "../src/wfm/limiter";
import { limiter } from "../src/wfm/http";
import { itemsToSweep, sweepTopOrders } from "../src/ingest/sweep";
import { ingestStats, statsCandidates } from "../src/ingest/stats";
import { refreshWatched } from "../src/ingest/watchlist";
import { ingestSetDetails, setRootsMissingParts } from "../src/ingest/details";
import { loadCatalog } from "../src/wfm/catalog";
import { upsertCatalog } from "../src/db/repo";
import { runScheduler, type Job } from "../src/daemon/scheduler";
import { createApp } from "../src/web/server";
import { watchedItems } from "../src/web/api";
import { latestSweepId } from "../src/rank/query";
import { watch } from "../src/live/watcher";
import { DEFAULT_ALERT_POLICY } from "../src/live/detect";
import { consoleSink, discordSink, fanOut, toastSink, type Sink } from "../src/live/notify";

const args = process.argv.slice(2);
const flag = (n: string): string | null => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (n: string) => args.includes(`--${n}`);

// ── unattended logging ──────────────────────────────────────────────────────
// Under Task Scheduler there is no console, so everything — log lines, alerts,
// uncaught errors — has to reach a file or it is simply lost.
const logFile = flag("log");
if (logFile) {
  // Rotates while running, not only at startup — see src/daemon/logfile.ts.
  const write = rotatingWriter(logFile);
  const toFile = (chunk: string | Uint8Array, encoding?: unknown, cb?: unknown): boolean => {
    write(chunk);
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  process.stdout.write = toFile as typeof process.stdout.write;
  process.stderr.write = toFile as typeof process.stderr.write;
  // A crash must leave its reason behind; exiting non-zero lets Task
  // Scheduler's restart-on-failure bring it back.
  process.on("uncaughtException", (err) => {
    write(`${new Date().toISOString()} FATAL ${err.stack ?? err}\n`);
    process.exit(1);
  });
  write(`\n──── ${new Date().toISOString()} PlatWatch starting (pid ${process.pid}) ────\n`);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const db = openDb();
const controller = new AbortController();
const port = Number(flag("port") ?? 5173);

const log = (scope: string, msg: string) =>
  console.log(`${new Date().toLocaleTimeString()} [${scope}] ${msg}`);

// ── jobs ────────────────────────────────────────────────────────────────────

const jobs: Job[] = [
  {
    name: "catalog",
    group: "bulk",
    everyMs: 24 * HOUR,
    async run(signal) {
      const { items, version, fromCache } = await loadCatalog(signal);
      upsertCatalog(db, items);
      log("catalog", `${items.length} items @ ${version}${fromCache ? " (cached)" : ""}`);
    },
  },
  {
    // New prime sets arrive with the catalogue but without their part lists,
    // and the daemon used to never fetch those — so a new set could never be
    // considered for set arbitrage. This only touches sets still missing
    // parts, so on a normal day it makes no requests at all.
    name: "details",
    group: "bulk",
    everyMs: 1 * HOUR,
    async run(signal) {
      const missing = setRootsMissingParts(db);
      if (missing.length === 0) return "idle";
      log("details", `${missing.length} set(s) missing their part list: ${missing.map((m) => m.slug).join(", ")}`);
      const result = await ingestSetDetails(db, undefined, signal, { onlyMissing: true });
      log(
        "details",
        `${result.sets} set(s), ${result.parts} part(s), ${result.failed} failed` +
          (result.multiQtyParts ? ` · ${result.multiQtyParts} need 2+ per set` : ""),
      );
    },
  },
  {
    name: "sweep",
    group: "bulk",
    everyMs: 6 * HOUR,
    async run(signal) {
      const items = itemsToSweep(db);
      log("sweep", `sweeping ${items.length} items (~22 min)`);
      // Resume a sweep the last run left unfinished rather than discarding
      // twenty minutes of work. sweepTopOrders skips items already recorded
      // under that id, so this costs only what is still missing.
      const open = db
        .prepare(
          `SELECT id FROM sweep
            WHERE kind = 'top' AND scope = 'full' AND finished_at IS NULL
              AND started_at > datetime('now', '-6 hours')
            ORDER BY id DESC LIMIT 1`,
        )
        .get() as { id: number } | undefined;
      const sweepId = open?.id ?? startSweep(db, "top");
      if (open) log("sweep", `resuming #${sweepId}`);

      const result = await sweepTopOrders(db, items, {
        sweepId,
        signal,
        priority: PRIORITY.bulk,
      });
      log(
        "sweep",
        `#${result.sweepId}: ${result.ok} ok, ${result.failed} failed, ` +
          `${(result.elapsedMs / 60000).toFixed(1)} min` +
          (result.interrupted ? " (interrupted)" : ""),
      );
    },
  },
  {
    name: "stats",
    group: "bulk",
    everyMs: 24 * HOUR,
    async run(signal) {
      const sweepId = latestSweepId(db);
      if (sweepId === null) {
        log("stats", "skipped — no completed sweep yet");
        return;
      }
      const candidates = statsCandidates(db, sweepId);
      log("stats", `fetching price history for ${candidates.length} items (~20 min)`);
      const result = await ingestStats(db, candidates, { signal });
      log("stats", `${result.ok} fetched, ${result.skipped} fresh, ${result.failed} failed`);
    },
  },
  {
    // Without this the database grew ~40 MB a day forever. See
    // src/db/retention.ts for exactly what is removed and what never is.
    name: "retention",
    group: "bulk",
    everyMs: 24 * HOUR,
    async run() {
      const r = applyRetention(db);
      if (r.orders === 0 && r.snapshots === 0) return "idle";
      log(
        "retention",
        `removed ${r.orders} orders that left the book over ${RETENTION_DAYS} days ago, ` +
          `${r.snapshots} old snapshot rows`,
      );
    },
  },
  {
    name: "watchlist",
    everyMs: 5 * MINUTE,
    runOnFirstStart: false,
    async run(signal) {
      const items = watchedItems(db);
      if (items.length === 0) return "idle";
      // Deliberately NOT a sweep — see src/ingest/watchlist.ts. It used to be
      // one, and it replaced the whole market with the handful of starred items.
      const result = await refreshWatched(db, items, { signal });
      log("watchlist", `refreshed ${result.ok} item(s), ${result.liveUpdates} live prices`);
    },
  },
];

// ── live sniper ─────────────────────────────────────────────────────────────

async function runWatcher(): Promise<void> {
  const sinks: Sink[] = [consoleSink];
  // Toasts are the channel that works unattended. Run from Task Scheduler the
  // console is a log file, so without this every alert went unseen.
  if (process.platform === "win32" && !has("no-toast")) {
    sinks.push(toastSink({ url: `http://127.0.0.1:${port}` }));
  }
  const webhook = process.env["DISCORD_WEBHOOK_URL"];
  if (webhook) sinks.push(discordSink(webhook));

  // Wait for a baseline before watching: with nothing to compare against, every
  // order looks unremarkable and the poll is wasted.
  while (!controller.signal.aborted && latestSweepId(db) === null) {
    log("watch", "waiting for the first sweep to finish…");
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (controller.signal.aborted) return;

  log(
    "watch",
    `live sniper on sweep #${latestSweepId(db)} · sinks: ${sinks.map((s) => s.name).join(", ")}`,
  );

  const stats = await watch(db, {
    // No fixed sweep id: the baseline follows each new sweep as it completes.
    onBaselineChange: (id) => log("watch", `baseline moved to sweep #${id}`),
    pollMs: Number(flag("poll") ?? 90) * 1000,
    policy: DEFAULT_ALERT_POLICY,
    signal: controller.signal,
    onAlert: fanOut(sinks),
    onPoll: (batch, running) => {
      if (batch.alerts > 0 || running.polls % 10 === 0) {
        log(
          "watch",
          `${batch.fresh} new of ${batch.total} · ${running.liveUpdates} live prices · ` +
            `${running.alerts} alerts total`,
        );
      }
    },
    onError: (err) => log("watch", `poll failed: ${err instanceof Error ? err.message : err}`),
  });
  log("watch", `stopped after ${stats.polls} polls, ${stats.alerts} alerts`);
}

// ── wire up ─────────────────────────────────────────────────────────────────

const server = createApp(db);
let scheduler: Promise<void> = Promise.resolve();
let watcher: Promise<void> = Promise.resolve();

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    // The port is the single-instance lock. This used to carry on without the
    // UI — which meant a second scheduler and a second sniper behind a second
    // rate limiter, doubling the load on warframe.market. That is the exact
    // thing this process exists to prevent, and a scheduled task starting one
    // at login makes a second instance likely. So: do nothing, and exit clean
    // (exit 0, so Task Scheduler does not treat it as a failure and retry).
    log("daemon", `port ${port} is in use — PlatWatch is already running, or another app holds it`);
    log("daemon", `not starting: a second daemon would double the load on warframe.market`);
    db.close();
    process.exit(0);
  }
  log("ui", `server error: ${err.message}`);
});

// Nothing talks to warframe.market until the lock is held.
server.listen(port, "127.0.0.1", () => {
  log("ui", `http://127.0.0.1:${port} (loopback only)`);

  scheduler = runScheduler(db, jobs, {
    signal: controller.signal,
    // No generic "started" line: jobs that do real work say so themselves, and
    // the ones that usually do nothing were most of the log.
    onFinish: (job, ms, idle) => {
      if (!idle) log("job", `${job} done in ${(ms / 1000).toFixed(1)}s`);
    },
    onError: (job, err) => log("job", `${job} FAILED: ${err instanceof Error ? err.message : err}`),
  });
  watcher = has("no-watch") ? Promise.resolve() : runWatcher();

  log(
    "daemon",
    `started · sweep 6h · stats daily · retention daily · details hourly · watchlist 5m`,
  );
  log("daemon", `one rate limiter at 3 req/s shared by every job`);
});

process.on("SIGINT", () => {
  console.log("\nstopping…");
  controller.abort();
  server.close();
  void Promise.allSettled([scheduler, watcher]).then(() => {
    log("daemon", `queue drained (${limiter.pending} pending)`);
    db.close();
    process.exit(0);
  });
});
