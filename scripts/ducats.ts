/**
 * Ducat conversions — the Baro Ki'Teer play.
 *
 *   tsx scripts/ducats.ts
 *   tsx scripts/ducats.ts --budget 200      — what that budget actually buys
 *   tsx scripts/ducats.ts --max-capital 10  — cap per item
 */
import { openDb } from "../src/db/index";
import { DEFAULT_DUCAT_POLICY, ducatOpportunities, planSpend } from "../src/rank/ducats";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};

const db = openDb();
const cap = flag("max-capital");
const rows = ducatOpportunities(db, {
  ...DEFAULT_DUCAT_POLICY,
  maxBuyAt: cap ? Number(cap) : null,
});

const pad = (s: string | number, n: number) => String(s).padStart(n);
const cell = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

console.log(
  `\n${rows.length} conversions at ≥${DEFAULT_DUCAT_POLICY.minDucatsPerPlat} ducats/plat` +
    (cap ? `, ≤${cap}p each` : "") + `\n`,
);
console.log(cell("item", 34), pad("ducats", 7), pad("cost", 6), pad("duc/plat", 9), pad("vol48", 6));
console.log("─".repeat(66));
for (const r of rows.slice(0, Number(flag("top") ?? 20))) {
  console.log(
    cell(r.name, 34),
    pad(r.ducats, 7),
    pad(`${r.buyAt}p`, 6),
    pad(r.ducatsPerPlat, 9),
    pad(r.volume48h, 6),
  );
}

const budget = Number(flag("budget") ?? 0);
if (budget > 0) {
  const p = planSpend(rows, budget);
  console.log(
    `\nSpending ${budget}p one-of-each down the list: ` +
      `${p.ducats} ducats from ${p.items} items for ${p.spent}p (${p.ducatsPerPlat} d/p blended)`,
  );
} else {
  console.log(`\nAdd --budget N to see what a given spend actually buys.`);
}
db.close();
