import { test } from "node:test";
import assert from "node:assert/strict";
import { finishSweep, openDb, startSweep, type Db } from "../db/index";
import { insertSnapshots, recordOrders, summariseTop, upsertCatalog } from "../db/repo";
import { latestSweepId } from "../rank/query";
import { opportunities } from "../web/api";
import { sellAdvice } from "../rank/sell";
import { refreshWatched } from "./watchlist";
import type { TopOrders, WfmItemSummary, WfmOrder } from "../wfm/types";

/**
 * The watchlist used to be implemented as a sweep. That one decision caused two
 * bugs: the refresh became "the latest sweep", collapsing the ranking, sniper
 * and stats to the starred items; and it advanced the ghost counter every five
 * minutes. `ingest sweep --limit` could trigger the first one too.
 */

const nowIso = new Date().toISOString();
const item = (id: string, slug: string): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags: [],
  i18n: { en: { name: slug } },
});

const order = (
  id: string,
  itemId: string,
  type: "sell" | "buy",
  platinum: number,
): WfmOrder => ({
  id,
  type,
  platinum,
  quantity: 1,
  perTrade: 1,
  visible: true,
  createdAt: nowIso,
  updatedAt: nowIso,
  itemId,
  user: {
    id: `u-${id}`,
    ingameName: `P-${id}`,
    slug: `p-${id}`,
    reputation: 5,
    platform: "pc",
    crossplay: true,
    locale: "en",
    status: "ingame",
  },
});

/** Two liquid, rankable markets under one full sweep. */
function market(): { db: Db; fullSweep: number } {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("rhino", "rhino_prime_set"), item("frost", "frost_prime_set")]);
  const fullSweep = startSweep(db, "top", "full");
  const book = (id: string): TopOrders => ({
    sell: [60, 61, 62, 63, 64].map((p, i) => order(`${id}-s${i}`, id, "sell", p)),
    buy: [45, 44, 43, 42, 41].map((p, i) => order(`${id}-b${i}`, id, "buy", p)),
  });
  for (const id of ["rhino", "frost"]) {
    insertSnapshots(db, fullSweep, [summariseTop(id, book(id))]);
    db.prepare(
      `INSERT INTO stat_summary (item_id, variant, fetched_at, volume_48h, volume_7d, volume_30d,
                                 median_7d, median_30d, days_traded_30d, last_traded_at)
       VALUES (?, '', ?, 100, 400, 1600, 62, 60, 30, ?)`,
    ).run(id, nowIso, nowIso);
  }
  finishSweep(db, fullSweep, 2, 0);
  return { db, fullSweep };
}

test("regression: a newer partial sweep does not become the baseline", () => {
  const { db, fullSweep } = market();
  // What `ingest sweep --limit 1` or the old watchlist left behind.
  const partial = startSweep(db, "top", "partial");
  insertSnapshots(db, partial, [summariseTop("rhino", { sell: [], buy: [] })]);
  finishSweep(db, partial, 1, 0);

  assert.ok(partial > fullSweep, "the partial sweep is the newest");
  assert.equal(latestSweepId(db), fullSweep, "but only a full sweep may stand for the market");
  db.close();
});

test("a watchlist refresh leaves the whole market in the ranking", async () => {
  const { db, fullSweep } = market();
  const before = opportunities(db).map((o) => o.itemId).sort();
  assert.deepEqual(before, ["frost", "rhino"]);

  const sweepsBefore = (db.prepare("SELECT COUNT(*) c FROM sweep").get() as { c: number }).c;
  await refreshWatched(db, [{ id: "rhino", slug: "rhino_prime_set", name: "rhino", tags: "[]" }], {
    fetchTop: async () => ({
      sell: [order("new-s", "rhino", "sell", 59)],
      buy: [order("new-b", "rhino", "buy", 46)],
    }),
  });

  const sweepsAfter = (db.prepare("SELECT COUNT(*) c FROM sweep").get() as { c: number }).c;
  assert.equal(sweepsAfter, sweepsBefore, "a watchlist read is not a sweep and must not create one");
  assert.equal(latestSweepId(db), fullSweep);
  assert.deepEqual(
    opportunities(db).map((o) => o.itemId).sort(),
    ["frost", "rhino"],
    "starring rhino must not make frost disappear",
  );
  db.close();
});

const streak = (db: Db, id: string) =>
  (db.prepare("SELECT sweeps_at_best AS n FROM order_seen WHERE order_id = ?").get(id) as { n: number })
    .n;

test("an hour of watchlist refreshes does not manufacture a ghost", async () => {
  const { db } = market();
  const cheapest = order("c1", "rhino", "sell", 58);
  recordOrders(db, [{ order: cheapest, rank: 0 }]); // one real sweep: streak 1

  const watched = [{ id: "rhino", slug: "rhino_prime_set", name: "rhino", tags: "[]" }];
  for (let i = 0; i < 12; i++) {
    await refreshWatched(db, watched, {
      fetchTop: async () => ({ sell: [cheapest], buy: [] }),
    });
  }
  assert.equal(streak(db, "c1"), 1, "twelve five-minute reads are not twelve sweeps");

  recordOrders(db, [{ order: cheapest, rank: 0 }]); // the next real sweep
  assert.equal(streak(db, "c1"), 2, "only sweeps advance it");
  db.close();
});

test("a watchlist read that sees the order undercut ends the streak", async () => {
  const { db } = market();
  const was = order("c1", "rhino", "sell", 58);
  recordOrders(db, [{ order: was, rank: 0 }]);
  recordOrders(db, [{ order: was, rank: 0 }]);
  assert.equal(streak(db, "c1"), 2);

  // Someone undercut it: it is no longer the cheapest, so it is not a ghost.
  await refreshWatched(db, [{ id: "rhino", slug: "rhino_prime_set", name: "rhino", tags: "[]" }], {
    fetchTop: async () => ({ sell: [order("under", "rhino", "sell", 50), was], buy: [] }),
  });
  assert.equal(streak(db, "c1"), 0, "evidence of undercut is evidence, however often it is read");
  db.close();
});

test("a cheaper ask seen by the watchlist reaches sell advice", async () => {
  const { db } = market();
  assert.equal(sellAdvice(db, "rhino").lowestAsk, 60, "the sweep saw 60");

  await refreshWatched(db, [{ id: "rhino", slug: "rhino_prime_set", name: "rhino", tags: "[]" }], {
    fetchTop: async () => ({ sell: [order("comp", "rhino", "sell", 52)], buy: [] }),
  });
  assert.equal(
    sellAdvice(db, "rhino").lowestAsk,
    52,
    "starring an item you are selling must actually refresh the competition",
  );
  db.close();
});
