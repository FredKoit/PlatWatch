/**
 * Turning a price book into a ranked list of trades.
 *
 * Everything here is pure so the policy can be tested without a crawl. The
 * database side lives in query.ts.
 */

import { hoursSinceTrade, MAX_HISTORY_STALE_HOURS } from "./freshness";
import type { FillResult } from "./depth";
import { returnPerDay, sellTime, type Confidence } from "./timing";

export interface RankingPolicy {
  /** Below this, an item cannot be ranked however fat its spread. */
  minVolume48h: number;
  /** A lone cheap order is more often stale than a bargain — require corroboration. */
  minSellOrders: number;
  /**
   * The same rule for the bid side. A spread quoted against ONE lowball bid is
   * fictional: melee_assimilation asks 150p and has a single 15p buy order, which
   * scores as a 173p "spread" that no seller would ever fill.
   */
  minBuyOrders: number;
  /**
   * A spread this far above the bid is not a two-sided market, it is two
   * unrelated prices. Real spreads run tens of percent, not a thousand.
   */
  maxSpreadPct: number;
  /**
   * How far above the TRADED median you may plan to sell.
   *
   * The sell leg assumes you can undercut the cheapest ask and get filled. That
   * only holds if the ask book is near where the market clears. Blaze asks 74p
   * while trading at 47p — posting at 73p is asking half again what anyone
   * pays, and the 31p margin is really about 5p. Sellers set asks; only
   * completed trades say what gets bought.
   */
  maxSellAboveTraded: number;
  /** A book older than this is a hypothesis, not a quote. */
  maxBookAgeHours: number;
  /**
   * History that stopped describes a market that no longer exists. Measured in
   * hours from the END of the newest bucket — see rank/freshness.ts for why the
   * old day-based check emptied the ranking for most of every day.
   */
  maxHistoryStaleHours: number;
  minMarginPlat: number;
  /** Guards against 2p on a 200p item, which is noise, not edge. */
  minMarginPct: number;
  /** Trades of one item you could realistically complete in 48h. */
  tradeCapacity: number;
  /**
   * Most platinum to tie up in a single trade, or null for no limit.
   *
   * Absolute margin alone will happily rank a 400p edge on a 900p collector
   * item above a 40p edge on a 60p set, which is the wrong answer if you do not
   * have 900p spare — or want it back this week.
   */
  maxBuyAt: number | null;
  /** What you must undercut by, per side, to actually be top of book. */
  undercut: number;
}

export const DEFAULT_POLICY: RankingPolicy = {
  minVolume48h: 6,
  minSellOrders: 3,
  minBuyOrders: 3,
  maxSpreadPct: 2,
  maxSellAboveTraded: 1.5,
  maxBookAgeHours: 72,
  maxHistoryStaleHours: MAX_HISTORY_STALE_HOURS,
  minMarginPlat: 5,
  minMarginPct: 0.08,
  tradeCapacity: 10,
  maxBuyAt: null,
  undercut: 1,
};

export type OpportunityKind = "spread" | "set";

export interface MarketRow {
  itemId: string;
  slug: string;
  name: string;
  /** '' for plain items; a ranked mod or relic subtype prices separately. */
  variant: string;
  lowSell: number | null;
  highBuy: number | null;
  sellP50: number | null;
  sellCount: number;
  buyCount: number;
  bookAgeH: number | null;
  volume48h: number | null;
  volume7d: number | null;
  daysTraded30d: number | null;
  lastTradedDay: string | null;
  /** End of the newest hourly bucket; preferred over lastTradedDay when set. */
  lastTradedAt?: string | null;
  /** Set when a side of this book came from the live feed rather than the sweep. */
  liveAt?: string | null;
  /** Median of completed trades for this variant — what actually gets paid. */
  median7d?: number | null;
  /** The same over 30 days; against median7d, which way the price is moving. */
  median30d?: number | null;
}

export interface SetPartInput {
  itemId: string;
  /** warframe.market address of the part. */
  slug?: string;
  name: string;
  qty: number;
  lowSell: number | null;
  volume48h: number | null;
  /**
   * The parts bought from the reachable book, quantity included. When present
   * it IS the cost — the cheapest ask × qty assumes the cheapest seller holds
   * every unit you need.
   */
  fill?: FillResult;
}

export interface SetInput {
  set: MarketRow;
  parts: SetPartInput[];
}

export interface Opportunity {
  itemId: string;
  slug: string;
  name: string;
  variant: string;
  kind: OpportunityKind;
  buyAt: number;
  sellAt: number;
  margin: number;
  marginPct: number;
  volume48h: number;
  bookAgeH: number | null;
  sellCount: number;
  /** Platinum per 48h if you capture up to `tradeCapacity` trades. */
  score: number;
  /** Empty when tradable; otherwise every reason it was held back. */
  rejects: string[];
  detail?: string;
  /**
   * Set when a side of this book was refreshed from the live feed since the
   * sweep. Carried through from MarketRow so the UI can distinguish a price
   * seen minutes ago from one recorded at the start of a 22-minute crawl.
   */
  liveAt?: string | null;
  /** Expected days to sell at `sellAt` — how long the platinum is tied up. */
  sellDays: number | null;
  sellDaysOptimistic: number | null;
  sellDaysConservative: number | null;
  sellConfidence: Confidence;
  sellBasis: string;
  median7d: number | null;
  median30d: number | null;
  /** (7-day median − 30-day median) / 30-day median; null without both. */
  trend: number | null;
}

