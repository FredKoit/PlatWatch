import { getMeta, type Db } from "../db/index";
import { schedulerHealth } from "../daemon/scheduler";
import { latestSweepId, setRows, spreadRows } from "../rank/query";
import {
  DEFAULT_POLICY,
  rank,
  scoreSet,
  scoreSpread,
  sortKey,
  trendOf,
  type Opportunity,
  type RankingPolicy,
  type SetInput,
  type SortBy,
} from "../rank/score";
import { whisperFor } from "../live/detect";
import { liveCutoff } from "../live/book";
import { REACHABLE_ORDER, actionableSweepCutoff } from "../rank/depth";
import { keyOf, planTrades, type Plan, type PlanSort } from "../rank/plan";
import type { Confidence } from "../rank/timing";
import { strategyCalibration } from "../trade/journal";
import { calibrated, type StrategyFactor } from "../trade/calibration";

/**
 * Everything the UI reads. Kept separate from the HTTP layer so the queries can
 * be tested without a server.
 */

export interface Counterparty {
  userId: string;
  ingameName: string;
  platinum: number;
  /** Sightings and reply history, so you can prefer people who answer. */
  sent: number;
  replied: number;
  replyRate: number | null;
}

/** One seller a part is bought from — more than one when the cheapest has too few. */
export interface PartFill {
  orderId: string;
  stock: number;
  seller: Counterparty;
  units: number;
  platinum: number;
  /** The seller's status when last seen: ingame, online, or null if unrecorded. */
  status: string | null;
  whisper: string;
}

/** One line of a set's shopping list. */
export interface SetPart {
  itemId: string;
  item_slug: string;
  name: string;
  qty: number;
  /** Cheapest reachable ask per unit. */
  each: number | null;
  /**
   * What the whole quantity costs, bought up the reachable book. The lines
   * always sum to the set's `buyAt`. Null when too few units are on sale.
   */
  subtotal: number | null;
  /** Units on sale from reachable sellers, up to the quantity needed. */
  available: number;
  volume48h: number | null;
  fills: PartFill[];
  /** The first fill's seller and whisper — the one to message first. */
  seller: Counterparty | null;
  whisper: string | null;
}

/** @deprecated The set parts list is a SetPart now; kept so callers keep compiling. */
export type PartOffer = SetPart;

/**
 * How a row is actually executed.
 *
 * This matters because the two strategies need opposite actions, and conflating
 * them loses money. A spread is MARKET MAKING: you post a bid above the best
 * bid and an ask below the best ask, and wait for both. Whispering the cheapest
 * seller at their asking price and then selling below it is a guaranteed loss —
 * which is exactly what a single "copy whisper" button invited.
 *
 * Set arbitrage is the opposite: you take component asks, so whispering each
 * part's cheapest seller at their price IS the trade.
 */
export type PlayKind = "post" | "buy-parts";

export interface Row extends Opportunity {
  /** warframe.market address, for the link that confirms availability. */
  item_slug: string;
  /** Whom you would actually message, and the message itself. */
  seller: Counterparty | null;
  buyer: Counterparty | null;
  playKind: PlayKind;
  /** For "post": the two orders to place, and wait for. */
  postBuyAt: number | null;
  postSellAt: number | null;
  contacts: number;
  profitPerContact: number;
  /**
   * An active attempt at the buy leg — offering the cheapest seller the price
   * the model assumes, not their asking price. Often declined; that is the
   * strategy, not a fault.
   */
  lowballWhisper: string | null;
  /** For "buy-parts": every component, bought from reachable sellers up the book. */
  parts: SetPart[] | null;
  /** Profit per trade once your record for this strategy has had its say. */
  expectedMargin: number;
  /** Null until you have closed trades of this strategy. */
  calibration: StrategyFactor | null;
  watched: boolean;
  /** Age of the price this row is built on. */
  priceAgeH: number | null;
  /**
   * Consecutive sweeps the cheapest ask has held its position without selling.
   * A high number is the ghost signal: nobody is buying it at that price, so
   * either the seller does not respond or the price is fiction.
   */
  ghostSweeps: number;
  /** 0–100 confidence in capturing the calibrated margin under current conditions. */
  riskScore: number;
  /** Expected margin discounted by freshness, liquidity confidence, trend, and ghost risk. */
  riskAdjustedMargin: number;
  riskFlags: string[];
  profitScenarios: ProfitScenarios;
}

