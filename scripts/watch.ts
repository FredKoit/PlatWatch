/**
 * Live sniper.
 *
 *   tsx scripts/watch.ts                    — poll and alert until Ctrl-C
 *   tsx scripts/watch.ts --poll 60          — seconds between polls
 *   tsx scripts/watch.ts --once             — a single poll, then exit
 *   tsx scripts/watch.ts --min-profit 20
 *
 * Set DISCORD_WEBHOOK_URL to also push alerts to Discord.
 */
import { openDb } from "../src/db/index";
import { latestSweepId } from "../src/rank/query";
import { DEFAULT_ALERT_POLICY } from "../src/live/detect";
import { consoleSink, discordSink, fanOut, type Sink } from "../src/live/notify";
import { watch } from "../src/live/watcher";
import { requireLock } from "../src/daemon/lock";

// Refuse to run beside the daemon, which already runs this same sniper.
const lock = await requireLock("watch");

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(`--${name}`);

const db = openDb();
const sweepId = latestSweepId(db);
if (sweepId === null) {
  console.error("no finished sweep — the watcher needs a baseline to compare against.");
  console.error("run: tsx scripts/ingest.ts sweep && tsx scripts/ingest.ts stats");
  process.exit(1);
}

const policy = { ...DEFAULT_ALERT_POLICY };
const minProfit = flag("min-profit");
if (minProfit) policy.minProfit = Number(minProfit);

const sinks: Sink[] = [consoleSink];
const webhook = process.env["DISCORD_WEBHOOK_URL"];
if (webhook) sinks.push(discordSink(webhook));

const controller = new AbortController();
process.on("SIGINT", () => {
  console.log("\nstopping…");
  controller.abort();
});

const pollMs = Number(flag("poll") ?? 90) * 1000;

const baselineAge = (() => {
  const row = db
    .prepare("SELECT finished_at FROM sweep WHERE id = ?")
    .get(sweepId) as { finished_at: string };
  return (Date.now() - Date.parse(row.finished_at)) / 3_600_000;
})();

console.log(
  `watching /v2/orders/recent every ${pollMs / 1000}s · baseline sweep #${sweepId} ` +
    `(${baselineAge.toFixed(1)}h old) · sinks: ${sinks.map((s) => s.name).join(", ")}`,
);
console.log(
  `alerting on sells ≤${Math.round(policy.sellDiscount * 100)}% of median or ` +
    `buys ≥${Math.round(policy.buyPremium * 100)}% of ask, ` +
    `profit ≥${policy.minProfit}p, volume ≥${policy.minVolume48h}/48h\n`,
);
if (baselineAge > 24) {
  console.log(`  ! baseline is ${baselineAge.toFixed(0)}h old — re-run the sweep for current prices\n`);
}

const stats = await watch(db, {
  onBaselineChange: (id) => console.log(`  baseline moved to sweep #${id}`),
  pollMs,
  policy,
  signal: controller.signal,
  onAlert: fanOut(sinks),
  onPoll: (batch, running) => {
    const stamp = new Date().toLocaleTimeString();
    console.log(
      `[${stamp}] ${batch.total} in window, ${batch.fresh} new, ` +
        `${batch.alerts} alert(s) · totals: ${running.newOrders} orders, ${running.alerts} alerts`,
    );
    if (has("once")) controller.abort();
  },
  onError: (err) => {
    console.error(`  poll failed: ${err instanceof Error ? err.message : String(err)}`);
  },
});

console.log(
  `\n${stats.polls} polls · ${stats.ordersSeen} orders seen · ${stats.newOrders} new · ` +
    `${stats.alerts} alerts · ${stats.errors} errors`,
);
db.close();
// The lock is a listening server, which keeps the process alive until closed.
await lock.release();