/** Which way the traded price is moving: last week against last month. */
export function trendOf(m7: number | null | undefined, m30: number | null | undefined): number | null {
  if (m7 == null || m30 == null || m30 <= 0) return null;
  return Number(((m7 - m30) / m30).toFixed(3));
}

/**
 * The market fields every opportunity carries, whichever strategy made it.
 * `legs` is 2 for a spread: its bid waits to be filled before its ask can sell.
 */
function marketFacts(row: MarketRow, sellAt: number, legs = 1) {
  const t = sellTime({
    volume48h: row.volume48h,
    volume7d: row.volume7d,
    daysTraded30d: row.daysTraded30d,
    // Both strategies list just under the cheapest ask, so nobody is ahead.
    queue: 0,
    sellAt,
    tradedMedian: row.median7d ?? null,
    legs,
  });
  return {
    sellDays: t.days,
    sellDaysOptimistic: t.optimisticDays,
    sellDaysConservative: t.conservativeDays,
    sellConfidence: t.confidence,
    sellBasis: t.basis,
    median7d: row.median7d ?? null,
    median30d: row.median30d ?? null,
    trend: trendOf(row.median7d, row.median30d),
  };
}

/**
 * Liquidity and freshness gates, shared by both strategies.
 *
 * Returns reasons rather than a boolean: an item held back for one weak reason
 * is worth seeing, and silent filtering makes a ranking impossible to debug.
 */
export function gate(
  row: Pick<MarketRow, "volume48h" | "sellCount" | "bookAgeH" | "lastTradedDay" | "lastTradedAt">,
  policy: RankingPolicy,
  now: number,
): string[] {
  const rejects: string[] = [];
  const volume = row.volume48h ?? 0;

  if (volume < policy.minVolume48h) rejects.push(`volume ${volume} < ${policy.minVolume48h}`);
  if (row.sellCount < policy.minSellOrders)
    rejects.push(`only ${row.sellCount} sell orders`);
  if (row.bookAgeH !== null && row.bookAgeH > policy.maxBookAgeHours)
    rejects.push(`book ${Math.round(row.bookAgeH)}h old`);

  const stale = hoursSinceTrade(row, now);
  if (stale === null) rejects.push("no trade history");
  else if (stale > policy.maxHistoryStaleHours)
    rejects.push(`last traded ${Math.round(stale)}h ago`);

  return rejects;
}

function marginGate(margin: number, buyAt: number, policy: RankingPolicy): string[] {
  const rejects: string[] = [];
  if (margin < policy.minMarginPlat) rejects.push(`margin ${margin}p < ${policy.minMarginPlat}p`);
  const pct = buyAt > 0 ? margin / buyAt : 0;
  if (pct < policy.minMarginPct) rejects.push(`margin ${(pct * 100).toFixed(1)}% too thin`);
  if (policy.maxBuyAt !== null && buyAt > policy.maxBuyAt) {
    rejects.push(`needs ${buyAt}p up front > ${policy.maxBuyAt}p`);
  }
  return rejects;
}

function scoreOf(margin: number, volume: number, policy: RankingPolicy): number {
  return Math.round(margin * Math.min(volume, policy.tradeCapacity));
}

/**
 * Spread capture: post a buy above the best bid, a sell below the best ask, and
 * wait for both. The undercut on each side is what it costs to be top of book,
 * so it comes out of the spread.
 */
export function scoreSpread(
  row: MarketRow,
  policy: RankingPolicy = DEFAULT_POLICY,
  now = Date.now(),
): Opportunity | null {
  if (row.lowSell === null || row.highBuy === null) return null;

  const buyAt = row.highBuy + policy.undercut;
  const sellAt = row.lowSell - policy.undercut;
  const margin = sellAt - buyAt;
  const volume = row.volume48h ?? 0;

  const marginPct = buyAt > 0 ? margin / buyAt : 0;
  const spreadRejects: string[] = [];
  if (row.buyCount < policy.minBuyOrders) {
    spreadRejects.push(`only ${row.buyCount} buy orders`);
  }
  if (marginPct > policy.maxSpreadPct) {
    spreadRejects.push(`spread ${(marginPct * 100).toFixed(0)}% — not one market`);
  }
  const traded = row.median7d ?? null;
  if (traded !== null && traded > 0 && sellAt > traded * policy.maxSellAboveTraded) {
    spreadRejects.push(`would ask ${sellAt}p where it trades at ${traded.toFixed(0)}p`);
  }

  return {
    itemId: row.itemId,
    slug: row.slug,
    name: row.name,
    variant: row.variant,
    liveAt: row.liveAt ?? null,
    kind: "spread",
    buyAt,
    sellAt,
    margin,
    marginPct,
    volume48h: volume,
    bookAgeH: row.bookAgeH,
    sellCount: row.sellCount,
    score: scoreOf(margin, volume, policy),
    ...marketFacts(row, sellAt, 2),
    rejects: [
      ...gate(row, policy, now),
      ...marginGate(margin, buyAt, policy),
      ...spreadRejects,
    ],
  };
}

