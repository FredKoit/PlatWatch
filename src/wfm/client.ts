import { V2 } from "./config";
import { getV2 } from "./http";
import { PRIORITY } from "./limiter";
import type {
  TopOrders,
  WfmItemDetail,
  WfmItemSummary,
  WfmOrder,
  WfmVersions,
} from "./types";

const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

/**
 * Collection version tokens. Each value is a base64 timestamp, so the 1.6 MB
 * item list only needs refetching when `collections.items` changes.
 */
export function getVersions(signal?: AbortSignal): Promise<WfmVersions> {
  return getV2<WfmVersions>(`${V2}/versions`, opts(signal));
}

/** The full tradable catalogue (~3,840 items, ~1.6 MB). Rarely changes. */
export function getItems(signal?: AbortSignal): Promise<WfmItemSummary[]> {
  return getV2<WfmItemSummary[]>(`${V2}/items`, opts(signal));
}

/** Set membership, `quantityInSet`, ducats, MR. */
export function getItem(slug: string, signal?: AbortSignal): Promise<WfmItemDetail> {
  return getV2<WfmItemDetail>(`${V2}/item/${encodeURIComponent(slug)}`, opts(signal));
}

/**
 * Best 5 buy and 5 sell orders — already filtered by the API to players who are
 * `online` or `ingame`. ~5 KB versus ~240 KB for the unfiltered book, and it
 * discards the overwhelming majority of dead listings for free.
 *
 * The tradeoff to remember: this removes *cheap* prices, not *bad* ones. The
 * lowest sell on an item is frequently held by an offline player.
 */
export function getTopOrders(
  slug: string,
  signal?: AbortSignal,
  priority: number = PRIORITY.bulk,
): Promise<TopOrders> {
  return getV2<TopOrders>(`${V2}/orders/item/${encodeURIComponent(slug)}/top`, {
    ...opts(signal),
    priority,
  });
}

/** Every order on the item, including years-dead ones. Rarely what you want. */
export function getAllOrders(slug: string, signal?: AbortSignal): Promise<WfmOrder[]> {
  return getV2<WfmOrder[]>(`${V2}/orders/item/${encodeURIComponent(slug)}`, opts(signal));
}

/**
 * Every order posted across the market in roughly the last 10 minutes — about
 * 384 orders spanning ~313 items, in ONE request. This is the live edge: it
 * costs a single call to see what a 313-request sweep would show.
 *
 * The window is bounded by count as well as time, so it shrinks when the market
 * is busy. Poll well inside it and dedupe by order id.
 */
export function getRecentOrders(signal?: AbortSignal): Promise<WfmOrder[]> {
  // Always highest priority: this is one request that must not sit behind a
  // twenty-minute sweep, or the freshest data in the system arrives last.
  return getV2<WfmOrder[]>(`${V2}/orders/recent`, {
    ...opts(signal),
    priority: PRIORITY.live,
  });
}
