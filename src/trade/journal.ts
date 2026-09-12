import type { Db } from "../db/index";
import { latestSweepId } from "../rank/query";
import { sellAdvice, type SellAdvice } from "../rank/sell";
import { LIVE_OVERLAY, liveCutoff } from "../live/book";
import { calibrationFactor, calibrationNote, type StrategyFactor } from "./calibration";
import { evaluatePositions, type ExitSignal } from "./exits";

/**
 * The trade journal.
 *
 * Two jobs. The obvious one is telling you whether you made money. The more
 * useful one is calibration: every threshold in the ranking and alert policies
 * is currently a guess, and comparing what the tool predicted against what
 * actually happened is the only way to replace those guesses with evidence.
 */

export interface OpenTradeInput {
  itemId: string;
  variant?: string;
  quantity?: number;
  buyPrice: number;
  boughtFrom?: string;
  expectedSell?: number;
  expectedMargin?: number;
  /** What you mean to sell at; exit alerts fire against it. Defaults to expectedSell. */
  targetPrice?: number;
  source?: "spread" | "set" | "alert" | "manual";
  note?: string;
  /** Hours between posting a buy order and it filling. */
  buyWaitH?: number;
}

function audit(db: Db, tradeId: number, action: string, before: unknown, after: unknown, note?: string): void {
  db.prepare("INSERT INTO trade_audit(trade_id,action,before_json,after_json,note,created_at) VALUES(?,?,?,?,?,?)")
    .run(tradeId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note ?? null, new Date().toISOString());
}

export function openTrade(db: Db, t: OpenTradeInput): number {
  const info = db
    .prepare(
      `INSERT INTO trade
         (item_id, variant, quantity, buy_price, bought_at, bought_from,
          expected_sell, expected_margin, target_price, source, note, buy_wait_h)
       VALUES (@itemId, @variant, @quantity, @buyPrice, @boughtAt, @boughtFrom,
               @expectedSell, @expectedMargin, @targetPrice, @source, @note, @buyWaitH)`,
    )
    .run({
      itemId: t.itemId,
      variant: t.variant ?? "",
      quantity: t.quantity ?? 1,
      buyPrice: t.buyPrice,
      boughtAt: new Date().toISOString(),
      boughtFrom: t.boughtFrom ?? null,
      expectedSell: t.expectedSell ?? null,
      expectedMargin: t.expectedMargin ?? null,
      targetPrice: t.targetPrice ?? null,
      source: t.source ?? "manual",
      note: t.note ?? null,
      buyWaitH: t.buyWaitH ?? null,
    });
  const id = Number(info.lastInsertRowid);
  audit(db, id, "opened", null, db.prepare("SELECT * FROM trade WHERE id=?").get(id));
  return id;
}

/**
 * Change what an open position is meant to sell at.
 *
 * The signals it had already sent were measured against the old target, so
 * they are forgotten — a bid at the new target must be able to fire.
 * expected_sell is deliberately untouched: it is the prediction calibration
 * measures, and moving it after the fact would grade the tool on a revised
 * answer.
 */
export function setTradeTarget(db: Db, id: number, targetPrice: number): boolean {
  return db.transaction(() => {
    const before = db.prepare("SELECT * FROM trade WHERE id=?").get(id);
    const changed = db
      .prepare("UPDATE trade SET target_price = ? WHERE id = ? AND sold_at IS NULL")
      .run(targetPrice, id).changes;
    if (changed) {
      db.prepare("DELETE FROM exit_alert WHERE trade_id = ? AND kind IN ('target_bid','undercut')").run(id);
      audit(db, id, "target_changed", before, db.prepare("SELECT * FROM trade WHERE id=?").get(id));
    }
    return changed > 0;
  })();
}

