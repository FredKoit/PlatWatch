import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "./index";
import {
  insertSnapshots,
  markLeftTop,
  recordOrders,
  saveSetParts,
  summariseTop,
  upsertCatalog,
} from "./repo";
import type { TopOrders, WfmOrder, WfmItemSummary } from "../wfm/types";
import { summariseByVariant } from "./repo";

const item = (id: string, slug: string, tags: string[] = []): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags,
  i18n: { en: { name: slug } },
});

const order = (
  id: string,
  itemId: string,
  type: "sell" | "buy",
  platinum: number,
  updatedAt = new Date().toISOString(),
): WfmOrder => ({
  id,
  type,
  platinum,
  quantity: 1,
  perTrade: 1,
  visible: true,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt,
  itemId,
  user: {
    id: `u-${id}`,
    ingameName: `player-${id}`,
    slug: `player-${id}`,
    reputation: 10,
    platform: "pc",
    crossplay: true,
    locale: "en",
    status: "ingame",
  },
});

function seed(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [
    item("set-1", "fang_prime_set", ["set"]),
    item("blade", "fang_prime_blade"),
    item("handle", "fang_prime_handle"),
    item("bp", "fang_prime_blueprint"),
  ]);
  return db;
}

test("fair value is the median of the top sells, not the cheapest", () => {
  const top: TopOrders = {
    sell: [
      order("s1", "i", "sell", 60),
      order("s2", "i", "sell", 63),
      order("s3", "i", "sell", 66),
      order("s4", "i", "sell", 69),
      order("s5", "i", "sell", 69),
    ],
    buy: [order("b1", "i", "buy", 50), order("b2", "i", "buy", 45)],
  };
  const row = summariseTop("i", top);

  assert.equal(row.lowSell, 60, "cheapest ask is the buy target");
  assert.equal(row.sellP50, 66, "median resists one outlier at the head of the book");
  assert.equal(row.highBuy, 50);
  assert.equal(row.sellCount, 5);
  assert.equal(row.buyCount, 2);
});

test("an empty book yields nulls rather than zeros", () => {
  const row = summariseTop("i", { sell: [], buy: [] });
  assert.equal(row.lowSell, null);
  assert.equal(row.sellP50, null);
  assert.equal(row.sellCount, 0);
  assert.equal(row.newestSellAgeH, null);
});

test("book freshness is measured from the newest order", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const top: TopOrders = {
    sell: [
      order("s1", "i", "sell", 60, "2026-09-10T09:00:00Z"),
      order("s2", "i", "sell", 61, "2026-09-08T12:00:00Z"),
    ],
    buy: [],
  };
  assert.equal(summariseTop("i", top, now).newestSellAgeH, 3);
});

test("a set is never a component of itself", () => {
  const db = seed();
  // setParts as the API returns it: the set's own id is in the list.
  saveSetParts(db, "set-1", [
    { partId: "blade", qty: 2 },
    { partId: "handle", qty: 2 },
    { partId: "bp", qty: 1 },
    { partId: "set-1", qty: 1 },
  ]);

  const parts = db
    .prepare("SELECT part_id, qty FROM item_part WHERE set_id = ? ORDER BY part_id")
    .all("set-1") as Array<{ part_id: string; qty: number }>;

  assert.deepEqual(parts, [
    { part_id: "blade", qty: 2 },
    { part_id: "bp", qty: 1 },
    { part_id: "handle", qty: 2 },
  ]);
  assert.equal(
    parts.reduce((sum, p) => sum + p.qty, 0),
    5,
    "fang prime needs 5 components, not 3",
  );
  db.close();
});

test("re-ingesting a set replaces its edges instead of accumulating them", () => {
  const db = seed();
  saveSetParts(db, "set-1", [{ partId: "blade", qty: 2 }]);
  saveSetParts(db, "set-1", [{ partId: "blade", qty: 2 }, { partId: "bp", qty: 1 }]);
  const n = db.prepare("SELECT COUNT(*) c FROM item_part WHERE set_id=?").get("set-1") as {
    c: number;
  };
  assert.equal(n.c, 2);
  db.close();
});

test("sweeps_at_best counts only time spent as the cheapest order", () => {
  const db = seed();
  const best = order("o1", "blade", "sell", 10);

  recordOrders(db, [{ order: best, rank: 0 }]);
  recordOrders(db, [{ order: best, rank: 0 }]);
  recordOrders(db, [{ order: best, rank: 0 }]);

  let row = db.prepare("SELECT sightings, sweeps_at_best FROM order_seen WHERE order_id=?").get("o1") as {
    sightings: number;
    sweeps_at_best: number;
  };
  assert.equal(row.sightings, 3);
  // Counts sweeps observed at rank 0, so a brand-new cheapest order starts at 1.
  // A high value is the ghost signal: still the best price, still unsold.
  assert.equal(row.sweeps_at_best, 3);

  // Undercut: it slips to rank 1 and the streak resets.
  recordOrders(db, [{ order: best, rank: 1 }]);
  row = db.prepare("SELECT sightings, sweeps_at_best FROM order_seen WHERE order_id=?").get("o1") as {
    sightings: number;
    sweeps_at_best: number;
  };
  assert.equal(row.sweeps_at_best, 0);
  db.close();
});

