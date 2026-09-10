/**
 * What to list something at, once you hold it.
 *
 *   tsx scripts/sell.ts rhino_prime_set
 *   tsx scripts/sell.ts archon_vitality --variant r10
 */
import { openDb } from "../src/db/index";
import { sellAdvice } from "../src/rank/sell";

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
const vi = args.indexOf("--variant");
const variant = vi >= 0 ? (args[vi + 1] ?? "") : "";

if (!slug) {
  console.error("usage: sell.ts <slug> [--variant r10]");
  process.exit(1);
}

const db = openDb();
const item = db.prepare("SELECT id, name FROM item WHERE slug = ?").get(slug) as
  | { id: string; name: string }
  | undefined;
if (!item) {
  console.error(`no item with slug "${slug}"`);
  process.exit(1);
}

const a = sellAdvice(db, item.id, variant);
const p = (n: number | null) => (n === null ? "–" : `${n}p`);

console.log(`\n${item.name}${variant ? ` [${variant}]` : ""}\n`);
console.log(`  cheapest ask now   ${p(a.lowestAsk)}`);
console.log(
  `  trades at          ${p(a.tradedMedian)}` +
    (a.tradedLow !== null ? `  (range ${p(a.tradedLow)}–${p(a.tradedHigh)})` : ""),
);
console.log(`  volume             ${a.dailyVolume}/day over ${a.daysOfHistory} days\n`);
console.log(`  quick    ${p(a.quickPrice)}   undercut the book, move it today`);
console.log(
  `  fair     ${p(a.fairPrice)}   where it clears` +
    (a.estimatedDaysAtFair === null
      ? ""
      : ` · ${a.queueAtFair} seller(s) ahead, ~${a.estimatedDaysAtFair}d`),
);
console.log(`  patient  ${p(a.patientPrice)}   top of the recent range\n`);
if (a.bookAboveMarket) {
  console.log(`  ! the book sits well above the traded range — undercutting it`);
  console.log(`    still leaves you above where anyone actually buys.\n`);
}
db.close();