export function closeTrade(
  db: Db,
  id: number,
  sell: { sellPrice: number; soldTo?: string; quantity?: number },
): boolean {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM trade WHERE id = ? AND sold_at IS NULL").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false;
    const held = Number(row["quantity"]);
    const quantity = sell.quantity ?? held;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > held) {
      throw new RangeError(`quantity must be an integer from 1 to ${held}`);
    }
    const soldAt = new Date().toISOString();
    if (quantity === held) {
      db.prepare(
        `UPDATE trade SET sell_price = ?, sold_at = ?, sold_to = ? WHERE id = ?`,
      ).run(sell.sellPrice, soldAt, sell.soldTo ?? null, id);
    } else {
      // Keep the original row open so its target and exit alerts continue to
      // describe the remaining inventory. The sold portion becomes an exact
      // closed lot with the same per-unit cost and original prediction.
      db.prepare("UPDATE trade SET quantity = ? WHERE id = ?").run(held - quantity, id);
      db.prepare(
        `INSERT INTO trade
           (item_id, variant, quantity, buy_price, bought_at, bought_from,
            sell_price, sold_at, sold_to, expected_sell, expected_margin,
            source, note, target_price, buy_wait_h)
         SELECT item_id, variant, @quantity, buy_price, bought_at, bought_from,
                @sellPrice, @soldAt, @soldTo, expected_sell, expected_margin,
                source, note, target_price, buy_wait_h
           FROM trade WHERE id = @id`,
      ).run({ id, quantity, sellPrice: sell.sellPrice, soldAt, soldTo: sell.soldTo ?? null });
      // Re-evaluate signals against the smaller remaining position.
      db.prepare("DELETE FROM exit_alert WHERE trade_id = ?").run(id);
    }
    audit(db, id, quantity === held ? "closed" : "partial_sale", row, db.prepare("SELECT * FROM trade WHERE id=?").get(id));
    return true;
  })();
}

export function deleteTrade(db: Db, id: number): boolean {
  const before = db.prepare("SELECT * FROM trade WHERE id=?").get(id);
  if (!before) return false;
  audit(db, id, "deleted", before, null);
  return db.prepare("DELETE FROM trade WHERE id = ?").run(id).changes > 0;
}

export function correctTrade(db: Db, id: number, values: { quantity: number; buyPrice: number; note?: string }): boolean {
  return db.transaction(() => {
    const before = db.prepare("SELECT * FROM trade WHERE id=?").get(id);
    if (!before) return false;
    db.prepare("UPDATE trade SET quantity=?, buy_price=?, note=? WHERE id=?")
      .run(values.quantity, values.buyPrice, values.note ?? null, id);
    audit(db,id,"corrected",before,db.prepare("SELECT * FROM trade WHERE id=?").get(id),values.note);
    return true;
  })();
}

export interface TradeAuditRow {
  id: number; tradeId: number; action: string; beforeJson: string | null;
  afterJson: string | null; note: string | null; createdAt: string;
}

export function tradeAudit(db: Db, id: number): TradeAuditRow[] {
  return db.prepare("SELECT id,trade_id AS tradeId,action,before_json AS beforeJson,after_json AS afterJson,note,created_at AS createdAt FROM trade_audit WHERE trade_id=? ORDER BY id DESC").all(id) as TradeAuditRow[];
}

export interface TradeRow {
  id: number;
  itemId: string;
  name: string;
  variant: string;
  quantity: number;
  buyPrice: number;
  boughtAt: string;
  boughtFrom: string | null;
  sellPrice: number | null;
  soldAt: string | null;
  soldTo: string | null;
  expectedSell: number | null;
  expectedMargin: number | null;
  source: string;
  note: string | null;
  buyWaitH: number | null;
  /** Realised for closed trades; null while open. */
  profit: number | null;
  /** Current market ask for an open position — an unrealised mark, not a quote. */
  marketNow: number | null;
  /** Hours held, or hours open so far. */
  heldH: number;
  /**
   * What to list it at. Only computed for OPEN positions — the sell leg is
   * where platinum sits waiting, and it is the only part of the trade the tool
   * previously said nothing about.
   */
  advice: SellAdvice | null;
  /** What it is meant to sell at: the target you set, else the model's expected sell. */
  targetPrice: number | null;
  /** Exit signals for an open position; empty once closed. */
  exits: ExitSignal[];
  /** A single next action distilled from the book, history, and exit signals. */
  sellDecision: SellDecision | null;
}

