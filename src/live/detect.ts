import type { WfmOrder, UserStatus } from "../wfm/types";
import { variantKey } from "../wfm/types";

/**
 * Deciding whether a freshly posted order is worth whispering about.
 *
 * Pure, so the policy can be tested without polling. Two directions matter:
 *
 *  - someone lists a SELL well under the going rate — buy it and re-list;
 *  - someone posts a BUY well over the going ask — buy from the market and
 *    fill their order immediately.
 *
 * The second is the better trade when it appears: both legs are priced now,
 * so there is no waiting for a counterparty.
 */

export interface Baseline {
  itemId: string;
  slug: string;
  name: string;
  /** The variant this price describes. Must match the order exactly. */
  variant: string;
  /** Median of the top asks at the last sweep: the robust reference price. */
  fairValue: number | null;
  /**
   * Median of COMPLETED trades over 7 days, per variant. The fallback when the
   * book is one-sided, and the only price a bid-only variant ever has.
   */
  median7d: number | null;
  lowSell: number | null;
  volume48h: number | null;
  lastTradedDay: string | null;
  /** When the baseline sweep ran. */
  snapshotAt: string;
  /** Set when this book was refreshed from the live feed since that sweep. */
  liveAt?: string | null;
}

export interface AlertPolicy {
  /** A sell must be at or below this fraction of fair value. */
  sellDiscount: number;
  /** A buy must be at or above this multiple of the current ask. */
  buyPremium: number;
  minProfit: number;
  minVolume48h: number;
  /** Beyond this, the comparison price is too old to trust. */
  maxBaselineAgeH: number;
  /** Only alert on players you can actually reach right now. */
  reachableOnly: boolean;
  /** Discounts steeper than this are flagged: usually a typo or a bait listing. */
  suspiciousDiscount: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  sellDiscount: 0.8,
  buyPremium: 1.15,
  minProfit: 10,
  minVolume48h: 6,
  maxBaselineAgeH: 36,
  reachableOnly: true,
  suspiciousDiscount: 0.3,
};

export type AlertKind = "underpriced_sell" | "overpriced_buy";

export interface Alert {
  kind: AlertKind;
  orderId: string;
  itemId: string;
  slug: string;
  name: string;
  variant: string;
  /** The price on the order that triggered this. */
  platinum: number;
  /** What it was judged against: fair value for a sell, the ask for a buy. */
  reference: number;
  profit: number;
  profitPct: number;
  volume48h: number;
  ingameName: string;
  userStatus: UserStatus;
  baselineAgeH: number;
  /** True when the price is so far off it is more likely a mistake than a deal. */
  suspicious: boolean;
  /** Ready to paste into the game chat. */
  whisper: string;
}

const REACHABLE: UserStatus[] = ["ingame", "online"];

/**
 * warframe.market's own whisper format. Sellers recognise it, which matters
 * more than it sounds — an unfamiliar message gets ignored.
 */
export function whisperFor(
  ingameName: string,
  itemName: string,
  platinum: number,
  side: "buy" | "sell",
): string {
  const verb = side === "buy" ? "buy" : "sell";
  return `/w ${ingameName} Hi! I want to ${verb}: "${itemName}" for ${platinum} platinum. (warframe.market)`;
}

function hoursBetween(iso: string, now: number): number {
  return (now - Date.parse(iso)) / 3_600_000;
}

function daysSince(day: string | null, now: number): number | null {
  if (!day) return null;
  return (now - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
}

/**
 * Returns an alert, or null when the order is unremarkable.
 *
 * Deliberately silent rather than explanatory: this runs on every order posted
 * market-wide, and collecting reasons for the ~99% that are ordinary would cost
 * more than the decision itself.
 */
export function detect(
  order: WfmOrder,
  baseline: Baseline | undefined,
  policy: AlertPolicy = DEFAULT_ALERT_POLICY,
  now = Date.now(),
): Alert | null {
  if (!baseline || !order.visible) return null;
  if (policy.reachableOnly && !REACHABLE.includes(order.user.status)) return null;

  const volume = baseline.volume48h ?? 0;
  if (volume < policy.minVolume48h) return null;

  // An item whose history stopped has no current price to compare against.
  const historyAge = daysSince(baseline.lastTradedDay, now);
  if (historyAge === null || historyAge > 2) return null;

  const baselineAgeH = hoursBetween(baseline.snapshotAt, now);
  if (baselineAgeH > policy.maxBaselineAgeH) return null;

  // A baseline for a different variant is a price for a different good.
  if (baseline.variant !== variantKey(order)) return null;

  const common = {
    orderId: order.id,
    itemId: baseline.itemId,
    slug: baseline.slug,
    name: baseline.name,
    variant: baseline.variant,
    platinum: order.platinum,
    volume48h: volume,
    ingameName: order.user.ingameName,
    userStatus: order.user.status,
    baselineAgeH: Number(baselineAgeH.toFixed(2)),
  };

  if (order.type === "sell") {
    // Two candidate reference prices, and they measure different things.
    // fairValue is the median of standing ASKS — what sellers hope for, which
    // they can set to anything. median7d is the median of COMPLETED trades —
    // what buyers actually paid.
    //
    // Take the lower. An item whose book asks 60p while it trades at 14.5p has
    // an ask-median that is fiction, and calling a 35p listing "underpriced"
    // against it invites buying well above market. Being conservative here only
    // ever costs a missed alert; being optimistic costs platinum.
    const asked = baseline.fairValue;
    const traded = baseline.median7d ?? null;
    const reference =
      asked !== null && traded !== null ? Math.min(asked, traded) : (asked ?? traded);
    if (reference === null) return null;
    if (order.platinum > reference * policy.sellDiscount) return null;

    const profit = reference - order.platinum;
    if (profit < policy.minProfit) return null;

    return {
      ...common,
      kind: "underpriced_sell",
      reference,
      profit,
      profitPct: profit / reference,
      // Either the listing is far under the reference, or the book itself has
      // detached from what the item trades at.
      suspicious:
        order.platinum < reference * policy.suspiciousDiscount ||
        (asked !== null && traded !== null && asked > traded * 3),
      whisper: whisperFor(order.user.ingameName, baseline.name, order.platinum, "buy"),
    };
  }

  // A buy order is only actionable if we can source the item right now, so it
  // is judged against the live ask rather than the median.
  const reference = baseline.lowSell;
  if (reference === null) return null;
  if (order.platinum < reference * policy.buyPremium) return null;

  const profit = order.platinum - reference;
  if (profit < policy.minProfit) return null;

  // The ask itself may be the anomaly. A single 1p listing on a mod that trades
  // near 30p turns a routine bid into an apparent 30x return — the trade may be
  // real, but the certainty is not, and one live observation is not a market.
  const suspiciousAsk =
    baseline.median7d !== null &&
    baseline.median7d !== undefined &&
    reference < baseline.median7d * policy.suspiciousDiscount;

  return {
    ...common,
    kind: "overpriced_buy",
    reference,
    profit,
    profitPct: profit / reference,
    suspicious: suspiciousAsk,
    whisper: whisperFor(order.user.ingameName, baseline.name, order.platinum, "sell"),
  };
}
