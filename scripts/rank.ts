/**
 * Ranked trade list.
 *
 *   tsx scripts/rank.ts                 — best opportunities, both strategies
 *   tsx scripts/rank.ts --kind set      — set arbitrage only
 *   tsx scripts/rank.ts --top 40
 *   tsx scripts/rank.ts --rejected      — show what was filtered out and why
 *   tsx scripts/rank.ts --max-capital 150
 *   tsx scripts/rank.ts --sort return   — best margin per platinum tied up
 */
import { openDb } from "../src/db/index";
import { latestSweepId, setRows, spreadRows } from "../src/rank/query";
import {
  DEFAULT_POLICY,
  rank,
  scoreSet,
  scoreSpread,
  type Opportunity,
  type RankingPolicy,
} from "../src/rank/score";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(`--${name}`);

const db = openDb();
const sweepId = latestSweepId(db);
if (sweepId === null) {
  console.error("no finished sweep — run: tsx scripts/ingest.ts sweep");
  process.exit(1);
}

const kind = flag("kind");
const top = Number(flag("top") ?? 25);

const capital = flag("max-capital");
const policy: RankingPolicy = {
  ...DEFAULT_POLICY,
  maxBuyAt: capital ? Number(capital) : null,
};

const all: Array<Opportunity | null> = [];
if (kind !== "set") all.push(...spreadRows(db, sweepId).map((r) => scoreSpread(r, policy)));
if (kind !== "spread") all.push(...setRows(db, sweepId).map((s) => scoreSet(s, policy)));

const ranked = rank(all, flag("sort") === "return" ? "return" : "score");

const pad = (s: string | number, n: number) => String(s).padStart(n);
const cell = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

console.log(
  `\nsweep #${sweepId} · policy: volume≥${DEFAULT_POLICY.minVolume48h}/48h, ` +
    `≥${DEFAULT_POLICY.minSellOrders} asks, book<${DEFAULT_POLICY.maxBookAgeHours}h, ` +
    `margin≥${DEFAULT_POLICY.minMarginPlat}p & ${DEFAULT_POLICY.minMarginPct * 100}%\n`,
);
console.log(
  cell("item", 32),
  cell("kind", 6),
  pad("buy", 6),
  pad("sell", 6),
  pad("margin", 7),
  pad("vol48", 6),
  pad("age_h", 6),
  pad("score", 6),
  pad("ret%", 6),
);
console.log("─".repeat(94));

for (const o of ranked.slice(0, top)) {
  console.log(
    cell(o.name, 32),
    cell(o.kind, 6),
    pad(o.buyAt, 6),
    pad(o.sellAt, 6),
    pad(`${o.margin}p`, 7),
    pad(o.volume48h, 6),
    pad(o.bookAgeH === null ? "-" : o.bookAgeH.toFixed(0), 6),
    pad(o.score, 6),
    pad((o.marginPct * 100).toFixed(0), 6),
  );
}

console.log(
  `\n${ranked.length} tradable of ${all.filter(Boolean).length} evaluated ` +
    `(${all.length - all.filter(Boolean).length} unpriceable)`,
);

if (has("rejected")) {
  const rejected = all
    .filter((o): o is Opportunity => o !== null && o.rejects.length > 0 && o.margin > 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 20);

  console.log(`\nheld back — widest margins first (this is where the traps are):\n`);
  for (const o of rejected) {
    console.log(`  ${cell(o.name, 32)} ${pad(`${o.margin}p`, 7)}  ${o.rejects.join("; ")}`);
  }

  const reasons = new Map<string, number>();
  for (const o of all) {
    for (const r of o?.rejects ?? []) {
      const key = r.replace(/[\d.]+/g, "N");
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  console.log(`\nrejection reasons:`);
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(n, 6)}  ${reason}`);
  }
}

db.close();