export type SellDecisionKind = "sell_now" | "reprice" | "hold" | "list" | "review";
export interface SellDecision {
  kind: SellDecisionKind;
  label: string;
  detail: string;
  price: number | null;
}

export function decideSellAction(
  trade: Pick<TradeRow, "buyPrice" | "targetPrice" | "heldH">,
  advice: SellAdvice | null,
  exits: ExitSignal[],
): SellDecision {
  const bid = exits.find((x) => x.kind === "target_bid");
  if (bid) return { kind: "sell_now", label: "Sell now", detail: bid.detail, price: bid.value };

  const stale = exits.find((x) => x.kind === "stale");
  if (stale) {
    return {
      kind: "review",
      label: "Free the platinum",
      detail: advice?.quickPrice != null
        ? `${stale.detail}. Reprice to ${advice.quickPrice}p for a quicker exit.`
        : stale.detail,
      price: advice?.quickPrice ?? null,
    };
  }

  const undercut = exits.find((x) => x.kind === "undercut");
  if (undercut && advice) {
    const abnormal = advice.tradedLow !== null && advice.quickPrice !== null &&
      advice.quickPrice < advice.tradedLow * 0.9;
    if (abnormal) {
      return {
        kind: "hold",
        label: "Hold price",
        detail: `The cheapest ask is well below the recent trading range (${Math.round(advice.tradedLow!)}p typical low); avoid chasing it yet.`,
        price: trade.targetPrice,
      };
    }
    return {
      kind: "reprice",
      label: "Reprice",
      detail: `${undercut.detail}. Move to ${advice.quickPrice ?? advice.fairPrice}p to regain visibility.`,
      price: advice.quickPrice ?? advice.fairPrice,
    };
  }

  if (trade.targetPrice !== null) {
    return {
      kind: "hold",
      label: "Keep listed",
      detail: advice?.estimatedDaysAtFair == null
        ? `Keep the ${trade.targetPrice}p target while the market develops.`
        : `No action needed; about ${advice.estimatedDaysAtFair}d expected at fair value.`,
      price: trade.targetPrice,
    };
  }
  return {
    kind: "list",
    label: "List it",
    detail: advice?.fairPrice == null ? "Set a target when current pricing becomes available." : `List around ${advice.fairPrice}p based on the live book and completed trades.`,
    price: advice?.fairPrice ?? null,
  };
}

