/**
 * Phase 2 ingestion CLI.
 *
 *   tsx scripts/ingest.ts catalog   — refresh the item table (cheap)
 *   tsx scripts/ingest.ts details   — set roots + parts, with quantityInSet (~7 min)
 *   tsx scripts/ingest.ts sweep     — full top-of-book sweep (~21 min)
 *   tsx scripts/ingest.ts stats     — price history for rankable candidates (~11 min)
 *   tsx scripts/ingest.ts sweep --limit 250
 *
 * Ctrl-C stops cleanly and closes out the sweep row; re-running `sweep`
 * with --resume continues the last unfinished one.
 */
import { openDb, setMeta, getMeta, startSweep } from "../src/db/index";
import { upsertCatalog } from "../src/db/repo";
import { ingestSetDetails } from "../src/ingest/details";
import { itemsToSweep, sweepTopOrders } from "../src/ingest/sweep";
import { ingestStats, statsCandidates } from "../src/ingest/stats";
import { loadCatalog } from "../src/wfm/catalog";

const args = process.argv.slice(2);
const command = args[0] ?? "";
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(`--${name}`);

const controller = new AbortController();
process.on("SIGINT", () => {
  console.log("\n  interrupt received — finishing the current item and closing out");
  controller.abort(new Error("interrupted"));
});

function bar(done: number, total: number): string {
  const width = 24;
  const filled = Math.round((done / total) * width);
  return `[${"█".repeat(filled)}${"·".repeat(width - filled)}] ${done}/${total}`;
}

async function refreshCatalog() {
  const db = openDb();
  const { items, version, fromCache } = await loadCatalog(controller.signal);
  const n = upsertCatalog(db, items);
  setMeta(db, "catalog_version", version);
  console.log(`catalog: ${n} items at version ${version} (${fromCache ? "cached" : "downloaded"})`);
  db.close();
}

async function refreshDetails() {
  const db = openDb();
  let last = "";
  const result = await ingestSetDetails(
    db,
    (done, total, phase) => {
      const line = `  ${phase.padEnd(5)} ${bar(done, total)}`;
      if (line !== last && (done % 25 === 0 || done === total)) {
        console.log(line);
        last = line;
      }
    },
    controller.signal,
  );
  setMeta(db, "details_version", getMeta(db, "catalog_version") ?? "unknown");
  console.log(
    `details: ${result.sets} sets, ${result.parts} parts, ${result.failed} failed · ` +
      `${result.multiQtyParts} part edges need more than one per set`,
  );
  db.close();
}

async function runSweep() {
  const db = openDb();
  let items = itemsToSweep(db);
  const limit = flag("limit");
  if (limit) items = items.slice(0, Number(limit));

  // --limit covers a subset, so it must be marked partial: otherwise it becomes
  // "the latest sweep" and every other item drops out of the ranking.
  const scope = limit ? "partial" : "full";

  let sweepId: number | undefined;
  if (has("resume")) {
    const row = db
      .prepare(
        `SELECT id FROM sweep
          WHERE kind = 'top' AND scope = ? AND finished_at IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(scope) as { id: number } | undefined;
    if (row) {
      sweepId = row.id;
      console.log(`resuming sweep #${sweepId}`);
    }
  }
  sweepId ??= startSweep(db, "top", scope);
  if (scope === "partial") {
    console.log(`partial sweep (--limit ${limit}): recorded, but never used as the baseline`);
  }

  console.log(`sweeping ${items.length} items (sweep #${sweepId})`);
  const started = Date.now();
  const result = await sweepTopOrders(db, items, {
    sweepId,
    signal: controller.signal,
    onProgress: (done, total, ok, failed) => {
      if (done % 100 !== 0 && done !== total) return;
      const rate = done / ((Date.now() - started) / 1000);
      const remaining = (total - done) / rate;
      console.log(
        `  ${bar(done, total)} · ${rate.toFixed(2)} req/s · ` +
          `${failed} failed · eta ${(remaining / 60).toFixed(1)} min`,
      );
    },
  });

  console.log(
    `sweep #${result.sweepId}: ${result.ok} ok, ${result.failed} failed, ` +
      `${result.withOrders} with live orders, ${(result.elapsedMs / 60000).toFixed(1)} min` +
      (result.interrupted ? " (interrupted)" : ""),
  );
  db.close();
}


async function refreshStats() {
  const db = openDb();
  const sweep = db
    .prepare("SELECT id FROM sweep WHERE kind='top' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  if (!sweep) {
    console.error("no finished sweep yet — run: tsx scripts/ingest.ts sweep");
    process.exitCode = 1;
    return;
  }

  let items = statsCandidates(db, sweep.id);
  const limit = flag("limit");
  if (limit) items = items.slice(0, Number(limit));

  console.log(`stats: ${items.length} candidates from sweep #${sweep.id}`);
  const started = Date.now();
  const result = await ingestStats(db, items, {
    signal: controller.signal,
    onProgress: (done, total, ok, failed) => {
      if (done % 100 !== 0 && done !== total) return;
      const rate = done / ((Date.now() - started) / 1000);
      console.log(
        `  ${bar(done, total)} · ${rate.toFixed(2)} req/s · ${failed} failed · ` +
          `eta ${(((total - done) / rate) / 60).toFixed(1)} min`,
      );
    },
  });
  console.log(
    `stats: ${result.ok} fetched, ${result.skipped} already fresh, ${result.failed} failed` +
      (result.interrupted ? " (interrupted)" : ""),
  );
  db.close();
}

const commands: Record<string, () => Promise<void>> = {
  catalog: refreshCatalog,
  details: refreshDetails,
  sweep: runSweep,
  stats: refreshStats,
};

const run = commands[command];
if (!run) {
  console.error(`usage: ingest.ts <${Object.keys(commands).join("|")}> [--limit N] [--resume]`);
  process.exitCode = 1;
} else {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