test("leaving the top of book is recorded, and returning clears it", () => {
  const db = seed();
  const a = order("a", "blade", "sell", 10);
  const b = order("b", "blade", "sell", 12);
  recordOrders(db, [
    { order: a, rank: 0 },
    { order: b, rank: 1 },
  ]);

  // Next sweep sees only `a`.
  markLeftTop(db, "blade", ["a"]);
  const gone = db.prepare("SELECT left_top_at FROM order_seen WHERE order_id=?").get("b") as {
    left_top_at: string | null;
  };
  const stayed = db.prepare("SELECT left_top_at FROM order_seen WHERE order_id=?").get("a") as {
    left_top_at: string | null;
  };
  assert.ok(gone.left_top_at, "b dropped off the top five");
  assert.equal(stayed.left_top_at, null, "a is still on the book");

  // b comes back.
  recordOrders(db, [{ order: b, rank: 2 }]);
  const back = db.prepare("SELECT left_top_at FROM order_seen WHERE order_id=?").get("b") as {
    left_top_at: string | null;
  };
  assert.equal(back.left_top_at, null, "reappearing must clear the flag");
  db.close();
});

test("a sweep records one snapshot per item and is idempotent", () => {
  const db = seed();
  db.prepare("INSERT INTO sweep (kind, started_at) VALUES ('top', ?)").run("2026-09-10T00:00:00Z");
  const rows = [summariseTop("blade", { sell: [order("s", "blade", "sell", 9)], buy: [] })];

  insertSnapshots(db, 1, rows);
  insertSnapshots(db, 1, rows); // a resumed sweep re-visiting the same item

  const n = db.prepare("SELECT COUNT(*) c FROM snapshot").get() as { c: number };
  assert.equal(n.c, 1, "unique(item_id, sweep_id) makes resumption safe");
  db.close();
});

test("variants are priced as separate markets", () => {
  // A ranked mod: cheap unranked asks, expensive maxed bids. Blending them
  // produces a spread between two different goods.
  const top: TopOrders = {
    sell: [
      { ...order("s1", "mod", "sell", 20), rank: 0, subtype: "regular" },
      { ...order("s2", "mod", "sell", 24), rank: 0, subtype: "regular" },
    ],
    buy: [{ ...order("b1", "mod", "buy", 85), rank: 10, subtype: "regular" }],
  };

  const rows = summariseByVariant("mod", top);
  assert.equal(rows.length, 2, "one row per variant");

  // "regular" is dropped as the neutral subtype so orders and history agree.
  const unranked = rows.find((r) => r.variant === "r0")!;
  const maxed = rows.find((r) => r.variant === "r10")!;

  assert.equal(unranked.lowSell, 20);
  assert.equal(unranked.highBuy, null, "no bids exist for the unranked version");
  assert.equal(maxed.highBuy, 85);
  assert.equal(maxed.lowSell, null, "and no asks for the maxed one");
});

test("an item without variants stays a single market", () => {
  const top: TopOrders = {
    sell: [order("s1", "set", "sell", 60)],
    buy: [order("b1", "set", "buy", 45)],
  };
  const rows = summariseByVariant("set", top);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.variant, "");
  assert.equal(rows[0]!.lowSell, 60);
  assert.equal(rows[0]!.highBuy, 45);
});

test("re-observing an order corrects a variant recorded before it was understood", () => {
  const db = seed();
  const o = order("o1", "blade", "sell", 285);

  // As the pre-variant sweep stored it.
  recordOrders(db, [{ order: o, rank: 0 }]);
  assert.equal(
    (db.prepare("SELECT variant FROM order_seen WHERE order_id='o1'").get() as { variant: string })
      .variant,
    "",
  );

  // Seen again, now with its rank known.
  recordOrders(db, [{ order: { ...o, rank: 3 }, rank: 0 }]);
  const row = db.prepare("SELECT variant, sightings FROM order_seen WHERE order_id='o1'").get() as {
    variant: string;
    sightings: number;
  };
  assert.equal(row.variant, "r3", "a stale key would hide this ask from its own market");
  assert.equal(row.sightings, 2);
  db.close();
});

test("an item with no orders still records that it was visited", () => {
  const rows = summariseByVariant("dead", { sell: [], buy: [] });
  assert.equal(rows.length, 1, "grouping alone would emit nothing at all");
  assert.equal(rows[0]!.variant, "");
  assert.equal(rows[0]!.lowSell, null);
  assert.equal(rows[0]!.sellCount, 0);
  // Without this row a resumed sweep cannot tell a dead item from an unvisited
  // one, and re-fetches every dead item on every resume.
});
