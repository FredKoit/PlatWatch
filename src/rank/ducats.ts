import type { Db } from "../db/index";
import { LIVE_OVERLAY, liveCutoff } from "../live/book";
import { latestSweepId } from "./query";

/**
 * Ducat conversion — the Baro Ki'Teer play.
 *
 * Deliberately NOT part of the platinum ranking. Every other strategy here buys
 * and sells in platinum, so a margin is a margin. This one spends platinum to
 * acquire a different currency, and the return is denominated in ducats. Mixing
 * the two into one "score" would compare quantities that are not comparable —
 * the same conflation that made rank-0 and rank-10 mods look like one market.
 *
 * The trade: prime parts convert to a fixed number of ducats regardless of what
 * you paid, so a 45-ducat part bought at 2p yields 22.5 ducats per platinum
 * while the same part at 20p yields 2.25. Only the purchase price varies, which
 * makes this unusually clean to rank.
 */

export interface DucatPolicy {
  /** Below this the conversion is not worth the trading time. */
  minDucatsPerPlat: number;
  /** You are buying, so you need people willing to sell. */
  minVolume48h: number;
  minSellOrders: number;
  maxBookAgeHours: number;
  /**
   * An ask far above what the item trades at is not a price you would pay.
   * Same guard as the platinum paths: sellers set asks, trades set value.
   */
  maxAskAboveTraded: number;
  /** Most platinum to spend on a single item, or null for no limit. */
  maxBuyAt: number | null;
}

export const DEFAULT_DUCAT_POLICY: DucatPolicy = {
  minDucatsPerPlat: 10,
  minVolume48h: 6,
  minSellOrders: 3,
  maxBookAgeHours: 72,
  maxAskAboveTraded: 1.5,
  maxBuyAt: null,
};

export interface DucatRow {
  itemId: string;
  slug: string;
  name: string;
  ducats: number;
  /** Cheapest live ask — what you would actually pay. */
  buyAt: number;
  ducatsPerPlat: number;
  volume48h: number;
  tradedMedian: number | null;
  bookAgeH: number | null;
  sellCount: number;
  liveAt: string | null;
  rejects: string[];
}

interface RawDucatRow extends Omit<DucatRow, "ducatsPerPlat" | "rejects"> {}

export function ducatCandidates(db: Db, sweepId: number): RawDucatRow[] {
  return db
    .prepare(
      `SELECT i.id AS itemId, i.slug, i.name, i.ducats,
              ${LIVE_OVERLAY.lowSell} AS buyAt,
              ${LIVE_OVERLAY.liveAt}  AS liveAt,
              s.sell_count AS sellCount,
              s.newest_sell_age_h AS bookAgeH,
              ss.volume_48h AS volume48h,
              ss.median_7d AS tradedMedian
         FROM item i
         JOIN snapshot s ON s.item_id = i.id AND s.sweep_id = @sweep AND s.variant = ''
         LEFT JOIN live_book lb ON lb.item_id = i.id AND lb.variant = ''
         LEFT JOIN stat_summary ss ON ss.item_id = i.id AND ss.variant = ''
        WHERE i.ducats > 0
          -- Set roots carry the sum of their parts' ducats, but a set almost
          -- never beats buying the parts individually: 350 ducats at 100p is
          -- 3.5 per platinum against 45 at 2p. Including them would just
          -- double-count the same components at a worse rate.
          AND (i.set_root IS NULL OR i.set_root = 0)`,
    )
    .all({ sweep: sweepId, liveCutoff: liveCutoff() }) as RawDucatRow[];
}

export function scoreDucat(
  row: RawDucatRow,
  policy: DucatPolicy = DEFAULT_DUCAT_POLICY,
): DucatRow | null {
  if (row.buyAt === null || row.buyAt <= 0) return null;

  const ducatsPerPlat = Number((row.ducats / row.buyAt).toFixed(2));
  const rejects: string[] = [];
  const volume = row.volume48h ?? 0;

  if (ducatsPerPlat < policy.minDucatsPerPlat) {
    rejects.push(`${ducatsPerPlat} ducats per platinum`);
  }
  if (volume < policy.minVolume48h) rejects.push(`volume ${volume} < ${policy.minVolume48h}`);
  if (row.sellCount < policy.minSellOrders) rejects.push(`only ${row.sellCount} sell orders`);
  if (row.bookAgeH !== null && row.bookAgeH > policy.maxBookAgeHours) {
    rejects.push(`book ${Math.round(row.bookAgeH)}h old`);
  }
  if (
    row.tradedMedian !== null &&
    row.tradedMedian > 0 &&
    row.buyAt > row.tradedMedian * policy.maxAskAboveTraded
  ) {
    rejects.push(`ask ${row.buyAt}p above the ${row.tradedMedian.toFixed(1)}p it trades at`);
  }
  if (policy.maxBuyAt !== null && row.buyAt > policy.maxBuyAt) {
    rejects.push(`needs ${row.buyAt}p up front > ${policy.maxBuyAt}p`);
  }

  return { ...row, ducatsPerPlat, rejects };
}

export function rankDucats(rows: Array<DucatRow | null>): DucatRow[] {
  return rows
    .filter((r): r is DucatRow => r !== null && r.rejects.length === 0)
    .sort((a, b) => b.ducatsPerPlat - a.ducatsPerPlat);
}

export interface DucatPlan {
  /** Platinum spent following the list from the top. */
  spent: number;
  ducats: number;
  items: number;
  /** Blended rate actually achieved, which the top row alone overstates. */
  ducatsPerPlat: number;
}

/**
 * What a given budget actually buys.
 *
 * One of each, cheapest-rate-first. Deliberately not "buy N of the best item":
 * the sell side is a handful of orders deep, so clearing one seller out is not
 * the same as buying ten at that price.
 */
export function planSpend(rows: DucatRow[], budget: number): DucatPlan {
  let spent = 0;
  let ducats = 0;
  let items = 0;
  for (const r of rows) {
    if (spent + r.buyAt > budget) continue;
    spent += r.buyAt;
    ducats += r.ducats;
    items++;
  }
  return {
    spent,
    ducats,
    items,
    ducatsPerPlat: spent > 0 ? Number((ducats / spent).toFixed(2)) : 0,
  };
}

export function ducatOpportunities(
  db: Db,
  policy: DucatPolicy = DEFAULT_DUCAT_POLICY,
): DucatRow[] {
  const sweepId = latestSweepId(db);
  if (sweepId === null) return [];
  return rankDucats(ducatCandidates(db, sweepId).map((r) => scoreDucat(r, policy)));
}