export interface ProfitScenarios {
  /** Current listing plan. */
  proposed: { sellAt: number; profit: number };
  /** Profit at the recent completed-trade median. */
  historical: { sellAt: number; profit: number } | null;
  /** Exit available from the highest reachable buyer right now. */
  immediate: { sellAt: number; profit: number } | null;
  /** A simple adverse move, deliberately concrete rather than statistical. */
  downside5: { sellAt: number; profit: number };
  breakEven: number;
}

export function profitScenariosOf(
  row: Pick<Opportunity, "buyAt" | "sellAt" | "median7d">,
  buyer: Counterparty | null,
): ProfitScenarios {
  const at = (sellAt: number) => ({ sellAt, profit: sellAt - row.buyAt });
  return {
    proposed: at(row.sellAt),
    historical: row.median7d === null ? null : at(Math.round(row.median7d)),
    immediate: buyer ? at(buyer.platinum) : null,
    downside5: at(Math.max(0, row.sellAt - 5)),
    breakEven: row.buyAt,
  };
}

export function riskOf(row: Pick<Row, "sellConfidence" | "priceAgeH" | "liveAt" | "trend" | "ghostSweeps" | "expectedMargin">) {
  let factor = row.sellConfidence === "high" ? 1 : row.sellConfidence === "medium" ? 0.82 : 0.58;
  const flags: string[] = [];
  if (row.sellConfidence !== "high") flags.push(`${row.sellConfidence} liquidity evidence`);
  if (!row.liveAt && row.priceAgeH !== null) {
    const freshness = Math.max(0.55, 1 - row.priceAgeH / 168);
    factor *= freshness;
    if (row.priceAgeH > 12) flags.push(`${Math.round(row.priceAgeH)}h-old book`);
  }
  if (row.trend !== null && row.trend < -0.05) {
    factor *= Math.max(0.65, 1 + row.trend);
    flags.push(`${Math.round(Math.abs(row.trend) * 100)}% falling trend`);
  }
  if (row.ghostSweeps >= 3) {
    factor *= Math.max(0.65, 1 - Math.min(row.ghostSweeps, 10) * 0.035);
    flags.push(`cheapest ask persisted ${row.ghostSweeps} sweeps`);
  }
  const riskScore = Math.max(0, Math.min(100, Math.round(factor * 100)));
  return { riskScore, riskAdjustedMargin: Math.round(row.expectedMargin * factor), riskFlags: flags };
}

interface OrderRow {
  user_id: string;
  ingame_name: string;
  platinum: number;
  sweeps_at_best: number;
}

/**
 * Reply rates from your own whisper log.
 *
 * This is the signal no public tool can build: a seller who never answers is
 * worse than one asking 5p more, and only your own trade attempts reveal that.
 */
export function sellerStats(db: Db): Map<string, { sent: number; replied: number }> {
  const rows = db
    .prepare(
      `SELECT user_id,
              COUNT(*) AS sent,
              SUM(CASE WHEN replied = 1 THEN 1 ELSE 0 END) AS replied
         FROM whisper_log
        GROUP BY user_id`,
    )
    .all() as Array<{ user_id: string; sent: number; replied: number }>;
  return new Map(rows.map((r) => [r.user_id, { sent: r.sent, replied: r.replied }]));
}

function counterparty(
  order: OrderRow | undefined,
  stats: Map<string, { sent: number; replied: number }>,
): Counterparty | null {
  if (!order) return null;
  const s = stats.get(order.user_id);
  return {
    userId: order.user_id,
    ingameName: order.ingame_name,
    platinum: order.platinum,
    sent: s?.sent ?? 0,
    replied: s?.replied ?? 0,
    replyRate: s && s.sent > 0 ? s.replied / s.sent : null,
  };
}

/**
 * Best order per side that you could whisper right now — the same reachable
 * set the set costing walks, so the seller offered is one the row was priced
 * against. It used to be any order still "on the book", which included
 * offline sellers and feed sightings hours old.
 */
function bestOrderReader(db: Db, now = Date.now()) {
  const stmt = db.prepare(
    `SELECT user_id, ingame_name, platinum, sweeps_at_best
       FROM order_seen
      WHERE item_id = @itemId AND variant = @variant AND type = @type
        AND ${REACHABLE_ORDER}
      ORDER BY CASE WHEN @type = 'sell' THEN platinum END ASC,
               CASE WHEN @type = 'buy'  THEN platinum END DESC
      LIMIT 1`,
  );
  const cutoff = liveCutoff(now);
  return (itemId: string, variant: string, type: "sell" | "buy") =>
    stmt.get({ itemId, variant, type, liveCutoff: cutoff, actionableCutoff: actionableSweepCutoff(now) }) as OrderRow | undefined;
}

