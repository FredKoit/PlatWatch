/** Response shapes, transcribed from live payloads rather than from docs. */

export type OrderType = "sell" | "buy";

/**
 * `ingame` and `online` are reachable right now; `offline` players hold the
 * cheapest orders on most items but cannot be traded with. See stale-order
 * handling in the ranking layer.
 */
export type UserStatus = "ingame" | "online" | "offline";

export interface WfmUser {
  id: string;
  ingameName: string;
  slug: string;
  avatar?: string;
  reputation: number;
  platform: string;
  crossplay: boolean;
  locale: string;
  status: UserStatus;
  activity?: { type: string; details: string; startedAt?: string };
  /** Last login. Independent of order freshness — a player can be online with a years-old order. */
  lastSeen?: string;
}

export interface WfmOrder {
  id: string;
  type: OrderType;
  platinum: number;
  quantity: number;
  perTrade: number;
  visible: boolean;
  createdAt: string;
  /** The freshness signal that matters. Not the same as the seller being online. */
  updatedAt: string;
  itemId: string;
  user: WfmUser;

  // Variant fields. Present only when the item HAS that dimension, and they
  // are load-bearing: a rank-10 mod and a rank-0 mod are different goods that
  // trade at different prices, as are intact and radiant relics. Comparing
  // across them produces nonsense like a "1250% profit".
  /** Mods and arcanes: 0 to max. Absent for items without ranks. */
  rank?: number;
  /** Relics (intact/exceptional/flawless/radiant), arcanes, kuva variants. */
  subtype?: string;
  /** Ayatan sculptures. */
  amberStars?: number;
  cyanStars?: number;
}

/**
 * Canonical key for an order's variant. Empty string means the item has no
 * variant dimension at all, which covers prime sets and parts.
 */
export function variantKey(o: {
  rank?: number;
  subtype?: string;
  amberStars?: number;
  cyanStars?: number;
}): string {
  const parts: string[] = [];
  // "regular" is the neutral subtype and is reported inconsistently: an order
  // for a ranked mod carries subtype "regular" while its price history carries
  // only mod_rank. Dropping it is what makes the two sources join.
  if (o.subtype && o.subtype !== "regular") parts.push(o.subtype);
  if (o.rank !== undefined) parts.push(`r${o.rank}`);
  if (o.amberStars !== undefined) parts.push(`a${o.amberStars}`);
  if (o.cyanStars !== undefined) parts.push(`c${o.cyanStars}`);
  return parts.join("/");
}

/**
 * The same key, derived from a v1 statistics bucket, which uses different
 * field names for the identical concepts.
 */
export function statVariantKey(b: {
  mod_rank?: number;
  subtype?: string;
  amber_stars?: number;
  cyan_stars?: number;
}): string {
  return variantKey({
    ...(b.mod_rank !== undefined ? { rank: b.mod_rank } : {}),
    ...(b.subtype !== undefined ? { subtype: b.subtype } : {}),
    ...(b.amber_stars !== undefined ? { amberStars: b.amber_stars } : {}),
    ...(b.cyan_stars !== undefined ? { cyanStars: b.cyan_stars } : {}),
  });
}

export interface TopOrders {
  sell: WfmOrder[];
  buy: WfmOrder[];
}

export interface WfmItemSummary {
  id: string;
  slug: string;
  gameRef: string;
  tags: string[];
  i18n: Record<string, { name: string; icon?: string; thumb?: string }>;
}

export interface WfmItemDetail extends WfmItemSummary {
  /** True for the assembled set; its `setParts` also contains its own id. */
  setRoot?: boolean;
  setParts?: string[];
  /**
   * How many of this part one set needs. Dual-wield and akimbo weapons need 2
   * of most components — assuming 1 flips the sign of a set-arbitrage result.
   */
  quantityInSet?: number;
  ducats?: number;
  reqMasteryRank?: number;
  tradingTax?: number;
  tradable: boolean;
  vaulted?: boolean;
}

export interface WfmVersions {
  id: string;
  collections: Record<string, string>;
}

/** One bucket of closed price history (v1 statistics). */
export interface StatBucket {
  datetime: string;
  /** Mods and arcanes: history is a separate series per rank. */
  mod_rank?: number;
  /** Relics: separate series per intact/exceptional/flawless/radiant. */
  subtype?: string;
  amber_stars?: number;
  cyan_stars?: number;
  volume: number;
  min_price: number;
  max_price: number;
  open_price: number;
  closed_price: number;
  avg_price: number;
  wa_price: number;
  median: number;
  moving_avg?: number;
}

export interface ItemStatistics {
  slug: string;
  /** Hourly buckets covering the last 48 hours. */
  hourly: StatBucket[];
  /** Daily buckets covering the last 90 days. */
  daily: StatBucket[];
}
