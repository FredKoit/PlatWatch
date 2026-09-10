/**
 * Turning a price book into a ranked list of trades.
 *
 * Everything here is pure so the policy can be tested without a crawl. The
 * database side lives in query.ts.
 */

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
  /** A book older than this is a hypothesis, not a quote. */
  maxBookAgeHours: number;
  /** History that stopped days ago describes a market that no longer exists. */
  maxHistoryStaleDays: number;
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
  maxBookAgeHours: 72,
  maxHistoryStaleDays: 2,
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
  /** Set when a side of this book came from the live feed rather than the sweep. */
  liveAt?: string | null;
}

export interface SetInput {
  set: MarketRow;
  parts: Array<{ itemId: string; name: string; qty: number; lowSell: number | null; volume48h: number | null }>;
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
}

/** Days between a YYYY-MM-DD day and now. */
function daysSince(day: string | null, now: number): number | null {
  if (!day) return null;
  return (now - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
}

/**
 * Liquidity and freshness gates, shared by both strategies.
 *
 * Returns reasons rather than a boolean: an item held back for one weak reason
 * is worth seeing, and silent filtering makes a ranking impossible to debug.
 */
export function gate(
  row: Pick<MarketRow, "volume48h" | "sellCount" | "bookAgeH" | "lastTradedDay">,
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

  const stale = daysSince(row.lastTradedDay, now);
  if (stale === null) rejects.push("no trade history");
  else if (stale > policy.maxHistoryStaleDays)
    rejects.push(`last traded ${stale.toFixed(1)}d ago`);

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
    rejects: [
      ...gate(row, policy, now),
      ...marginGate(margin, buyAt, policy),
      ...spreadRejects,
    ],
  };
}

/**
 * Set arbitrage: buy each component at its ask, assemble, undercut the set.
 *
 * `qty` is load-bearing — dual-wield sets need two of most parts, and dropping
 * the multiplier turns a loss into an apparent profit.
 *
 * Liquidity is the bottleneck part's, not the set's: assembling is only as fast
 * as the rarest component. An unpriced part makes the edge unknown, not zero.
 */
export function scoreSet(
  input: SetInput,
  policy: RankingPolicy = DEFAULT_POLICY,
  now = Date.now(),
): Opportunity | null {
  const { set, parts } = input;
  if (set.lowSell === null || parts.length === 0) return null;

  const unpriced = parts.filter((p) => p.lowSell === null);
  if (unpriced.length > 0) {
    return {
      itemId: set.itemId,
      slug: set.slug,
      name: set.name,
      variant: set.variant,
      liveAt: set.liveAt ?? null,
      kind: "set",
      buyAt: 0,
      sellAt: set.lowSell,
      margin: 0,
      marginPct: 0,
      volume48h: set.volume48h ?? 0,
      bookAgeH: set.bookAgeH,
      sellCount: set.sellCount,
      score: 0,
      rejects: [`${unpriced.length} component(s) unpriced — edge unknown`],
      detail: unpriced.map((p) => p.name).join(", "),
    };
  }

  const cost = parts.reduce((sum, p) => sum + p.lowSell! * p.qty, 0);
  const sellAt = set.lowSell - policy.undercut;
  const margin = sellAt - cost;

  const bottleneck = Math.min(
    set.volume48h ?? 0,
    ...parts.map((p) => p.volume48h ?? 0),
  );

  return {
    itemId: set.itemId,
    slug: set.slug,
    name: set.name,
    variant: set.variant,
    liveAt: set.liveAt ?? null,
    kind: "set",
    buyAt: cost,
    sellAt,
    margin,
    marginPct: cost > 0 ? margin / cost : 0,
    volume48h: bottleneck,
    bookAgeH: set.bookAgeH,
    sellCount: set.sellCount,
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
  | "return";

/** Tradable opportunities, best first. */
export function rank(
  opportunities: Array<Opportunity | null>,
  sortBy: SortBy = "score",
): Opportunity[] {
  const tradable = opportunities.filter(
    (o): o is Opportunity => o !== null && o.rejects.length === 0 && o.margin > 0,
  );
  return sortBy === "return"
    ? tradable.sort((a, b) => b.marginPct - a.marginPct)
    : tradable.sort((a, b) => b.score - a.score);
}
