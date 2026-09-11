import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "./index";
import { upsertCatalog } from "./repo";
import { applyRetention } from "./retention";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function seeded(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [
    { id: "i", slug: "rhino_prime_set", gameRef: "/x", tags: [], i18n: { en: { name: "r" } } },
  ]);
  return db;
}

function order(db: Db, id: string, leftTopAt: string | null, firstSeen = daysAgo(90)) {
  db.prepare(
    `INSERT INTO order_seen (order_id, item_id, user_id, ingame_name, type, platinum, variant,
                             created_at, updated_at, first_seen, last_seen, sightings,
                             top_rank, sweeps_at_best, left_top_at)
     VALUES (?, 'i', 'u', 'Someone', 'sell', 10, '', ?, ?, ?, ?, 1, 0, 0, ?)`,
  ).run(id, firstSeen, firstSeen, firstSeen, firstSeen, leftTopAt);
}

const orderIds = (db: Db) =>
  (db.prepare("SELECT order_id FROM order_seen ORDER BY order_id").all() as Array<{ order_id: string }>).map(
    (r) => r.order_id,
  );

test("orders that left the book over 30 days ago are removed; recent ones stay", () => {
  const db = seeded();
  order(db, "gone-31d", daysAgo(31));
  order(db, "gone-29d", daysAgo(29));

  const r = applyRetention(db, 30, NOW);
  assert.equal(r.orders, 1);
  assert.deepEqual(orderIds(db), ["gone-29d"]);
  db.close();
});

test("an order still on the book is never removed, however old", () => {
  const db = seeded();
  // First seen 90 days ago and still the cheapest ask — exactly what the ghost
  // signal exists to measure.
  order(db, "live-and-ancient", null, daysAgo(90));
  applyRetention(db, 30, NOW);
  assert.deepEqual(orderIds(db), ["live-and-ancient"]);
  db.close();
});

test("an order your whisper log refers to is kept", () => {
  const db = seeded();
  order(db, "whispered", daysAgo(60));
  db.prepare(
    `INSERT INTO whisper_log (order_id, item_id, user_id, ingame_name, platinum, sent_at)
     VALUES ('whispered', 'i', 'u', 'Someone', 10, ?)`,
  ).run(daysAgo(60));

  applyRetention(db, 30, NOW);
  assert.deepEqual(orderIds(db), ["whispered"], "your own record never loses its link");
  db.close();
});

function sweep(db: Db, id: number, startedAt: string) {
  db.prepare(
    "INSERT INTO sweep (id, kind, started_at, finished_at, scope) VALUES (?, 'top', ?, ?, 'full')",
  ).run(id, startedAt, startedAt);
  db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, sell_count, buy_count)
     VALUES ('i', ?, '', ?, 0, 0)`,
  ).run(id, startedAt);
}

const snapshotSweeps = (db: Db) =>
  (db.prepare("SELECT sweep_id FROM snapshot ORDER BY sweep_id").all() as Array<{ sweep_id: number }>).map(
    (r) => r.sweep_id,
  );

test("old sweeps' snapshots are removed, recent ones kept", () => {
  const db = seeded();
  sweep(db, 1, daysAgo(45));
  sweep(db, 2, daysAgo(10));
  const r = applyRetention(db, 30, NOW);
  assert.equal(r.snapshots, 1);
  assert.deepEqual(snapshotSweeps(db), [2]);
  db.close();
});

test("the latest full sweep is kept even if the daemon was off for a month", () => {
  const db = seeded();
  sweep(db, 1, daysAgo(60));
  sweep(db, 2, daysAgo(45)); // the most recent full sweep there is
  applyRetention(db, 30, NOW);
  assert.deepEqual(snapshotSweeps(db), [2], "never leave the ranking with no baseline at all");
  db.close();
});

test("nothing to remove reports zero, so the daily job stays quiet", () => {
  const db = seeded();
  order(db, "fresh", daysAgo(1));
  assert.deepEqual(applyRetention(db, 30, NOW), { orders: 0, snapshots: 0 });
  db.close();
});