/**
 * A set's shopping list: each part, who it is bought from, and what the full
 * quantity costs. For set arbitrage paying the ask IS the trade, unlike a
 * spread, so every whisper offers the seller's own price.
 */
function setPartsOf(
  input: SetInput,
  stats: Map<string, { sent: number; replied: number }>,
): SetPart[] {
  return [...input.parts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<SetPart>((p) => {
      const fills: PartFill[] = (p.fill?.fills ?? []).map((f) => ({
        orderId: f.order.orderId,
        stock: Math.max(1, f.order.quantity ?? 1),
        seller: counterparty(
          {
            user_id: f.order.userId,
            ingame_name: f.order.ingameName,
            platinum: f.order.platinum,
            sweeps_at_best: 0,
          },
          stats,
        )!,
        units: f.units,
        platinum: f.order.platinum,
        status: f.order.status,
        whisper: whisperFor(f.order.ingameName, p.name, f.order.platinum, "buy"),
      }));
      return {
        itemId: p.itemId,
        item_slug: p.slug ?? "",
        name: p.name,
        qty: p.qty,
        each: fills[0]?.platinum ?? p.lowSell,
        subtotal: p.fill ? p.fill.cost : p.lowSell === null ? null : p.lowSell * p.qty,
        available: p.fill ? p.fill.available : p.lowSell === null ? 0 : p.qty,
        volume48h: p.volume48h,
        fills,
        seller: fills[0]?.seller ?? null,
        whisper: fills[0]?.whisper ?? null,
      };
    });
}

/** Calibration fields for a row of the given strategy. */
function calibrationOf(
  factors: Map<string, StrategyFactor>,
  kind: string,
  margin: number,
): { expectedMargin: number; calibration: StrategyFactor | null } {
  const f = factors.get(kind);
  return { expectedMargin: calibrated(margin, f), calibration: f ?? null };
}

export interface OpportunityQuery {
  kind?: "spread" | "set";
  limit?: number;
  watchedOnly?: boolean;
  /** Most platinum to tie up in one trade. */
  maxBuyAt?: number | null;
  sortBy?: SortBy;
}

export function opportunities(db: Db, q: OpportunityQuery = {}): Row[] {
  const sweepId = latestSweepId(db);
  if (sweepId === null) return [];

  const policy: RankingPolicy = {
    ...DEFAULT_POLICY,
    ...(q.maxBuyAt !== undefined ? { maxBuyAt: q.maxBuyAt } : {}),
  };

  const all: Array<Opportunity | null> = [];
  const setInputs = new Map<string, SetInput>();
  if (q.kind !== "set") all.push(...spreadRows(db, sweepId).map((r) => scoreSpread(r, policy)));
  if (q.kind !== "spread") {
    for (const s of setRows(db, sweepId)) {
      setInputs.set(s.set.itemId, s);
      all.push(scoreSet(s, policy));
    }
  }

  // Results-based ranking: each strategy's order is scaled by what your closed
  // trades say it really makes. Every sort key is linear in the margin, so
  // scaling the key is exactly re-ranking on the calibrated margin — and with
  // no closed trades every factor is 1 and the order is the prediction's.
  const sortBy = q.sortBy ?? "score";
  const factors = strategyCalibration(db);
  const factor = (o: Opportunity) => factors.get(o.kind)?.factor ?? 1;
  const ranked = rank(all, sortBy).sort(
    (a, b) => sortKey(b, sortBy) * factor(b) - sortKey(a, sortBy) * factor(a),
  );
  const stats = sellerStats(db);

  const watched = new Set(
    (
      db.prepare("SELECT item_id, variant FROM watchlist").all() as Array<{
        item_id: string;
        variant: string;
      }>
    ).map((w) => `${w.item_id}|${w.variant}`),
  );

  const bestOrder = bestOrderReader(db);

  const takenAt = db
    .prepare("SELECT taken_at FROM snapshot WHERE sweep_id = ? LIMIT 1")
    .get(sweepId) as { taken_at: string } | undefined;
  const priceAgeH = takenAt
    ? (Date.now() - Date.parse(takenAt.taken_at)) / 3_600_000
    : null;

  const rows = ranked.slice(0, q.limit ?? 100).map<Row>((o) => {
    const sellOrder = bestOrder(o.itemId, o.variant, "sell");
    const seller = counterparty(sellOrder, stats);
    const buyer = counterparty(bestOrder(o.itemId, o.variant, "buy"), stats);

    // Set arbitrage acquires components, so a whisper about the assembled set
    // is meaningless — the seller of the set is not who you trade with.
    const input = o.kind === "set" ? setInputs.get(o.itemId) : undefined;
    const parts = input ? setPartsOf(input, stats) : null;
    const contacts = parts ? new Set(parts.flatMap((p) => p.fills.map((f) => f.seller.userId))).size : 2;

    const base = {
      ghostSweeps: sellOrder?.sweeps_at_best ?? 0,
      ...o,
      item_slug: o.slug,
      ...calibrationOf(factors, o.kind, o.margin),
      seller,
      buyer,
      playKind: o.kind === "set" ? "buy-parts" : "post",
      postBuyAt: o.kind === "spread" ? o.buyAt : null,
      postSellAt: o.kind === "spread" ? o.sellAt : null,
      // Offers the model's buy price, NOT the seller's ask. Paying the ask and
      // then undercutting it is how the old button lost money.
      lowballWhisper:
        o.kind === "spread" && seller ? whisperFor(seller.ingameName, o.name, o.buyAt, "buy") : null,
      parts,
      contacts,
      profitPerContact: Number((o.margin / Math.max(1, contacts)).toFixed(1)),
      watched: watched.has(`${o.itemId}|${o.variant}`),
      priceAgeH: priceAgeH === null ? null : Number(priceAgeH.toFixed(2)),
      profitScenarios: profitScenariosOf(o, buyer),
    } satisfies Omit<Row, "riskScore" | "riskAdjustedMargin" | "riskFlags">;
    return { ...base, ...riskOf(base) };
  });

  return q.watchedOnly ? rows.filter((r) => r.watched) : rows;
}

/** A set costed as its parts, against what the assembled set sells for. */
export interface SetRow extends Opportunity {
  item_slug: string;
  /** Cheapest ask for the assembled set — the one you undercut. */
  setAsk: number;
  /** 7-day median of completed set trades, which caps `sellAt`. */
  tradedAt: number | null;
  /**
   * Set when the asks sit above where sets trade, so `sellAt` is the traded
   * price rather than an undercut of the book — the edge a sum against the
   * ask would promise is not there.
   */
  cappedByTrades: boolean;
  /**
   * Parts whose cost is unknown — nobody sells them, or too few units are on
   * sale from reachable sellers — which make `buyAt` and `margin` unknown
   * rather than zero.
   */
  unpriced: number;
  parts: SetPart[];
  expectedMargin: number;
  calibration: StrategyFactor | null;
}

export type SetSort =
  /** Platinum per set assembled — the most profit from one trip. */
  | "margin"
  /** Margin as a fraction of the parts bill. */
  | "return"
  /** Platinum per 48h, bounded by the slowest component. */
  | "score"
  /** Return per expected day to sell the set. */
  | "speed";

export interface SetQuery {
  sortBy?: SetSort;
  /** Also list what the policy holds back, with its reasons, after the tradable rows. */
  includeHeldBack?: boolean;
  maxBuyAt?: number | null;
  limit?: number;
}

export interface SetComparison {
  rows: SetRow[];
  tradable: number;
  /** Sets with a price for every part, so an edge could be computed at all. */
  priced: number;
}

/**
 * Every set, costed as its components and compared against the set.
 *
 * The same scoring as the set rows in `opportunities`, laid out so the
 * comparison itself is visible: each part's price × quantity, their sum, and
 * what the set sells for. Held-back sets are listed on request because the
 * reason is often worth seeing — a fat edge on a set nobody buys is a trap,
 * and silently filtering it hides that.
 */
export function setArbitrage(db: Db, q: SetQuery = {}): SetComparison {
  const sweepId = latestSweepId(db);
  if (sweepId === null) return { rows: [], tradable: 0, priced: 0 };

  const policy: RankingPolicy = {
    ...DEFAULT_POLICY,
    ...(q.maxBuyAt !== undefined ? { maxBuyAt: q.maxBuyAt } : {}),
  };

  const scored = setRows(db, sweepId).flatMap((input) => {
    const o = scoreSet(input, policy);
    return o ? [{ input, o }] : [];
  });

  const isTradable = (o: Opportunity) => o.rejects.length === 0 && o.margin > 0;
  // Priced means the whole parts bill is known: every part can be bought in
  // full from someone reachable.
  const costKnown = (p: SetInput["parts"][number]) =>
    (p.fill ? p.fill.cost : p.lowSell) !== null;
  const isPriced = ({ input }: (typeof scored)[number]) => input.parts.every(costKnown);
  const key = (o: Opportunity) =>
    q.sortBy === "return" || q.sortBy === "score" || q.sortBy === "speed"
      ? sortKey(o, q.sortBy)
      : o.margin;

  // Tradable first, then held back, then unpriced — an unknown edge sorted as
  // zero would otherwise land between real gains and real losses.
  const tier = (s: (typeof scored)[number]) => (isTradable(s.o) ? 0 : isPriced(s) ? 1 : 2);
  const listed = scored
    .filter((s) => q.includeHeldBack || isTradable(s.o))
    .sort((a, b) => tier(a) - tier(b) || key(b.o) - key(a.o));

  const stats = sellerStats(db);
  const factors = strategyCalibration(db);

  const rows = listed.slice(0, q.limit ?? 300).map<SetRow>(({ input, o }) => ({
    ...o,
    item_slug: o.slug,
    ...calibrationOf(factors, "set", o.margin),
    setAsk: input.set.lowSell!,
    tradedAt: input.set.median7d ?? null,
    cappedByTrades: o.sellAt < input.set.lowSell! - policy.undercut,
    unpriced: input.parts.filter((p) => !costKnown(p)).length,
    parts: setPartsOf(input, stats),
  }));

  return {
    rows,
    tradable: scored.filter((s) => isTradable(s.o)).length,
    priced: scored.filter(isPriced).length,
  };
}

/**
 * Alerts, newest first, with the traded-price trend of each item: a "bargain"
 * against last week's median may just be where a falling market now sits.
 *
 * Each alert also says whether it is still backed by fresh sourcing evidence.
 * An alert is a sighting from minutes or hours ago; it is only presented as
 * actionable when the order that fired it is still reachable and, for a sell
 * alert, a reachable ask still lets you source the item at the reference.
 */
export function recentAlerts(db: Db, limit = 200, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT a.*, i.name AS item_name, i.slug AS item_slug, os.user_id,
              ss.median_7d AS median7d, ss.median_30d AS median30d,
              af.outcome, af.trade_id, af.note AS feedback_note, af.recorded_at,
              -- Every lot sold from the alert's purchase, plus the sale it filled.
              (SELECT SUM((t.sell_price - t.buy_price) * t.quantity) FROM trade t
                WHERE t.sold_at IS NOT NULL AND (t.alert_id = a.id OR t.id = af.trade_id)) AS realised_profit,
              EXISTS (SELECT 1 FROM trade t WHERE t.id = af.trade_id) AS trade_linked,
              EXISTS (SELECT 1 FROM order_seen o
                       WHERE o.order_id = a.order_id
                         AND o.type = CASE a.kind WHEN 'underpriced_sell' THEN 'sell' ELSE 'buy' END
                         AND ${REACHABLE_ORDER}) AS order_reachable,
              (SELECT MIN(o.platinum) FROM order_seen o
                WHERE o.item_id = a.item_id AND o.variant = a.variant AND o.type = 'sell'
                  AND o.order_id != a.order_id AND ${REACHABLE_ORDER}) AS source_ask
         FROM alert a
         JOIN item i ON i.id = a.item_id
         LEFT JOIN order_seen os ON os.order_id = a.order_id
         LEFT JOIN stat_summary ss ON ss.item_id = a.item_id AND ss.variant = a.variant
         LEFT JOIN alert_feedback af ON af.alert_id = a.id
        ORDER BY a.fired_at DESC
        LIMIT @limit`,
    )
    .all({ limit, liveCutoff: liveCutoff(now), actionableCutoff: actionableSweepCutoff(now) }) as Array<
      Record<string, unknown> & {
        kind: string; reference: number; suspicious: number; median7d: number | null; median30d: number | null;
        order_reachable: number; source_ask: number | null; trade_linked: number;
      }
    >;
  return rows.map((r) => {
    const reachable = r.order_reachable === 1;
    let fresh: boolean;
    let sourcingDetail: string;
    if (r.kind === "underpriced_sell") {
      fresh = reachable;
      sourcingDetail = reachable
        ? "the listing was seen recently from a reachable seller"
        : "the listing has not been seen recently — it may already be sold";
    } else {
      fresh = reachable && r.source_ask !== null && r.source_ask <= r.reference;
      sourcingDetail = !reachable
        ? "the buy order has not been seen recently"
        : r.source_ask === null
          ? "no reachable seller to source the item from right now"
          : r.source_ask > r.reference
            ? `the cheapest reachable ask is now ${r.source_ask}p, above the ${r.reference}p it was sourced at`
            : `a reachable ask at ${r.source_ask}p still covers it`;
    }
    return {
      ...r,
      trend: trendOf(r.median7d, r.median30d),
      sourcing: fresh ? "fresh" : "stale",
      sourcingDetail,
      actionable: fresh && !r.suspicious,
      trade_linked: r.trade_linked === 1,
    };
  });
}

export interface PriceHistory {
  itemId: string;
  name: string;
  variant: string;
  days: Array<{ day: string; volume: number; median: number | null; min: number | null; max: number | null }>;
  median7d: number | null;
  median30d: number | null;
  volume7d: number | null;
  trend: number | null;
}

/**
 * Daily traded prices and volume. History is per variant at the source, and so
 * here: a rank-0 mod's series says nothing about rank 10.
 */
export function priceHistory(db: Db, itemId: string, variant = "", days = 90): PriceHistory | null {
  const item = db.prepare("SELECT id, name FROM item WHERE id = ?").get(itemId) as
    | { id: string; name: string }
    | undefined;
  if (!item) return null;
  const series = db
    .prepare(
      `SELECT day, volume, median, min_price AS min, max_price AS max
         FROM stat_daily
        WHERE item_id = @itemId AND variant = @variant AND day >= date('now', @window)
        ORDER BY day`,
    )
    .all({ itemId, variant, window: `-${Math.max(1, Math.min(90, days))} days` }) as PriceHistory["days"];
  const s = db
    .prepare(
      `SELECT median_7d AS median7d, median_30d AS median30d, volume_7d AS volume7d
         FROM stat_summary WHERE item_id = ? AND variant = ?`,
    )
    .get(itemId, variant) as { median7d: number | null; median30d: number | null; volume7d: number } | undefined;
  return {
    itemId,
    name: item.name,
    variant,
    days: series,
    median7d: s?.median7d ?? null,
    median30d: s?.median30d ?? null,
    volume7d: s?.volume7d ?? null,
    trend: trendOf(s?.median7d, s?.median30d),
  };
}

export interface PlanQuery {
  budget: number;
  maxPerItem: number | null;
  cashReserve?: number;
  maxPerGroup?: number | null;
  sortBy?: PlanSort;
  minConfidence?: Confidence;
}

/**
 * The budget plan: the ranked trades, calibrated against your record, fitted
 * to the platinum you have — with what you already hold counted against each
 * item's limit.
 */
export interface SellerRoute {
  userId: string;
  ingameName: string;
  purchases: Array<{ itemId: string; item_slug: string; name: string; units: number; platinum: number; whisper: string }>;
  totalPlatinum: number;
}

export type AlertOutcome = "bought" | "already_gone" | "no_reply" | "margin_disappeared";

export function setAlertFeedback(db: Db, alertId: number, outcome: AlertOutcome, tradeId?: number, note?: string): boolean {
  const exists = db.prepare("SELECT 1 FROM alert WHERE id=?").get(alertId);
  if (!exists) return false;
  db.prepare(`INSERT INTO alert_feedback(alert_id,outcome,trade_id,note,recorded_at)
    VALUES(?,?,?,?,?) ON CONFLICT(alert_id) DO UPDATE SET outcome=excluded.outcome,
    trade_id=excluded.trade_id,note=excluded.note,recorded_at=excluded.recorded_at`)
    .run(alertId, outcome, tradeId ?? null, note ?? null, new Date().toISOString());
  return true;
}

export function alertPerformance(db: Db) {
  const r = db.prepare(`SELECT COUNT(*) total, COUNT(af.alert_id) reviewed,
    SUM(CASE WHEN af.outcome='bought' THEN 1 ELSE 0 END) bought,
    SUM(CASE WHEN af.outcome='already_gone' THEN 1 ELSE 0 END) alreadyGone,
    SUM(CASE WHEN af.outcome='no_reply' THEN 1 ELSE 0 END) noReply,
    SUM(CASE WHEN af.outcome='margin_disappeared' THEN 1 ELSE 0 END) marginDisappeared
    FROM alert a LEFT JOIN alert_feedback af ON af.alert_id=a.id`).get() as Record<string, number>;
  // Every closed lot that came from an alert — each partial sale of an alert
  // purchase, and each sale an alert filled — counted once, however many
  // alerts it is linked to. Joining feedback to one trade used to miss every
  // lot but the last.
  const realised = db.prepare(`SELECT COALESCE(SUM((sell_price - buy_price) * quantity), 0) profit, COUNT(*) lots
      FROM trade
     WHERE sold_at IS NOT NULL
       AND (alert_id IS NOT NULL OR id IN (SELECT trade_id FROM alert_feedback WHERE trade_id IS NOT NULL))`)
    .get() as { profit: number; lots: number };
  r["realisedProfit"] = realised.profit;
  r["realisedLots"] = realised.lots;
  const reviewed = Number(r.reviewed ?? 0), bought = Number(r.bought ?? 0);
  const recommendations: string[] = [];
  if (reviewed >= 5) {
    if (Number(r.alreadyGone ?? 0) / reviewed > 0.35) recommendations.push("Too many listings are gone: shorten the polling interval.");
    if (Number(r.noReply ?? 0) / reviewed > 0.35) recommendations.push("Seller response is weak: favour in-game sellers and higher reply-rate accounts.");
    if (Number(r.marginDisappeared ?? 0) / reviewed > 0.2) recommendations.push("Margins often vanish: tighten the sell discount and raise minimum profit.");
    if (bought >= 3 && Number(r.realisedProfit ?? 0) <= 0) recommendations.push("Completed alert trades are not profitable: raise the minimum-profit threshold.");
  }
  return { ...r, total: Number(r.total ?? 0), reviewed, bought,
    conversionRate: reviewed ? bought / reviewed : null, realisedProfit: Number(r.realisedProfit ?? 0),
    realisedLots: Number(r.realisedLots ?? 0), recommendations };
}

export type TradePlan = Plan<Row> & { sellerRoutes: SellerRoute[]; routePurchases: number };

export function sellerRoutesOf(picks: Row[]): SellerRoute[] {
  const routes = new Map<string, SellerRoute>();
  for (const pick of picks) {
    for (const part of pick.parts ?? []) {
      for (const fill of part.fills) {
        const route = routes.get(fill.seller.userId) ?? {
          userId: fill.seller.userId,
          ingameName: fill.seller.ingameName,
          purchases: [],
          totalPlatinum: 0,
        };
        route.purchases.push({
          itemId: part.itemId, item_slug: part.item_slug, name: part.name, units: fill.units,
          platinum: fill.platinum, whisper: fill.whisper,
        });
        route.totalPlatinum += fill.units * fill.platinum;
        routes.set(route.userId, route);
      }
    }
  }
  return [...routes.values()].sort((a, b) => b.purchases.length - a.purchases.length || b.totalPlatinum - a.totalPlatinum);
}

export function tradePlan(db: Db, q: PlanQuery): TradePlan {
  const groupByItem = new Map((db.prepare("SELECT id, tags FROM item").all() as Array<{id:string;tags:string}>).map((row) => {
    let tags: string[] = []; try { tags = JSON.parse(row.tags) as string[]; } catch {}
    const group = ["warframe", "weapon", "mod", "arcane_enhancement", "relic", "companion"].find((tag) => tags.includes(tag)) ?? "other";
    return [row.id, group] as const;
  }));
  const candidates = opportunities(db, { limit: 1000 }).map((candidate) => {
    const resources: Record<string, number> = {};
    for (const part of candidate.parts ?? []) {
      for (const fill of part.fills) {
        resources[fill.orderId] = (resources[fill.orderId] ?? 0) + fill.units;
      }
    }
    return { ...candidate, resources, group: groupByItem.get(candidate.itemId) ?? "other" };
  });
  const resourceCapacity = new Map<string, number>();
  for (const candidate of candidates) {
    for (const part of candidate.parts ?? []) {
      for (const fill of part.fills) resourceCapacity.set(fill.orderId, fill.stock);
    }
  }
  const held = new Map(
    (
      db
        .prepare(
          `SELECT item_id AS itemId, variant, SUM(buy_price * quantity) AS tied
             FROM trade WHERE sold_at IS NULL GROUP BY item_id, variant`,
        )
        .all() as Array<{ itemId: string; variant: string; tied: number }>
    ).map((h) => [keyOf(h), h.tied]),
  );
  const plan = planTrades(candidates, {
    budget: q.budget,
    maxPerItem: q.maxPerItem,
    sortBy: q.sortBy ?? "speed",
    minConfidence: q.minConfidence ?? "medium",
    held,
    resourceCapacity,
    cashReserve: q.cashReserve ?? 0,
    maxPerGroup: q.maxPerGroup ?? null,
  });
  const sellerRoutes = sellerRoutesOf(plan.picks);
  return { ...plan, sellerRoutes, routePurchases: sellerRoutes.reduce((n, r) => n + r.purchases.length, 0) };
}

export function status(db: Db) {
  const sweep = db
    .prepare(
      "SELECT id, started_at, finished_at, items_ok FROM sweep WHERE kind='top' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as { id: number; finished_at: string; items_ok: number } | undefined;

  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;

  const jobs = schedulerHealth(db);
  return {
    sweepId: sweep?.id ?? null,
    sweptAt: sweep?.finished_at ?? null,
    sweepAgeH: sweep ? Number(((Date.now() - Date.parse(sweep.finished_at)) / 3_600_000).toFixed(1)) : null,
    items: count("SELECT COUNT(*) c FROM item"),
    markets: sweep
      ? (db.prepare("SELECT COUNT(*) c FROM snapshot WHERE sweep_id=?").get(sweep.id) as { c: number }).c
      : 0,
    ordersTracked: count("SELECT COUNT(*) c FROM order_seen"),
    alerts: count("SELECT COUNT(*) c FROM alert"),
    jobs,
    failingJobs: jobs.filter((j) => j.consecutiveFailures > 0).length,
    backup: {
      lastSuccess: getMeta(db, "backup:lastSuccess"),
      path: getMeta(db, "backup:lastPath"),
      bytes: Number(getMeta(db, "backup:lastBytes") ?? 0) || null,
    },
    livePoll: { lastSuccess: getMeta(db, "watch:lastSuccess"), lastError: getMeta(db, "watch:lastError") },
    // Enabled is what the running daemon decided at startup (the toast sink is
    // off under --no-toast), not merely whether a sink exists. Toasts used to
    // report "configured" unconditionally, so Settings showed them working
    // while the daemon had them switched off.
    notifications: ["toast", "discord"].map((name) => {
      const flag = getMeta(db, name === "toast" ? "notify:toast:enabled" : "notify:discord:configured");
      return {
        name,
        enabled: flag === "1",
        configured: flag === "1",
        state: flag === null ? "unknown" : flag === "1" ? "enabled" : "disabled",
        detail: getMeta(db, `notify:${name}:detail`) ?? "",
        lastAttempt: getMeta(db, `notify:${name}:lastAttempt`),
        lastSuccess: getMeta(db, `notify:${name}:lastSuccess`),
        lastError: getMeta(db, `notify:${name}:lastError`),
        pending: name === "discord" ? count("SELECT COUNT(*) c FROM notification_outbox") : 0,
      };
    }),
    whispers: count("SELECT COUNT(*) c FROM whisper_log"),
    watched: count("SELECT COUNT(*) c FROM watchlist"),
  };
}

export function logWhisper(
  db: Db,
  w: { itemId: string; userId: string; ingameName: string; platinum: number; orderId?: string; note?: string },
): number {
  const info = db
    .prepare(
      `INSERT INTO whisper_log (order_id, item_id, user_id, ingame_name, platinum, sent_at, note)
       VALUES (@orderId, @itemId, @userId, @ingameName, @platinum, @sentAt, @note)`,
    )
    .run({
      orderId: w.orderId ?? null,
      itemId: w.itemId,
      userId: w.userId,
      ingameName: w.ingameName,
      platinum: w.platinum,
      sentAt: new Date().toISOString(),
      note: w.note ?? null,
    });
  return Number(info.lastInsertRowid);
}

export function resolveWhisper(
  db: Db,
  id: number,
  outcome: { replied?: boolean; traded?: boolean },
): boolean {
  return db.prepare(
    `UPDATE whisper_log
        SET replied = COALESCE(@replied, replied),
            traded  = COALESCE(@traded, traded)
      WHERE id = @id`,
  ).run({
    id,
    replied: outcome.replied === undefined ? null : outcome.replied ? 1 : 0,
    traded: outcome.traded === undefined ? null : outcome.traded ? 1 : 0,
  }).changes > 0;
}

export function pendingWhispers(db: Db, limit = 30) {
  return db
    .prepare(
      `SELECT w.*, i.name AS item_name, i.slug AS item_slug
         FROM whisper_log w JOIN item i ON i.id = w.item_id
        ORDER BY w.sent_at DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function setWatched(db: Db, itemId: string, variant: string, on: boolean): void {
  if (on) {
    db.prepare(
      "INSERT INTO watchlist (item_id, variant, added_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(item_id, variant) DO NOTHING",
    ).run(itemId, variant, new Date().toISOString());
  } else {
    db.prepare("DELETE FROM watchlist WHERE item_id = ? AND variant = ?").run(itemId, variant);
  }
}

/**
 * Items for the frequent re-poll loop: the watchlist, plus everything you
 * hold. Exit alerts are only as good as the book they read, and a position's
 * book was otherwise refreshed once per six-hour sweep.
 */
export function watchedItems(db: Db): Array<{ id: string; slug: string; name: string; tags: string }> {
  return db
    .prepare(
      `SELECT i.id, i.slug, i.name, i.tags
         FROM item i
        WHERE i.id IN (SELECT item_id FROM watchlist
                       UNION SELECT item_id FROM trade WHERE sold_at IS NULL)
        ORDER BY i.slug`,
    )
    .all() as Array<{ id: string; slug: string; name: string; tags: string }>;
}
