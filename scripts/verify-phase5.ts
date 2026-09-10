/**
 * Phase 5 acceptance gate.
 *
 * Done when: an alert reaches you carrying a whisper you can paste into the
 * game. The rest of these checks exist because the first live run fired
 * nonsense — "1250% profit" alerts produced by comparing a rank-0 ask against a
 * rank-10 bid. They guard that specific regression.
 */
import { openDb } from "../src/db/index";
import { latestSweepId } from "../src/rank/query";
import { loadBaselines } from "../src/live/watcher";
import { whisperFor } from "../src/live/detect";

const db = openDb();
const sweepId = latestSweepId(db);
if (sweepId === null) {
  console.error("no finished sweep");
  process.exit(1);
}

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(46)} ${detail}`);
  if (!ok) failures++;
};

console.log("── baselines ────────────────────────────────────────────────────────");
const baselines = loadBaselines(db, sweepId);
check("baselines loaded", baselines.size > 3000, `${baselines.size} item/variant markets`);

const variantMarkets = [...baselines.values()].filter((b) => b.variant !== "").length;
check("variant markets priced separately", variantMarkets > 1000, `${variantMarkets} variant rows`);

const pricedByHistory = [...baselines.values()].filter(
  (b) => b.fairValue === null && b.median7d !== null,
).length;
console.log(`        ${pricedByHistory} priced only by completed trades (bid-only variants)`);

console.log("\n── alerts fired ─────────────────────────────────────────────────────");
const alerts = db
  .prepare("SELECT * FROM alert ORDER BY fired_at DESC")
  .all() as Array<Record<string, unknown>>;
check("alerts recorded", alerts.length > 0, `${alerts.length} in the log`);

// The regression this guards is comparing two DIFFERENT goods — a rank-0 ask
// against a rank-10 bid. Margin size is the wrong proxy for it: a genuinely
// generous bid (someone offering 28p for a relic that trades at 5p) produces a
// large margin and is exactly what this tool exists to find.
//
// The real invariant is that the price we judged against was credible FOR THAT
// VARIANT. So: every alert's reference must sit within a sane band of what that
// variant actually trades at — or the alert must admit it did not, by carrying
// the suspicious flag.
const withMedian = db
  .prepare(
    `SELECT a.id, a.kind, a.reference, a.profit, a.suspicious, ss.median_7d
       FROM alert a
       LEFT JOIN stat_summary ss
         ON ss.item_id = a.item_id AND ss.variant = a.variant
      WHERE ss.median_7d IS NOT NULL`,
  )
  .all() as Array<{ reference: number; suspicious: number; median_7d: number }>;

const incredible = withMedian.filter(
  (a) => !a.suspicious && (a.reference < a.median_7d * 0.3 || a.reference > a.median_7d * 3),
);
check(
  "every reference price is credible for its variant",
  incredible.length === 0,
  `${incredible.length} priced off a market they do not belong to`,
);
console.log(`        ${withMedian.length} of ${alerts.length} alerts checkable against a traded median`);

const flagged = alerts.filter((a) => Number(a["suspicious"])).length;
console.log(`        ${flagged} flagged suspicious (reported, not trusted)`);

// The original structural check, now stated directly rather than by proxy.
const orphanVariant = db
  .prepare(
    `SELECT COUNT(*) c FROM alert a
      WHERE NOT EXISTS (
        SELECT 1 FROM snapshot s
         WHERE s.item_id = a.item_id AND s.variant = a.variant
      )`,
  )
  .get() as { c: number };
check(
  "no alert references a variant with no market",
  orphanVariant.c === 0,
  `${orphanVariant.c} orphaned`,
);

const noVolume = alerts.filter((a) => Number(a["volume_48h"] ?? 0) < 6);
check("every alert cleared the volume floor", noVolume.length === 0, `${noVolume.length} violations`);

const unreachable = alerts.filter(
  (a) => a["user_status"] !== "ingame" && a["user_status"] !== "online",
);
check("every alert is on a reachable player", unreachable.length === 0, `${unreachable.length} offline`);

const stale = alerts.filter((a) => Number(a["baseline_age_h"] ?? 0) > 36);
check("no alert used a stale baseline", stale.length === 0, `${stale.length} violations`);

console.log("\n── whisper strings ──────────────────────────────────────────────────");
const sample = alerts[0];
if (sample) {
  const side = sample["kind"] === "underpriced_sell" ? "buy" : "sell";
  const item = db
    .prepare("SELECT name FROM item WHERE id = ?")
    .get(sample["item_id"]) as { name: string };
  const whisper = whisperFor(
    String(sample["ingame_name"]),
    item.name,
    Number(sample["platinum"]),
    side,
  );
  check("whisper is pasteable", whisper.startsWith("/w ") && whisper.includes("(warframe.market)"), "");
  console.log(`        ${whisper}`);
}

console.log("\n── most recent alerts ───────────────────────────────────────────────");
for (const a of alerts.slice(0, 8)) {
  const item = db.prepare("SELECT name FROM item WHERE id = ?").get(a["item_id"]) as { name: string };
  console.log(
    `  ${String(a["kind"]).padEnd(17)} ${item.name.slice(0, 28).padEnd(28)} ` +
      `${String(a["platinum"]).padStart(5)}p vs ${String(a["reference"]).padStart(5)}p ` +
      `= +${String(a["profit"]).padStart(4)}p · vol ${a["volume_48h"]}`,
  );
}

console.log("\n─────────────────────────────────────────────────────────────────────");
if (failures === 0) console.log("PASS — alerts are variant-correct and actionable");
else {
  console.log(`FAIL — ${failures} check(s)`);
  process.exitCode = 1;
}
db.close();
