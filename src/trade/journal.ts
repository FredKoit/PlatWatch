import type { Db } from "../db/index";
import { latestSweepId } from "../rank/query";
import { sellAdvice, type SellAdvice } from "../rank/sell";
import { LIVE_OVERLAY, liveCutoff } from "../live/book";

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
  source?: "spread" | "set" | "alert" | "manual";
  note?: string;
}

export function openTrade(db: Db, t: OpenTradeInput): number {
  const info = db
    .prepare(
      `INSERT INTO trade
         (item_id, variant, quantity, buy_price, bought_at, bought_from,
          expected_sell, expected_margin, source, note)
       VALUES (@itemId, @variant, @quantity, @buyPrice, @boughtAt, @boughtFrom,
               @expectedSell, @expectedMargin, @source, @note)`,
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
      source: t.source ?? "manual",
      note: t.note ?? null,
    });
  return Number(info.lastInsertRowid);
}

export function closeTrade(
  db: Db,
  id: number,
  sell: { sellPrice: number; soldTo?: string },
): void {
  db.prepare(
    `UPDATE trade
        SET sell_price = @sellPrice,
            sold_at    = @soldAt,
            sold_to    = @soldTo
      WHERE id = @id AND sold_at IS NULL`,
  ).run({
    id,
    sellPrice: sell.sellPrice,
    soldAt: new Date().toISOString(),
    soldTo: sell.soldTo ?? null,
  });
}

export function deleteTrade(db: Db, id: number): void {
  db.prepare("DELETE FROM trade WHERE id = ?").run(id);
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
}

export function listTrades(db: Db, limit = 100): TradeRow[] {
  const sweepId = latestSweepId(db);
  const rows = db
    .prepare(
      `SELECT t.id, t.item_id AS itemId, i.name, t.variant, t.quantity,
              t.buy_price AS buyPrice, t.bought_at AS boughtAt,
              t.bought_from AS boughtFrom,
              t.sell_price AS sellPrice, t.sold_at AS soldAt, t.sold_to AS soldTo,
              t.expected_sell AS expectedSell, t.expected_margin AS expectedMargin,
              t.source, t.note,
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
    .all({ sweep: sweepId, limit, liveCutoff: liveCutoff() }) as Array<
      Omit<TradeRow, "profit" | "heldH" | "advice">
    >;

  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    profit: r.sellPrice === null ? null : (r.sellPrice - r.buyPrice) * r.quantity,
    heldH: Number(
      (((r.soldAt ? Date.parse(r.soldAt) : now) - Date.parse(r.boughtAt)) / 3_600_000).toFixed(1),
    ),
    advice: r.soldAt === null ? sellAdvice(db, r.itemId, r.variant) : null,
  }));
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
  /** Mean margin actually realised per unit. */
  actual: number | null;
  /** actual / expected. Below 1 means the tool is optimistic. */
  ratio: number | null;
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
  medianHoldH: number | null;
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

  const sources = [...new Set(closed.map((t) => t.source))];
  const bySource: Calibration[] = sources.map((source) => {
    const group = closed.filter((t) => t.source === source);
    // Per unit, so a five-unit trade does not outweigh a single one.
    const expected = mean(
      group.filter((t) => t.expectedMargin !== null).map((t) => t.expectedMargin!),
    );
    const actual = mean(group.map((t) => t.profit! / t.quantity));
    return {
      source,
      closed: group.length,
      exactMatches: group.filter(
        (t) => t.expectedSell !== null && t.sellPrice === t.expectedSell,
      ).length,
      expected,
      actual,
      ratio: expected !== null && actual !== null && expected !== 0 ? actual / expected : null,
    };
  });

  return {
    realised,
    closedCount: closed.length,
    wins,
    losses,
    winRate: closed.length ? wins / closed.length : null,
    openCost,
    openCount: open.length,
    openMarkToMarket: openMark,
    medianHoldH: median(closed.map((t) => t.heldH)),
    bySource,
  };
}