export function listTrades(db: Db, limit = 100, now = Date.now()): TradeRow[] {
  const sweepId = latestSweepId(db);
  const rows = db
    .prepare(
      `SELECT t.id, t.item_id AS itemId, i.name, t.variant, t.quantity,
              t.buy_price AS buyPrice, t.bought_at AS boughtAt,
              t.bought_from AS boughtFrom,
              t.sell_price AS sellPrice, t.sold_at AS soldAt, t.sold_to AS soldTo,
              t.expected_sell AS expectedSell, t.expected_margin AS expectedMargin,
              COALESCE(t.target_price, t.expected_sell) AS targetPrice,
              t.source, t.note, t.buy_wait_h AS buyWaitH,
              -- Live overlay: what a watchlist refresh or the feed saw since the
              -- sweep. Without it, starring an open position changed nothing here.
              ${LIVE_OVERLAY.lowSell} AS marketNow
         FROM trade t
         JOIN item i ON i.id = t.item_id
         LEFT JOIN snapshot s ON s.item_id = t.item_id AND s.variant = t.variant
                             AND s.sweep_id = @sweep
         LEFT JOIN live_book lb ON lb.item_id = t.item_id AND lb.variant = t.variant
        ORDER BY t.sold_at IS NOT NULL, t.bought_at DESC
        LIMIT @limit`,
    )
    .all({ sweep: sweepId, limit, liveCutoff: liveCutoff(now) }) as Array<
      Omit<TradeRow, "profit" | "heldH" | "advice" | "exits" | "sellDecision">
    >;

  const heldH = (r: { soldAt: string | null; boughtAt: string }) =>
    ((r.soldAt ? Date.parse(r.soldAt) : now) - Date.parse(r.boughtAt)) / 3_600_000;

  const open = rows.filter((r) => r.soldAt === null);
  const exits = evaluatePositions(
    db,
    open.map((r) => ({
      tradeId: r.id,
      itemId: r.itemId,
      variant: r.variant,
      name: r.name,
      quantity: r.quantity,
      target: r.targetPrice,
      heldH: heldH(r),
    })),
    now,
  );

  return rows.map((r) => {
    const hours = Number(heldH(r).toFixed(1));
    const advice = r.soldAt === null ? sellAdvice(db, r.itemId, r.variant) : null;
    const signals = exits.get(r.id) ?? [];
    return {
      ...r,
      profit: r.sellPrice === null ? null : (r.sellPrice - r.buyPrice) * r.quantity,
      heldH: hours,
      advice,
      exits: signals,
      sellDecision: r.soldAt === null
        ? decideSellAction({ buyPrice: r.buyPrice, targetPrice: r.targetPrice, heldH: hours }, advice, signals)
        : null,
    };
  });
}

export interface Calibration {
  source: string;
  closed: number;
  /**
   * Closed trades whose sell price exactly equals the prediction.
   *
   * Early rows were logged when the sell field defaulted to `expectedSell`, so
   * a perfect match could mean the form filled itself in. A genuine sale at the
   * predicted price looks the same, so this is a caution, not a verdict — but a
   * ratio of 1.00 built mostly from these says nothing about the market.
   */
  exactMatches: number;
  /** Mean margin the tool predicted per unit. */
  expected: number | null;
  /** Mean realised margin per unit, using only trades with a predicted margin. */
  actual: number | null;
  /** actual / expected. Below 1 means the tool is optimistic. */
  ratio: number | null;
  /** What this record does to the strategy's expected profit in the rankings. */
  factor: number;
  note: string;
}

interface ClosedTrade {
  source: string;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  expectedSell: number | null;
  expectedMargin: number | null;
}

/**
 * The calibration table, from closed trades. Pure, so the rankings and the
 * journal read the same numbers.
 */
export function calibrate(closed: ClosedTrade[]): Calibration[] {
  const sources = [...new Set(closed.map((t) => t.source))];
  return sources.map((source) => {
    const group = closed.filter((t) => t.source === source);
    const comparable = group.filter((t) => t.expectedMargin !== null);
    // Per unit, so a five-unit trade does not outweigh a single one.
    // Both means must describe the same trades. Unpredicted wins/losses belong
    // in total P&L, but cannot measure how accurate a prediction was.
    const expected = mean(comparable.map((t) => t.expectedMargin!));
    const actual = mean(comparable.map((t) => t.sellPrice - t.buyPrice));
    const ratio =
      expected !== null && actual !== null && expected !== 0 ? actual / expected : null;
    // Only trades that carried a prediction can say anything about one.
    const measured = comparable.length;
    const factor = calibrationFactor(measured, ratio);
    return {
      source,
      closed: group.length,
      exactMatches: group.filter(
        (t) => t.expectedSell !== null && t.sellPrice === t.expectedSell,
      ).length,
      expected,
      actual,
      ratio,
      factor,
      note: calibrationNote(source, measured, ratio, factor),
    };
  });
}

/** Each strategy's factor for the rankings — read straight from closed trades. */
export function strategyCalibration(db: Db): Map<string, StrategyFactor> {
  const closed = db
    .prepare(
      `SELECT source, quantity, buy_price AS buyPrice, sell_price AS sellPrice,
              expected_sell AS expectedSell, expected_margin AS expectedMargin
         FROM trade WHERE sold_at IS NOT NULL AND sell_price IS NOT NULL`,
    )
    .all() as ClosedTrade[];
  return new Map(
    calibrate(closed).map((c) => [c.source, { factor: c.factor, closed: c.closed, note: c.note }]),
  );
}

