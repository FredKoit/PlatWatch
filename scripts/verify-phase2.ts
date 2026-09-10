/**
 * Phase 2 acceptance gate.
 *
 * Done when: a full sweep finishes and snapshot rows ≈ the catalogue size.
 * Also checks the data integrity that Phase 4 depends on — above all that
 * `quantityInSet` survived ingestion, since assuming 1 inverts set arbitrage.
 */
import { openDb, getMeta } from "../src/db/index";

const db = openDb();
let failures = 0;

const one = <T>(sql: string, ...params: unknown[]): T =>
  db.prepare(sql).get(...params) as T;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(46)} ${detail}`);
  if (!ok) failures++;
}

console.log("── catalogue ────────────────────────────────────────────────────────");
const items = one<{ c: number }>("SELECT COUNT(*) c FROM item").c;
check("items ingested", items > 3000, `${items} rows`);
console.log(`        catalogue version ${getMeta(db, "catalog_version") ?? "unset"}`);

console.log("\n── sets and quantities ──────────────────────────────────────────────");
const setsWithParts = one<{ c: number }>(
  "SELECT COUNT(DISTINCT set_id) c FROM item_part",
).c;
check("sets with component edges", setsWithParts > 200, `${setsWithParts} sets`);

const selfRef = one<{ c: number }>("SELECT COUNT(*) c FROM item_part WHERE set_id = part_id").c;
check("no set is a component of itself", selfRef === 0, `${selfRef} self-references`);

const multi = one<{ c: number }>("SELECT COUNT(*) c FROM item_part WHERE qty > 1").c;
check("multi-quantity parts present", multi > 0, `${multi} edges need 2+ per set`);

const noQty = one<{ c: number }>("SELECT COUNT(*) c FROM item_part WHERE qty IS NULL OR qty < 1").c;
check("every edge has a usable quantity", noQty === 0, `${noQty} bad rows`);

// The specific trap: dual-wield sets need 2 of most components.
const dk = db
  .prepare(
    `SELECT p.slug, ip.qty
       FROM item_part ip
       JOIN item s ON s.id = ip.set_id
       JOIN item p ON p.id = ip.part_id
      WHERE s.slug = 'dual_kamas_prime_set'
      ORDER BY p.slug`,
  )
  .all() as Array<{ slug: string; qty: number }>;
const dkTotal = dk.reduce((sum, r) => sum + r.qty, 0);
check(
  "dual_kamas_prime_set component count",
  dkTotal === 5,
  dk.length ? `${dk.map((r) => `${r.slug.replace("dual_kamas_prime_", "")}x${r.qty}`).join(" ")} = ${dkTotal}` : "no edges",
);

console.log("\n── sweep ────────────────────────────────────────────────────────────");
const sweep = one<{
  id: number;
  started_at: string;
  finished_at: string | null;
  items_ok: number;
  items_failed: number;
}>(
  // The latest FINISHED sweep. With a daemon sweeping on a schedule there is
  // usually one in progress, and judging a half-done crawl for coverage is a
  // false alarm, not a finding.
  "SELECT id, started_at, finished_at, items_ok, items_failed FROM sweep " +
    "WHERE kind='top' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
);

const inProgress = one<{ id: number; n: number } | undefined>(
  `SELECT id, (SELECT COUNT(*) FROM snapshot WHERE sweep_id = sweep.id) AS n
     FROM sweep WHERE kind='top' AND finished_at IS NULL ORDER BY id DESC LIMIT 1`,
);

if (inProgress) {
  console.log(`        (sweep #${inProgress.id} in progress, ${inProgress.n} rows so far — not judged)`);
}

if (!sweep) {
  check("a completed top sweep exists", false, "none found — run: tsx scripts/ingest.ts sweep");
} else {
  const mins = sweep.finished_at
    ? (Date.parse(sweep.finished_at) - Date.parse(sweep.started_at)) / 60000
    : null;
  // Wall clock between the first and last item. A resumed sweep keeps its
  // original started_at, so any time the machine was off is counted here too —
  // this is not the crawl's working time.
  check(
    "sweep completed",
    sweep.finished_at !== null,
    mins ? `${mins.toFixed(1)} min wall clock (incl. any pause)` : "unfinished",
  );
  check("sweep had no failures", sweep.items_failed === 0, `${sweep.items_failed} failed`);

  // Snapshots are per VARIANT, so there are legitimately more rows than items —
  // a ranked mod contributes one row per rank on the book. Coverage has to be
  // measured in distinct items, or it reads as 128% and means nothing.
  const snaps = one<{ c: number }>("SELECT COUNT(*) c FROM snapshot WHERE sweep_id = ?", sweep.id).c;
  const covered = one<{ c: number }>(
    "SELECT COUNT(DISTINCT item_id) c FROM snapshot WHERE sweep_id = ?",
    sweep.id,
  ).c;
  const coverage = (covered / items) * 100;
  check(
    "every catalogue item was visited",
    coverage > 99,
    `${covered}/${items} items (${coverage.toFixed(1)}%), ${snaps} variant markets`,
  );

  const priced = one<{ c: number }>(
    "SELECT COUNT(*) c FROM snapshot WHERE sweep_id = ? AND sell_p50_top IS NOT NULL",
    sweep.id,
  ).c;
  console.log(`        ${priced} markets had a sell price (${((priced / snaps) * 100).toFixed(1)}%)`);

  const spread = one<{ c: number }>(
    "SELECT COUNT(*) c FROM snapshot WHERE sweep_id = ? AND low_sell IS NOT NULL AND high_buy IS NOT NULL AND low_sell > high_buy",
    sweep.id,
  ).c;
  console.log(`        ${spread} markets have a positive buy→sell spread`);
}

console.log("\n── order tracking ───────────────────────────────────────────────────");
const orders = one<{ c: number }>("SELECT COUNT(*) c FROM order_seen").c;
check("orders recorded", orders > 0, `${orders} distinct orders`);

const ghosts = one<{ c: number }>("SELECT COUNT(*) c FROM order_seen WHERE sweeps_at_best > 1").c;
console.log(`        ${ghosts} orders have held the best price across 2+ sweeps`);
console.log(`        (needs several sweeps before this signal means anything)`);

console.log("\n─────────────────────────────────────────────────────────────────────");
if (failures === 0) {
  console.log("PASS — schema, quantities and sweep coverage all check out");
} else {
  console.log(`FAIL — ${failures} check(s) above`);
  process.exitCode = 1;
}
db.close();
