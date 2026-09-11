/**
 * Phase 3 acceptance gate.
 *
 * The gate written in the original plan — "ranking puts Rhino Prime above
 * Dual Kamas" — does not survive contact with the data, and is NOT used here.
 * It conflated two different trades: Rhino's 27p was a set-arbitrage edge while
 * Dual Kamas' 38p was a bid/ask spread, and Dual Kamas turns out to be
 * reasonably liquid (~21 trades/48h), so ranking it below Rhino would be wrong.
 *
 * What actually matters is that the fat spreads which are genuinely untradable
 * — dead collector items with books weeks old — never reach the list, and that
 * set edges are computed with component quantities. That is what is checked.
 */
import { openDb } from "../src/db/index";
import { latestSweepId, setRows, spreadRows } from "../src/rank/query";
import { DEFAULT_POLICY, rank, scoreSet, scoreSpread, type Opportunity } from "../src/rank/score";

const db = openDb();
const sweepId = latestSweepId(db);
if (sweepId === null) {
  console.error("no finished sweep — run: tsx scripts/ingest.ts sweep");
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(48)} ${detail}`);
  if (!ok) failures++;
}

const spreads = spreadRows(db, sweepId).map((r) => scoreSpread(r));
const setInputs = setRows(db, sweepId);
const sets = setInputs.map((s) => scoreSet(s));
const all = [...spreads, ...sets].filter((o): o is Opportunity => o !== null);
const ranked = rank(all);
const bySlug = new Map(all.map((o) => [`${o.kind}:${o.slug}`, o]));
const rankedSlugs = new Set(ranked.map((o) => `${o.kind}:${o.slug}`));

console.log("── coverage ─────────────────────────────────────────────────────────────");
check("opportunities evaluated", all.length > 500, `${all.length} evaluated`);
check("ranking is non-empty", ranked.length > 0, `${ranked.length} tradable`);
console.log(`        ${all.length - ranked.length} held back by policy`);

console.log("\n── every ranked entry satisfies the policy ──────────────────────────────");
const belowVolume = ranked.filter((o) => o.volume48h < DEFAULT_POLICY.minVolume48h);
check("none below the volume floor", belowVolume.length === 0, `${belowVolume.length} violations`);

const staleBook = ranked.filter(
  (o) => o.bookAgeH !== null && o.bookAgeH > DEFAULT_POLICY.maxBookAgeHours,
);
check("no stale order books", staleBook.length === 0, `${staleBook.length} violations`);

const thin = ranked.filter((o) => o.margin < DEFAULT_POLICY.minMarginPlat);
check("no sub-threshold margins", thin.length === 0, `${thin.length} violations`);

const negative = ranked.filter((o) => o.margin <= 0);
check("no negative-edge trades", negative.length === 0, `${negative.length} violations`);

const undersupported = ranked.filter((o) => o.sellCount < DEFAULT_POLICY.minSellOrders);
check("every price corroborated by 3+ asks", undersupported.length === 0, `${undersupported.length} violations`);

console.log("\n── known traps must not appear ──────────────────────────────────────────");
// Illiquid collector items whose spreads are enormous and whose books are dead.
for (const slug of ["corpus_void_key", "arcane_squall_helmet", "arcane_pendragon_helmet"]) {
  const o = bySlug.get(`spread:${slug}`);
  if (!o) {
    console.log(`  --    ${slug.padEnd(48)} not in this sweep`);
    continue;
  }
  check(
    `${slug} excluded`,
    !rankedSlugs.has(`spread:${slug}`),
    `${o.margin}p margin · ${o.rejects.join("; ") || "NOT REJECTED"}`,
  );
}

console.log("\n── set arbitrage uses component quantities ──────────────────────────────");
// This used to assert Dual Kamas cost more than 80p and was unprofitable. Both
// were facts about one day's market, not about the code: when blade and handle
// prices fell the cost landed on exactly 80p and the gate failed with nothing
// broken. The invariant is that EVERY set is costed at Σ(part × quantity), so
// check that directly, across all of them.
let costed = 0;
let wrongCost = 0;
let multiQtySets = 0;
let flatWouldDiffer = 0;
for (const input of setInputs) {
  const scored = scoreSet(input);
  if (!scored || input.parts.some((p) => p.lowSell === null)) continue; // edge unknown
  costed++;
  const weighted = input.parts.reduce((n, p) => n + p.lowSell! * p.qty, 0);
  const flat = input.parts.reduce((n, p) => n + p.lowSell!, 0);
  if (scored.buyAt !== weighted) wrongCost++;
  if (input.parts.some((p) => p.qty > 1)) {
    multiQtySets++;
    if (weighted !== flat) flatWouldDiffer++;
  }
}
check("every set costed at part price × quantity", wrongCost === 0, `${wrongCost} of ${costed} wrong`);
check(
  "quantities actually change the answer",
  multiQtySets > 0 && flatWouldDiffer > 0,
  `${multiQtySets} sets need 2+ of a part; a flat sum would misprice ${flatWouldDiffer}`,
);

const dk = bySlug.get("set:dual_kamas_prime_set");
if (dk) console.log(`        e.g. Dual Kamas: parts ${dk.buyAt}p, edge ${dk.margin}p today`);

console.log("\n── sets are sold where sets trade ───────────────────────────────────────");
// Pricing the set at its ask put Aeolak on top at +183p: 64p of parts against a
// 248p ask, for a set that trades at 77p. Whatever the day's asks, no set may be
// planned to sell above its traded median.
let aboveTraded = 0;
let capped = 0;
for (const input of setInputs) {
  const scored = scoreSet(input);
  const traded = input.set.median7d ?? null;
  if (!scored || traded === null || traded <= 0) continue;
  if (scored.sellAt > Math.round(traded)) aboveTraded++;
  if (scored.sellAt < input.set.lowSell! - DEFAULT_POLICY.undercut) capped++;
}
check("no set sold above its traded median", aboveTraded === 0, `${aboveTraded} violations`);
console.log(`        ${capped} sets list at the traded price because their asks sit above it`);

console.log("\n── top of the list ──────────────────────────────────────────────────────");
for (const o of ranked.slice(0, 10)) {
  console.log(
    `  ${o.name.slice(0, 30).padEnd(30)} ${o.kind.padEnd(6)} ` +
      `buy ${String(o.buyAt).padStart(5)} → sell ${String(o.sellAt).padStart(5)} · ` +
      `${String(o.margin + "p").padStart(6)} · vol ${String(o.volume48h).padStart(4)} · score ${o.score}`,
  );
}

console.log("\n─────────────────────────────────────────────────────────────────────────");
if (failures === 0) {
  console.log("PASS — ranking is liquidity-filtered and quantity-correct");
} else {
  console.log(`FAIL — ${failures} check(s) above`);
  process.exitCode = 1;
}
db.close();
