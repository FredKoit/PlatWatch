import type { Db } from "./index";
import { latestSweepId } from "../rank/query";

/**
 * Keeps the database from growing forever.
 *
 * order_seen was adding ~108k rows a day with nothing ever removed — roughly
 * 40 MB a day, and the ranking looks it up for every row it shows. The
 * retention window is 30 days, chosen by the user.
 *
 * What goes, and what never does:
 *
 *   - An order that LEFT the book more than 30 days ago is deleted. Its only
 *     use was reachability, and that is about the recent market.
 *   - An order still on the book (left_top_at NULL) is never deleted however
 *     old it is: it is live, and exactly what the ghost signal measures.
 *   - An order your own whisper log refers to is kept, since that record is
 *     yours and the link would otherwise dangle.
 *   - Snapshots of sweeps older than the window are deleted — nothing reads any
 *     sweep but the latest — except the latest full sweep, which is always kept
 *     even if the daemon has been off for a month.
 *
 * Deleted pages are reused, so the file stops growing rather than shrinking.
 * At ~108k orders a day, a 30-day window levels off around 1 GB.
 */

export const RETENTION_DAYS = 30;

export interface RetentionResult {
  orders: number;
  snapshots: number;
}

export function applyRetention(
  db: Db,
  days: number = RETENTION_DAYS,
  now: number = Date.now(),
): RetentionResult {
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const keepSweep = latestSweepId(db) ?? -1;

  return db.transaction(() => {
    const orders = db
      .prepare(
        `DELETE FROM order_seen
          WHERE left_top_at IS NOT NULL
            AND left_top_at < @cutoff
            AND order_id NOT IN (SELECT order_id FROM whisper_log WHERE order_id IS NOT NULL)`,
      )
      .run({ cutoff }).changes;

    const snapshots = db
      .prepare(
        `DELETE FROM snapshot
          WHERE sweep_id IN (SELECT id FROM sweep WHERE started_at < @cutoff)
            AND sweep_id != @keepSweep`,
      )
      .run({ cutoff, keepSweep }).changes;

    return { orders, snapshots };
  })();
}
