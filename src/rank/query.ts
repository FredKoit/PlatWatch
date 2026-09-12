import type { Db } from "../db/index";
import type { MarketRow, SetInput, SetPartInput } from "./score";
import { LIVE_OVERLAY, liveCutoff } from "../live/book";
import { bookReader, fillFromBook } from "./depth";

/**
 * The most recent completed FULL sweep — the baseline the ranking, the sniper
 * and stats all read as "the market".
 *
 * Scope matters because every caller treats this sweep's rows as the whole
 * catalogue. A partial sweep of a few items used to win simply by being newest,
 * and the rest of the market vanished from all three at once.
 */
export function latestSweepId(db: Db): number | null {
  const row = db
    .prepare(
      `SELECT id FROM sweep
        WHERE kind = 'top' AND scope = 'full' AND finished_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

// The live feed overlays the sweep: fresher prices win where they exist and
// have not expired. See LIVE_OVERLAY for why this is CASE and not COALESCE.
const MARKET_COLUMNS = `
  i.id            AS itemId,
  i.slug          AS slug,
  i.name          AS name,
  s.variant       AS variant,
  ${LIVE_OVERLAY.lowSell} AS lowSell,
  ${LIVE_OVERLAY.highBuy} AS highBuy,
  ${LIVE_OVERLAY.liveAt}  AS liveAt,
  s.sell_p50_top  AS sellP50,
  s.sell_count    AS sellCount,
  s.buy_count     AS buyCount,
  s.newest_sell_age_h AS bookAgeH,
  ss.volume_48h   AS volume48h,
  ss.volume_7d    AS volume7d,
  ss.median_7d    AS median7d,
  ss.median_30d   AS median30d,
  ss.days_traded_30d AS daysTraded30d,
  ss.last_traded_day AS lastTradedDay,
  ss.last_traded_at  AS lastTradedAt
`;

/** Every item with a two-sided book in this sweep. */
export function spreadRows(db: Db, sweepId: number): MarketRow[] {
  return db
    .prepare(
      `SELECT ${MARKET_COLUMNS}
         FROM snapshot s
         JOIN item i ON i.id = s.item_id
         LEFT JOIN stat_summary ss ON ss.item_id = s.item_id AND ss.variant = s.variant
         LEFT JOIN live_book lb ON lb.item_id = s.item_id AND lb.variant = s.variant
        WHERE s.sweep_id = @sweep`,
    )
    .all({ sweep: sweepId, liveCutoff: liveCutoff() })
    .filter((r): r is MarketRow => {
      const row = r as MarketRow;
      // Filtered here rather than in SQL: the overlay can supply a side the
      // snapshot lacked, so a WHERE on s.low_sell would discard live rows.
      return row.lowSell !== null && row.highBuy !== null;
    });
}

/**
 * Set roots with their components, quantities, each part's ask — and what
 * buying the full quantity from reachable sellers actually costs.
 */
export function setRows(db: Db, sweepId: number, now = Date.now()): SetInput[] {
  const sets = db
    .prepare(
      `SELECT ${MARKET_COLUMNS}
         FROM snapshot s
         JOIN item i ON i.id = s.item_id
         LEFT JOIN stat_summary ss ON ss.item_id = s.item_id AND ss.variant = s.variant
         LEFT JOIN live_book lb ON lb.item_id = s.item_id AND lb.variant = s.variant
        WHERE s.sweep_id = @sweep
          AND i.set_root = 1
          AND s.variant = ''`,
    )
    .all({ sweep: sweepId, liveCutoff: liveCutoff() })
    .filter((r): r is MarketRow => (r as MarketRow).lowSell !== null);

  const partStmt = db.prepare(
    `SELECT p.id AS itemId, p.slug AS slug, p.name AS name, ip.qty AS qty,
            CASE
              WHEN plb.low_sell IS NOT NULL
               AND plb.low_sell_at > @liveCutoff
               AND (ps.low_sell IS NULL OR plb.low_sell < ps.low_sell)
              THEN plb.low_sell ELSE ps.low_sell END AS lowSell,
            pss.volume_48h AS volume48h
       FROM item_part ip
       JOIN item p ON p.id = ip.part_id
       LEFT JOIN snapshot ps ON ps.item_id = ip.part_id AND ps.sweep_id = @sweep
                            AND ps.variant = ''
       LEFT JOIN live_book plb ON plb.item_id = ip.part_id AND plb.variant = ''
       LEFT JOIN stat_summary pss ON pss.item_id = ip.part_id AND pss.variant = ''
      WHERE ip.set_id = @setId`,
  );

  const asks = bookReader(db, now);
  return sets.map((set) => ({
    set,
    parts: (
      partStmt.all({
        sweep: sweepId,
        setId: set.itemId,
        liveCutoff: liveCutoff(now),
      }) as SetPartInput[]
    ).map((p) => ({ ...p, fill: fillFromBook(asks(p.itemId, "", "sell"), p.qty) })),
  }));
}