/**
 * Where an assembled set gets listed: undercut the cheapest ask to be seen, but
 * never above where sets actually trade.
 *
 * The same rule as sellAdvice's fair price, so the edge promised here is the
 * price the Trades tab tells you to list at once you hold the set. Pricing the
 * set at its ask alone put Aeolak at the top of the list: parts 64p, cheapest
 * set ask 248p, so +183p — for a set that trades at 77p.
 */
export function setSellPrice(
  set: Pick<MarketRow, "lowSell" | "median7d">,
  policy: RankingPolicy = DEFAULT_POLICY,
): number | null {
  if (set.lowSell === null) return null;
  const undercut = set.lowSell - policy.undercut;
  const traded = set.median7d ?? null;
  return traded !== null && traded > 0 ? Math.round(Math.min(traded, undercut)) : undercut;
}

/** What one part costs at the quantity needed; null when it cannot be bought in full. */
function partCost(p: SetPartInput): number | null {
  if (p.fill) return p.fill.cost;
  return p.lowSell === null ? null : p.lowSell * p.qty;
}

/**
 * Set arbitrage: buy each component, assemble, sell the set.
 *
 * `qty` is load-bearing — dual-wield sets need two of most parts, and dropping
 * the multiplier turns a loss into an apparent profit. With the book to walk,
 * so is order quantity: two blades from a seller holding one cost the cheapest
 * blade plus the next one up.
 *
 * Liquidity is the bottleneck part's, not the set's: assembling is only as fast
 * as the rarest component. A part nobody sells makes the edge unknown, not
 * zero — and so does one you cannot buy enough of right now.
 */
export function scoreSet(
  input: SetInput,
  policy: RankingPolicy = DEFAULT_POLICY,
  now = Date.now(),
): Opportunity | null {
  const { set, parts } = input;
  const sellAt = setSellPrice(set, policy);
  if (sellAt === null || parts.length === 0) return null;

  const common = {
    itemId: set.itemId,
    slug: set.slug,
    name: set.name,
    variant: set.variant,
    liveAt: set.liveAt ?? null,
    kind: "set" as const,
    sellAt,
    bookAgeH: set.bookAgeH,
    sellCount: set.sellCount,
    ...marketFacts(set, sellAt),
  };

  const unpriced = parts.filter((p) => p.lowSell === null && (!p.fill || p.fill.available === 0));
  const short = parts.filter((p) => !unpriced.includes(p) && partCost(p) === null);
  if (unpriced.length > 0 || short.length > 0) {
    return {
      ...common,
      buyAt: 0,
      margin: 0,
      marginPct: 0,
      volume48h: set.volume48h ?? 0,
      score: 0,
      rejects: [
        ...(unpriced.length ? [`${unpriced.length} component(s) unpriced — edge unknown`] : []),
        ...short.map(
          (p) => `short: only ${p.fill?.available ?? 0} of ${p.qty} ${p.name} from reachable sellers`,
        ),
      ],
      detail: [...unpriced, ...short].map((p) => p.name).join(", "),
    };
  }

  const cost = parts.reduce((sum, p) => sum + partCost(p)!, 0);
  const margin = sellAt - cost;

  const bottleneck = Math.min(
    set.volume48h ?? 0,
    ...parts.map((p) => p.volume48h ?? 0),
  );

  return {
    ...common,
    buyAt: cost,
    margin,
    marginPct: cost > 0 ? margin / cost : 0,
    volume48h: bottleneck,
    score: scoreOf(margin, bottleneck, policy),
    rejects: [
      ...gate({ ...set, volume48h: bottleneck }, policy, now),
      ...marginGate(margin, cost, policy),
    ],
    detail: parts.map((p) => `${p.name.split(" ").at(-1)}x${p.qty}@${p.lowSell}`).join(" "),
  };
}

export type SortBy =
  /** Platinum per 48h — what you make if capital is not the constraint. */
  | "score"
  /** Margin as a fraction of outlay — what you make per platinum tied up. */
  | "return"
  /** Return per expected day to sell — what you make per platinum per day. */
  | "speed";

/** The number each ranking orders by, for callers that re-rank (the plan, calibration). */
export function sortKey(o: Pick<Opportunity, "margin" | "marginPct" | "score" | "buyAt" | "sellDays">, sortBy: SortBy): number {
  if (sortBy === "return") return o.marginPct;
  if (sortBy === "speed") return returnPerDay(o.margin, o.buyAt, o.sellDays);
  return o.score;
}

/** Tradable opportunities, best first. */
export function rank(
  opportunities: Array<Opportunity | null>,
  sortBy: SortBy = "score",
): Opportunity[] {
  const tradable = opportunities.filter(
    (o): o is Opportunity => o !== null && o.rejects.length === 0 && o.margin > 0,
  );
  return tradable.sort((a, b) => sortKey(b, sortBy) - sortKey(a, sortBy));
}