export interface Pnl {
  realised: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Platinum currently tied up in open positions. */
  openCost: number;
  openCount: number;
  /** Marked against the latest sweep. Unrealised and unreliable, by nature. */
  openMarkToMarket: number | null;
  /** Gross platinum value of open inventory at the current ask. */
  openMarketValue: number | null;
  /** Profit if all positions sell at their current target. */
  expectedOpenProfit: number | null;
  /** Capital in positions currently flagged as stale. */
  staleCost: number;
  realised7d: number;
  realised30d: number;
  averageHoldH: number | null;
  capitalReturn: number | null;
  medianHoldH: number | null;
  averageBuyWaitH: number | null;
  buyWaitSamples: number;
  bySource: Calibration[];
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Profit and loss, plus the calibration table.
 *
 * `bySource` is the point of the whole journal: if spread trades realise half
 * the margin they promise while set arbitrage lands close, that is a fact about
 * the policy, not a hunch — and it says which number to change.
 */
export function pnl(db: Db): Pnl {
  const trades = listTrades(db, 10_000);
  const closed = trades.filter((t) => t.profit !== null);
  const open = trades.filter((t) => t.profit === null);

  const realised = closed.reduce((sum, t) => sum + t.profit!, 0);
  const wins = closed.filter((t) => t.profit! > 0).length;
  const losses = closed.filter((t) => t.profit! < 0).length;

  const openCost = open.reduce((sum, t) => sum + t.buyPrice * t.quantity, 0);
  const marks = open.filter((t) => t.marketNow !== null);
  const openMark = marks.length
    ? marks.reduce((sum, t) => sum + (t.marketNow! - t.buyPrice) * t.quantity, 0)
    : null;
  const openMarketValue = marks.length
    ? marks.reduce((sum, t) => sum + t.marketNow! * t.quantity, 0)
    : null;
  const targeted = open.filter((t) => t.targetPrice !== null);
  const expectedOpenProfit = targeted.length
    ? targeted.reduce((sum, t) => sum + (t.targetPrice! - t.buyPrice) * t.quantity, 0)
    : null;
  const staleCost = open
    .filter((t) => t.exits.some((x) => x.kind === "stale"))
    .reduce((sum, t) => sum + t.buyPrice * t.quantity, 0);
  const soldSince = (days: number) => closed
    .filter((t) => t.soldAt !== null && Date.parse(t.soldAt) >= Date.now() - days * 86_400_000)
    .reduce((sum, t) => sum + t.profit!, 0);
  const closedCost = closed.reduce((sum, t) => sum + t.buyPrice * t.quantity, 0);

  const bySource = calibrate(
    closed.map((t) => ({
      source: t.source,
      quantity: t.quantity,
      buyPrice: t.buyPrice,
      sellPrice: t.sellPrice!,
      expectedSell: t.expectedSell,
      expectedMargin: t.expectedMargin,
    })),
  );

  return {
    realised,
    closedCount: closed.length,
    wins,
    losses,
    winRate: closed.length ? wins / closed.length : null,
    openCost,
    openCount: open.length,
    openMarkToMarket: openMark,
    openMarketValue,
    expectedOpenProfit,
    staleCost,
    realised7d: soldSince(7),
    realised30d: soldSince(30),
    averageHoldH: mean(closed.map((t) => t.heldH)),
    capitalReturn: closedCost > 0 ? realised / closedCost : null,
    medianHoldH: median(closed.map((t) => t.heldH)),
    averageBuyWaitH: mean(trades.flatMap((t) => t.buyWaitH === null ? [] : [t.buyWaitH])),
    buyWaitSamples: trades.filter((t) => t.buyWaitH !== null).length,
    bySource,
  };
}
