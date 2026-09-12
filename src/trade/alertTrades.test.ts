import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { migrate } from "../db/migrate";
import { alertPerformance, recentAlerts } from "../web/api";
import {
  AlertTradeError,
  matchingPositions,
  outcomeConflict,
  recordAlertPurchase,
  recordAlertSale,
  recordAlertUntrackedSale,
  suggestedTarget,
} from "./alertTrades";
import { listTrades, openTrade, pnl, sellFromPosition } from "./journal";

function seeded(): Db {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO item (id, slug, name, tags) VALUES ('item-1','test_item','Test Item','[]'), ('item-2','other_item','Other Item','[]')",
  ).run();
  return db;
}

function alert(db: Db, kind: string, itemId: string, platinum: number, reference: number, profit: number, orderId: string): number {
  return Number(db.prepare(
    `INSERT INTO alert (order_id, item_id, kind, platinum, reference, profit, ingame_name, user_status, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Player', 'ingame', ?)`,
  ).run(orderId, itemId, kind, platinum, reference, profit, new Date().toISOString()).lastInsertRowid);
}

const tradeCount = (db: Db) => (db.prepare("SELECT COUNT(*) c FROM trade").get() as { c: number }).c;

test("a decimal prediction records a whole-platinum purchase, linked to its alert, exactly once", () => {
  const db = seeded();
  try {
    const id = alert(db, "underpriced_sell", "item-1", 110, 138.75, 28.75, "o1");
    const first = recordAlertPurchase(db, id, { buyPrice: 110 });
    assert.equal(first.duplicate, false);
    assert.deepEqual(recordAlertPurchase(db, id, { buyPrice: 110 }), { tradeId: first.tradeId, duplicate: true });
    assert.equal(tradeCount(db), 1, "a retry returns the trade already recorded");

    const [t] = listTrades(db);
    assert.equal(t!.buyPrice, 110);
    assert.equal(t!.expectedSell, 138.75, "the prediction is kept exact for analysis");
    assert.equal(t!.expectedMargin, 28.75);
    assert.equal(t!.targetPrice, 138, "the listing target is rounded down to whole platinum");
    assert.equal(t!.alertId, id);
    assert.equal(t!.item_slug, "test_item");
    assert.deepEqual(
      db.prepare("SELECT outcome, trade_id FROM alert_feedback WHERE alert_id = ?").get(id),
      { outcome: "bought", trade_id: first.tradeId },
    );
    assert.equal(suggestedTarget(0.4), 1);
  } finally { db.close(); }
});

