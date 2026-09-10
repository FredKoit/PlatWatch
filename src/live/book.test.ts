import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { upsertCatalog } from "../db/repo";
import { applyLiveOrders, LIVE_WINDOW_MS } from "./book";
import type { UserStatus, WfmItemSummary, WfmOrder } from "../wfm/types";

const NOW = Date.parse("2026-09-10T12:00:00Z");

const item = (id: string, slug: string): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags: [],
  i18n: { en: { name: slug } },
});

const order = (
  type: "sell" | "buy",
  platinum: number,
  over: Partial<WfmOrder> = {},
): WfmOrder => ({
  id: `o-${type}-${platinum}-${Math.random()}`,
  type,
  platinum,
  quantity: 1,
  perTrade: 1,
  visible: true,
  createdAt: "2026-09-10T11:59:00Z",
  updatedAt: "2026-09-10T11:59:00Z",
  itemId: "rhino",
  user: {
    id: "u1",
    ingameName: "Tenno",
    slug: "tenno",
    reputation: 5,
    platform: "pc",
    crossplay: true,
    locale: "en",
    status: "ingame" as UserStatus,
  },
  ...over,
});

function seeded(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("rhino", "rhino_prime_set")]);
  return db;
}

const book = (db: Db) =>
  db.prepare("SELECT * FROM live_book WHERE item_id='rhino'").get() as
    | { low_sell: number | null; high_buy: number | null; low_sell_at: string | null; variant: string }
    | undefined;

test("a cheaper ask replaces what we hold", () => {
  const db = seeded();
  applyLiveOrders(db, [order("sell", 60)], NOW);
  applyLiveOrders(db, [order("sell", 50)], NOW + 1000);
  assert.equal(book(db)!.low_sell, 50);
  db.close();
});

test("a dearer ask does not", () => {
  const db = seeded();
  applyLiveOrders(db, [order("sell", 50)], NOW);
  applyLiveOrders(db, [order("sell", 90)], NOW + 1000);
  assert.equal(book(db)!.low_sell, 50, "someone listing high says nothing about the best ask");
  db.close();
});

test("an expired observation is replaced at any price", () => {
  const db = seeded();
  applyLiveOrders(db, [order("sell", 50)], NOW);
  // The 50p order is long gone; a 90p listing is now the better evidence.
  applyLiveOrders(db, [order("sell", 90)], NOW + LIVE_WINDOW_MS + 1000);
  assert.equal(book(db)!.low_sell, 90, "stale certainty is worse than fresh uncertainty");
  db.close();
});

test("the bid side moves the other way", () => {
  const db = seeded();
  applyLiveOrders(db, [order("buy", 40)], NOW);
  applyLiveOrders(db, [order("buy", 55)], NOW + 1000);
  applyLiveOrders(db, [order("buy", 45)], NOW + 2000);
  assert.equal(book(db)!.high_buy, 55);
  db.close();
});

test("both sides are tracked independently on one row", () => {
  const db = seeded();
  applyLiveOrders(db, [order("sell", 60), order("buy", 45)], NOW);
  const b = book(db)!;
  assert.equal(b.low_sell, 60);
  assert.equal(b.high_buy, 45);
  db.close();
});

test("variants keep separate books", () => {
  const db = seeded();
  applyLiveOrders(db, [order("sell", 20, { rank: 0 }), order("sell", 90, { rank: 10 })], NOW);
  const rows = db
    .prepare("SELECT variant, low_sell FROM live_book ORDER BY variant")
    .all() as Array<{ variant: string; low_sell: number }>;
  assert.deepEqual(rows, [
    { variant: "r0", low_sell: 20 },
    { variant: "r10", low_sell: 90 },
  ]);
  db.close();
});

test("invisible orders are ignored", () => {
  const db = seeded();
  applyLiveOrders(db, [order("sell", 5, { visible: false })], NOW);
  assert.equal(book(db), undefined);
  db.close();
});
