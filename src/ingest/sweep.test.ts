import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { upsertCatalog } from "../db/repo";
import { itemsToSweep, MAX_CONSECUTIVE_OUTAGE_FAILURES, sweepTopOrders } from "./sweep";
import { latestSweepId } from "../rank/query";
import { WfmNotFoundError, WfmUnavailableError } from "../wfm/errors";
import type { TopOrders, WfmItemSummary } from "../wfm/types";

/**
 * These cover the stop/resume contract only. The abort is checked at the top of
 * the loop, so no request is ever issued and the tests stay offline.
 */

const item = (id: string, slug: string): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags: [],
  i18n: { en: { name: slug } },
});

function seeded() {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("a", "alpha"), item("b", "bravo"), item("c", "charlie")]);
  return db;
}

test("an interrupted sweep stays open so it can be resumed", async () => {
  const db = seeded();
  const aborted = AbortSignal.abort(new Error("stopped"));

  const result = await sweepTopOrders(db, itemsToSweep(db), { signal: aborted });

  assert.equal(result.interrupted, true);
  const row = db.prepare("SELECT finished_at FROM sweep WHERE id = ?").get(result.sweepId) as {
    finished_at: string | null;
  };
  assert.equal(
    row.finished_at,
    null,
    "a stopped sweep must not look finished, or --resume will skip it",
  );
  db.close();
});

test("a sweep that runs to the end is marked finished", async () => {
  const db = seeded();
  // No items to visit, so it completes without touching the network.
  const result = await sweepTopOrders(db, [], {});
  assert.equal(result.interrupted, false);
  const row = db.prepare("SELECT finished_at FROM sweep WHERE id = ?").get(result.sweepId) as {
    finished_at: string | null;
  };
  assert.ok(row.finished_at, "a completed sweep records when it ended");
  db.close();
});

test("resuming skips items already committed under the same sweep id", async () => {
  const db = seeded();
  const openSweep = db
    .prepare("INSERT INTO sweep (kind, started_at) VALUES ('top', ?)")
    .run(new Date().toISOString());
  const sweepId = Number(openSweep.lastInsertRowid);

  // Pretend the previous run committed one item before dying.
  db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, taken_at, sell_count, buy_count)
     VALUES ('a', ?, ?, 0, 0)`,
  ).run(sweepId, new Date().toISOString());

  const result = await sweepTopOrders(db, itemsToSweep(db), {
    sweepId,
    signal: AbortSignal.abort(new Error("stop immediately")),
  });

  // It aborts before fetching anything, but the already-done item is counted
  // as ok rather than re-requested.
  assert.equal(result.sweepId, sweepId, "resume continues the same sweep row");
  const snaps = db.prepare("SELECT COUNT(*) c FROM snapshot WHERE sweep_id=?").get(sweepId) as {
    c: number;
  };
  assert.equal(snaps.c, 1, "no duplicate snapshot for the completed item");
  db.close();
});

// ── outages ─────────────────────────────────────────────────────────────────
// Offline through an injected fetcher. The real client retries four times with
// backoff before it raises WfmUnavailableError; here it raises at once.

const EMPTY_BOOK: TopOrders = { sell: [], buy: [] };
const down = async (slug: string): Promise<TopOrders> => {
  throw new WfmUnavailableError(`https://api.warframe.market/v2/orders/item/${slug}/top`, 4, new TypeError("fetch failed"));
};
const gone = async (slug: string): Promise<TopOrders> => {
  throw new WfmNotFoundError(`https://api.warframe.market/v2/orders/item/${slug}/top`);
};

/** A catalogue of `n` items, and one earlier full sweep that is the baseline. */
function market(n: number): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, Array.from({ length: n }, (_, i) => item(`i${i}`, `item_${String(i).padStart(3, "0")}`)));
  const at = new Date().toISOString();
  db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at, items_ok) VALUES (1, 'top', ?, ?, ?)").run(at, at, n);
  return db;
}

test("regression: an outage stops the sweep instead of replacing the market", async () => {
  // It used to grind through every item and stamp the empty result a finished
  // full sweep — which then became the baseline: no ranking, no sniper.
  const db = market(40);
  const r = await sweepTopOrders(db, itemsToSweep(db), { fetchTop: down });

  assert.equal(r.stoppedBy, "unreachable");
  assert.equal(r.interrupted, true);
  assert.equal(r.failed, MAX_CONSECUTIVE_OUTAGE_FAILURES, "stops after a run of failures, not after all 40");
  const row = db.prepare("SELECT finished_at FROM sweep WHERE id = ?").get(r.sweepId) as { finished_at: string | null };
  assert.equal(row.finished_at, null, "left open, so the retry resumes it");
  assert.equal(latestSweepId(db), 1, "the last good sweep stays the baseline");
  db.close();
});

test("a success breaks the run: scattered failures are not an outage", async () => {
  const db = market(40);
  let n = 0;
  const flaky = (slug: string) => (++n % 10 === 0 ? Promise.resolve(EMPTY_BOOK) : down(slug));
  const r = await sweepTopOrders(db, itemsToSweep(db), { fetchTop: flaky });
  assert.equal(r.stoppedBy, undefined, "never ten in a row");
  assert.equal(r.interrupted, false);
  db.close();
});

test("missing items are not an outage, but a sweep that fetched too little is not the market", async () => {
  // Every item 404s: nothing is down, so the sweep runs to the end — and then
  // is recorded as partial, because 0% of the market is not a baseline.
  const db = market(15);
  const r = await sweepTopOrders(db, itemsToSweep(db), { fetchTop: gone });
  assert.equal(r.stoppedBy, undefined);
  assert.equal(r.partial, true);
  const row = db.prepare("SELECT scope, finished_at FROM sweep WHERE id = ?").get(r.sweepId) as { scope: string; finished_at: string | null };
  assert.equal(row.scope, "partial");
  assert.ok(row.finished_at);
  assert.equal(latestSweepId(db), 1);
  db.close();
});

test("a sweep that lost a tenth of the market is partial; one that lost a twentieth is the baseline", async () => {
  const lose = (count: number) => {
    let n = 0;
    return (slug: string) => (n++ < count ? gone(slug) : Promise.resolve(EMPTY_BOOK));
  };

  const thin = market(20);
  const a = await sweepTopOrders(thin, itemsToSweep(thin), { fetchTop: lose(3) });
  assert.equal(a.partial, true, "85% fetched");
  assert.equal(latestSweepId(thin), 1);
  thin.close();

  const fine = market(20);
  const b = await sweepTopOrders(fine, itemsToSweep(fine), { fetchTop: lose(1) });
  assert.equal(b.partial, undefined, "95% fetched");
  assert.equal(latestSweepId(fine), b.sweepId);
  fine.close();
});
