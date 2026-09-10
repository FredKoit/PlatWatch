import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { upsertCatalog } from "../db/repo";
import { closeTrade, listTrades, openTrade, pnl } from "./journal";
import type { WfmItemSummary } from "../wfm/types";

const item = (id: string, slug: string): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags: [],
  i18n: { en: { name: slug.replace(/_/g, " ") } },
});

const nowIso = new Date().toISOString();

function seeded(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("rhino", "rhino_prime_set"), item("vectis", "vectis_prime_set")]);
  db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at) VALUES (1,'top',?,?)").run(
    nowIso,
    nowIso,
  );
  // Current market: rhino asks 70.
  db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, low_sell, high_buy,
                           sell_p50_top, sell_count, buy_count)
     VALUES ('rhino', 1, '', ?, 70, 55, 72, 5, 5)`,
  ).run(nowIso);
  return db;
}

test("an open position records cost but no profit yet", () => {
  const db = seeded();
  openTrade(db, { itemId: "rhino", buyPrice: 45, quantity: 2, source: "spread" });

  const [t] = listTrades(db);
  assert.equal(t!.profit, null, "nothing is realised until it sells");
  assert.equal(t!.marketNow, 70, "marked against the current ask");

  const p = pnl(db);
  assert.equal(p.openCount, 1);
  assert.equal(p.openCost, 90, "45 x 2 tied up");
  assert.equal(p.openMarkToMarket, 50, "(70 - 45) x 2, unrealised");
  assert.equal(p.realised, 0);
  db.close();
});

test("closing a position realises profit per unit", () => {
  const db = seeded();
  const id = openTrade(db, { itemId: "rhino", buyPrice: 45, quantity: 3 });
  closeTrade(db, id, { sellPrice: 65, soldTo: "Buyer" });

  const [t] = listTrades(db);
  assert.equal(t!.profit, 60, "(65 - 45) x 3");
  assert.equal(t!.soldTo, "Buyer");

  const p = pnl(db);
  assert.equal(p.realised, 60);
  assert.equal(p.openCost, 0, "the position is no longer tying up platinum");
  assert.equal(p.closedCount, 1);
  db.close();
});

test("a losing trade is recorded as a loss, not dropped", () => {
  const db = seeded();
  const a = openTrade(db, { itemId: "rhino", buyPrice: 60 });
  const b = openTrade(db, { itemId: "vectis", buyPrice: 100 });
  closeTrade(db, a, { sellPrice: 80 });
  closeTrade(db, b, { sellPrice: 85 });

  const p = pnl(db);
  assert.equal(p.realised, 5, "+20 and -15 net to +5");
  assert.equal(p.wins, 1);
  assert.equal(p.losses, 1);
  assert.equal(p.winRate, 0.5);
  db.close();
});

test("calibration compares predicted margin against realised", () => {
  const db = seeded();
  // The tool promised 30p a unit on spreads; reality delivered 15p.
  for (const sell of [60, 60]) {
    const id = openTrade(db, {
      itemId: "rhino",
      buyPrice: 45,
      expectedMargin: 30,
      source: "spread",
    });
    closeTrade(db, id, { sellPrice: sell });
  }
  // Set arbitrage promised 20p and delivered it.
  const s = openTrade(db, {
    itemId: "vectis",
    buyPrice: 100,
    expectedMargin: 20,
    source: "set",
  });
  closeTrade(db, s, { sellPrice: 120 });

  const bySource = pnl(db).bySource;
  const spread = bySource.find((c) => c.source === "spread")!;
  const set = bySource.find((c) => c.source === "set")!;

  assert.equal(spread.expected, 30);
  assert.equal(spread.actual, 15);
  assert.equal(spread.ratio, 0.5, "spread trades realise half what they promise");

  assert.equal(set.ratio, 1, "set arbitrage lands where predicted");
  db.close();
});

test("calibration is per unit, so a bulk trade does not skew it", () => {
  const db = seeded();
  const bulk = openTrade(db, {
    itemId: "rhino",
    buyPrice: 45,
    quantity: 10,
    expectedMargin: 20,
    source: "spread",
  });
  closeTrade(db, bulk, { sellPrice: 65 });

  const spread = pnl(db).bySource.find((c) => c.source === "spread")!;
  assert.equal(spread.actual, 20, "200p over ten units is 20p a unit, not 200");
  assert.equal(spread.ratio, 1);
  db.close();
});

test("open positions sort ahead of closed ones", () => {
  const db = seeded();
  const done = openTrade(db, { itemId: "rhino", buyPrice: 40 });
  closeTrade(db, done, { sellPrice: 50 });
  openTrade(db, { itemId: "vectis", buyPrice: 90 });

  const rows = listTrades(db);
  assert.equal(rows[0]!.profit, null, "what still needs action comes first");
  assert.equal(rows[1]!.profit, 10);
  db.close();
});

test("closing an already-closed trade does not overwrite it", () => {
  const db = seeded();
  const id = openTrade(db, { itemId: "rhino", buyPrice: 40 });
  closeTrade(db, id, { sellPrice: 60 });
  closeTrade(db, id, { sellPrice: 999 });

  assert.equal(listTrades(db)[0]!.sellPrice, 60, "a settled trade is a record, not a draft");
  db.close();
});

test("an empty journal reports nothing rather than dividing by zero", () => {
  const db = seeded();
  const p = pnl(db);
  assert.equal(p.realised, 0);
  assert.equal(p.winRate, null);
  assert.equal(p.medianHoldH, null);
  assert.deepEqual(p.bySource, []);
  db.close();
});

test("a sell price identical to the prediction is counted, not trusted", () => {
  const db = seeded();
  // Logged while the form pre-filled the sell field with the prediction: the
  // ratio is 1.00 by construction rather than by discovery.
  const rigged = openTrade(db, {
    itemId: "rhino",
    buyPrice: 45,
    expectedSell: 65,
    expectedMargin: 20,
    source: "spread",
  });
  closeTrade(db, rigged, { sellPrice: 65 });

  // Entered by hand, landing somewhere other than the prediction.
  const real = openTrade(db, {
    itemId: "vectis",
    buyPrice: 100,
    expectedSell: 130,
    expectedMargin: 30,
    source: "spread",
  });
  closeTrade(db, real, { sellPrice: 118 });

  const c = pnl(db).bySource.find((x) => x.source === "spread")!;
  assert.equal(c.closed, 2);
  assert.equal(c.exactMatches, 1, "half this sample cannot corroborate the ratio");
  assert.equal(c.expected, 25);
  assert.equal(c.actual, 19, "(20 + 18) / 2");
});
