import type { Db } from "../db/index";
import { openTrade, recordClosedSale, sellFromPosition } from "./journal";

/**
 * Recording what you did about a live alert, as one step.
 *
 * The page used to do this in two or three requests: create a trade, maybe
 * close it, then save the alert's outcome with the trade id. Any failure in
 * between left a trade nothing pointed at, and retrying created a second one.
 * Here the trade and the alert's outcome are written in one transaction, and
 * an alert that already has its trade returns that trade instead of another.
 */

export class AlertTradeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

interface AlertRow {
  id: number;
  item_id: string;
  variant: string;
  kind: "underpriced_sell" | "overpriced_buy";
  platinum: number;
  reference: number;
  profit: number;
  ingame_name: string;
}

export interface AlertTradeResult {
  tradeId: number;
  /** True when the alert already had this trade — a retry, not a new record. */
  duplicate: boolean;
}

/**
 * The listing price to suggest for reselling. References are medians and can
 * be decimal (138.75p); a listing cannot. Rounded down, because the reference
 * is already capped just under the cheapest competing ask.
 */
export const suggestedTarget = (reference: number): number => Math.max(1, Math.floor(reference));

function alertOf(db: Db, alertId: number, kind: AlertRow["kind"]): AlertRow {
  const alert = db.prepare("SELECT * FROM alert WHERE id = ?").get(alertId) as AlertRow | undefined;
  if (!alert) throw new AlertTradeError("alert not found", 404);
  if (alert.kind !== kind) {
    throw new AlertTradeError(
      kind === "underpriced_sell" ? "only a buy alert records a purchase" : "only a sell alert records a sale",
      400,
    );
  }
  return alert;
}

/** The trade this alert's outcome already points at, if it still exists. */
function linkedTrade(db: Db, alertId: number): number | null {
  const row = db
    .prepare(
      `SELECT t.id FROM alert_feedback af JOIN trade t ON t.id = af.trade_id
        WHERE af.alert_id = ?`,
    )
    .get(alertId) as { id: number } | undefined;
  return row?.id ?? null;
}

function linkOutcome(db: Db, alertId: number, tradeId: number): void {
  db.prepare(
    `INSERT INTO alert_feedback (alert_id, outcome, trade_id, recorded_at) VALUES (?, 'bought', ?, ?)
     ON CONFLICT(alert_id) DO UPDATE SET outcome = 'bought', trade_id = excluded.trade_id,
                                         recorded_at = excluded.recorded_at`,
  ).run(alertId, tradeId, new Date().toISOString());
}

/** "Bought" on a buy alert: an open position, linked to the alert. */
export function recordAlertPurchase(
  db: Db,
  alertId: number,
  input: { buyPrice: number; quantity?: number; targetPrice?: number; buyWaitH?: number },
): AlertTradeResult {
  return db.transaction((): AlertTradeResult => {
    const alert = alertOf(db, alertId, "underpriced_sell");
    const existing = linkedTrade(db, alertId);
    if (existing !== null) return { tradeId: existing, duplicate: true };
    const tradeId = openTrade(db, {
      itemId: alert.item_id,
      variant: alert.variant,
      quantity: input.quantity ?? 1,
      buyPrice: input.buyPrice,
      boughtFrom: alert.ingame_name,
      // The prediction stays exact for calibration; only the listing is rounded.
      expectedSell: alert.reference,
      expectedMargin: alert.profit,
      targetPrice: input.targetPrice ?? suggestedTarget(alert.reference),
      source: "alert",
      alertId,
      ...(input.buyWaitH !== undefined ? { buyWaitH: input.buyWaitH } : {}),
    });
    linkOutcome(db, alertId, tradeId);
    return { tradeId, duplicate: false };
  })();
}

export interface MatchingPosition {
  id: number;
  quantity: number;
  buyPrice: number;
  targetPrice: number | null;
  boughtAt: string;
  boughtFrom: string | null;
  source: string;
}

/** Open inventory a sell alert could be filled from: same item, same variant. */
export function matchingPositions(db: Db, alertId: number): MatchingPosition[] {
  const alert = alertOf(db, alertId, "overpriced_buy");
  return db
    .prepare(
      `SELECT id, quantity, buy_price AS buyPrice, COALESCE(target_price, expected_sell) AS targetPrice,
              bought_at AS boughtAt, bought_from AS boughtFrom, source
         FROM trade
        WHERE item_id = ? AND variant = ? AND sold_at IS NULL
        ORDER BY bought_at`,
    )
    .all(alert.item_id, alert.variant) as MatchingPosition[];
}

/** "Sold" on a sell alert, from a position you hold: profit comes from its real cost. */
export function recordAlertSale(
  db: Db,
  alertId: number,
  input: { tradeId: number; quantity: number; sellPrice: number },
): AlertTradeResult {
  return db.transaction((): AlertTradeResult => {
    const alert = alertOf(db, alertId, "overpriced_buy");
    const existing = linkedTrade(db, alertId);
    if (existing !== null) return { tradeId: existing, duplicate: true };
    const position = db
      .prepare("SELECT quantity FROM trade WHERE id = ? AND item_id = ? AND variant = ? AND sold_at IS NULL")
      .get(input.tradeId, alert.item_id, alert.variant) as { quantity: number } | undefined;
    if (!position) throw new AlertTradeError("that position is not open for this item", 409);
    if (input.quantity > position.quantity) {
      throw new AlertTradeError(`only ${position.quantity} held in that position`, 400);
    }
    const lot = sellFromPosition(db, input.tradeId, {
      sellPrice: input.sellPrice,
      quantity: input.quantity,
      soldTo: alert.ingame_name,
    })!;
    linkOutcome(db, alertId, lot);
    return { tradeId: lot, duplicate: false };
  })();
}

/**
 * "Sold" on a sell alert with nothing tracked to sell from. Only on request,
 * and only with the original cost — a sale without one has no profit.
 */
export function recordAlertUntrackedSale(
  db: Db,
  alertId: number,
  input: { buyPrice: number; quantity: number; sellPrice: number },
): AlertTradeResult {
  return db.transaction((): AlertTradeResult => {
    const alert = alertOf(db, alertId, "overpriced_buy");
    const existing = linkedTrade(db, alertId);
    if (existing !== null) return { tradeId: existing, duplicate: true };
    const tradeId = recordClosedSale(db, {
      itemId: alert.item_id,
      variant: alert.variant,
      quantity: input.quantity,
      buyPrice: input.buyPrice,
      expectedSell: alert.platinum,
      expectedMargin: alert.profit,
      source: "alert",
      alertId,
      note: "untracked sale from a live alert",
      sellPrice: input.sellPrice,
      soldTo: alert.ingame_name,
    });
    linkOutcome(db, alertId, tradeId);
    return { tradeId, duplicate: false };
  })();
}

/** An outcome other than a trade must not silently orphan a trade already recorded. */
export function outcomeConflict(db: Db, alertId: number, outcome: string): string | null {
  if (outcome === "bought") return null;
  return linkedTrade(db, alertId) === null
    ? null
    : "this alert is linked to a recorded trade; delete the trade on Trades & P&L before changing its outcome";
}