test("an outcome saved without a trade is repaired in place, and a failed link leaves no trade behind", () => {
  const db = seeded();
  try {
    const old = alert(db, "underpriced_sell", "item-1", 50, 70, 20, "old");
    db.prepare("INSERT INTO alert_feedback (alert_id, outcome, recorded_at) VALUES (?, 'bought', ?)").run(old, new Date().toISOString());
    const repaired = recordAlertPurchase(db, old, { buyPrice: 50 });
    assert.equal((db.prepare("SELECT trade_id FROM alert_feedback WHERE alert_id = ?").get(old) as { trade_id: number }).trade_id, repaired.tradeId);

    const fresh = alert(db, "underpriced_sell", "item-1", 50, 70, 20, "fresh");
    db.exec("CREATE TRIGGER refuse BEFORE INSERT ON alert_feedback BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    assert.throws(() => recordAlertPurchase(db, fresh, { buyPrice: 50 }), /disk full/);
    assert.equal(tradeCount(db), 1, "the trade and its link are one transaction");
  } finally { db.close(); }
});

test("a sell alert sells part of a held position at its real cost, and every lot counts once", () => {
  const db = seeded();
  try {
    const buy = alert(db, "underpriced_sell", "item-2", 20, 35, 15, "b1");
    const { tradeId: position } = recordAlertPurchase(db, buy, { buyPrice: 20, quantity: 3, targetPrice: 35, buyWaitH: 2 });
    const sell = alert(db, "overpriced_buy", "item-2", 40, 22, 18, "s1");
    assert.deepEqual(matchingPositions(db, sell).map((p) => [p.id, p.quantity]), [[position, 3]]);

    const sale = recordAlertSale(db, sell, { tradeId: position, quantity: 2, sellPrice: 40 });
    assert.equal(recordAlertSale(db, sell, { tradeId: position, quantity: 2, sellPrice: 40 }).duplicate, true);

    const rows = listTrades(db);
    const open = rows.find((t) => t.id === position)!;
    const lot = rows.find((t) => t.id === sale.tradeId)!;
    assert.equal(open.quantity, 1);
    assert.equal(lot.quantity, 2);
    assert.equal(lot.profit, 40, "(40 - 20) x 2, from what the position cost");
    assert.equal(lot.parentTradeId, position);
    assert.equal(lot.alertId, buy, "the lot stays connected to the purchase's alert");

    // The last unit sells outside any alert; it still belongs to the buy alert.
    sellFromPosition(db, position, { sellPrice: 30 });
    const performance = alertPerformance(db);
    assert.equal(performance.realisedProfit, 50, "both lots, each once");
    assert.equal(performance.realisedLots, 2);
    const byId = new Map((recentAlerts(db) as Array<Record<string, unknown>>).map((a) => [a["id"] as number, a]));
    assert.equal(byId.get(buy)!["realised_profit"], 50);
    assert.equal(byId.get(sell)!["realised_profit"], 40);

    const report = pnl(db);
    assert.equal(report.purchases, 1);
    assert.equal(report.buyWaitSamples, 1, "lots copy the fill time but are not new samples");
    assert.equal(report.averageBuyWaitH, 2);
    const calibration = report.bySource.find((c) => c.source === "alert")!;
    assert.equal(calibration.closed, 1, "one purchase sold in two lots is one prediction");
    assert.equal(calibration.actual, 50 / 3);
  } finally { db.close(); }
});

test("an untracked sale takes its original cost, and the wrong alert or position is refused", () => {
  const db = seeded();
  try {
    const sell = alert(db, "overpriced_buy", "item-1", 40, 22, 18, "s1");
    const result = recordAlertUntrackedSale(db, sell, { buyPrice: 12, quantity: 1, sellPrice: 40 });
    assert.equal(listTrades(db).find((t) => t.id === result.tradeId)!.profit, 28);
    assert.equal(recordAlertUntrackedSale(db, sell, { buyPrice: 12, quantity: 1, sellPrice: 40 }).duplicate, true);
    assert.match(outcomeConflict(db, sell, "no_reply") ?? "", /linked to a recorded trade/);
    assert.equal(outcomeConflict(db, sell, "bought"), null);

    const status = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof AlertTradeError ? e.status : e; } };
    assert.equal(status(() => recordAlertPurchase(db, sell, { buyPrice: 1 })), 400);
    assert.equal(status(() => recordAlertPurchase(db, 9999, { buyPrice: 1 })), 404);
    const other = alert(db, "overpriced_buy", "item-1", 40, 22, 18, "s2");
    const elsewhere = openTrade(db, { itemId: "item-2", buyPrice: 10 });
    assert.equal(status(() => recordAlertSale(db, other, { tradeId: elsewhere, quantity: 1, sellPrice: 40 })), 409);
  } finally { db.close(); }
});

test("migration 12 reconnects existing partial-sale lots to their purchase and alert", () => {
  const db = seeded();
  try {
    const boughtAt = "2026-09-01T10:00:00.000Z";
    const ins = db.prepare(
      `INSERT INTO trade (id, item_id, quantity, buy_price, bought_at, sell_price, sold_at, source)
       VALUES (?, 'item-1', ?, 10, ?, ?, ?, 'alert')`,
    );
    ins.run(1, 1, boughtAt, null, null);
    ins.run(2, 2, boughtAt, 15, "2026-09-02T00:00:00.000Z");
    const id = alert(db, "underpriced_sell", "item-1", 10, 20, 10, "o1");
    db.prepare("INSERT INTO alert_feedback (alert_id, outcome, trade_id, recorded_at) VALUES (?, 'bought', 1, ?)").run(id, boughtAt);
    db.exec("UPDATE trade SET parent_trade_id = NULL, alert_id = NULL; PRAGMA user_version = 11");

    migrate(db);
    const rows = db.prepare("SELECT id, parent_trade_id AS parent, alert_id AS alert FROM trade ORDER BY id").all();
    assert.deepEqual(rows, [{ id: 1, parent: null, alert: id }, { id: 2, parent: 1, alert: id }]);
  } finally { db.close(); }
});
