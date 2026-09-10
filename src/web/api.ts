import type { Db } from "../db/index";
import { latestSweepId, setRows, spreadRows } from "../rank/query";
import {
  DEFAULT_POLICY,
  rank,
  scoreSet,
  scoreSpread,
  type Opportunity,
  type RankingPolicy,
  type SortBy,
} from "../rank/score";
import { whisperFor } from "../live/detect";

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

/** One component you must acquire to assemble a set. */
export interface PartOffer {
  itemId: string;
  name: string;
  qty: number;
  price: number | null;
  seller: Counterparty | null;
  whisper: string | null;
}

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
  /** Whom you would actually message, and the message itself. */
  seller: Counterparty | null;
  buyer: Counterparty | null;
  playKind: PlayKind;
  /** For "post": the two orders to place, and wait for. */
  postBuyAt: number | null;
  postSellAt: number | null;
  /**
   * An active attempt at the buy leg — offering the cheapest seller the price
   * the model assumes, not their asking price. Often declined; that is the
   * strategy, not a fault.
   */
  lowballWhisper: string | null;
  /** For "buy-parts": every component, each at its own seller's ask. */
  parts: PartOffer[] | null;
  watched: boolean;
  /** Age of the price this row is built on. */
  priceAgeH: number | null;
  /**
   * Consecutive sweeps the cheapest ask has held its position without selling.
   * A high number is the ghost signal: nobody is buying it at that price, so
   * either the seller does not respond or the price is fiction.
   */
  ghostSweeps: number;
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
  if (q.kind !== "set") all.push(...spreadRows(db, sweepId).map((r) => scoreSpread(r, policy)));
  if (q.kind !== "spread") all.push(...setRows(db, sweepId).map((s) => scoreSet(s, policy)));

  const ranked = rank(all, q.sortBy ?? "score");
  const stats = sellerStats(db);

  const watched = new Set(
    (
      db.prepare("SELECT item_id, variant FROM watchlist").all() as Array<{
        item_id: string;
        variant: string;
      }>
    ).map((w) => `${w.item_id}|${w.variant}`),
  );

  // Best live order per side, still on the book, for the whisper target.
  const bestOrder = db.prepare(
    `SELECT user_id, ingame_name, platinum, sweeps_at_best
       FROM order_seen
      WHERE item_id = @itemId AND variant = @variant AND type = @type
        AND left_top_at IS NULL
      ORDER BY CASE WHEN @type = 'sell' THEN platinum END ASC,
               CASE WHEN @type = 'buy'  THEN platinum END DESC
      LIMIT 1`,
  );

  const partsOf = db.prepare(
    `SELECT p.id AS itemId, p.name AS name, ip.qty AS qty, ps.low_sell AS price
       FROM item_part ip
       JOIN item p ON p.id = ip.part_id
       LEFT JOIN snapshot ps ON ps.item_id = ip.part_id AND ps.sweep_id = @sweep
                            AND ps.variant = ''
      WHERE ip.set_id = @setId
      ORDER BY p.name`,
  );

  const takenAt = db
    .prepare("SELECT taken_at FROM snapshot WHERE sweep_id = ? LIMIT 1")
    .get(sweepId) as { taken_at: string } | undefined;
  const priceAgeH = takenAt
    ? (Date.now() - Date.parse(takenAt.taken_at)) / 3_600_000
    : null;

  const rows = ranked.slice(0, q.limit ?? 100).map<Row>((o) => {
    const key = { itemId: o.itemId, variant: o.variant };
    const sellOrder = bestOrder.get({ ...key, type: "sell" }) as OrderRow | undefined;
    const seller = counterparty(sellOrder, stats);
    const buyer = counterparty(bestOrder.get({ ...key, type: "buy" }) as OrderRow, stats);

    // Set arbitrage acquires components, so a whisper about the assembled set
    // is meaningless — the seller of the set is not who you trade with.
    const parts =
      o.kind === "set"
        ? (partsOf.all({ sweep: sweepId, setId: o.itemId }) as Array<{
            itemId: string;
            name: string;
            qty: number;
            price: number | null;
          }>).map<PartOffer>((p) => {
            const po = bestOrder.get({ itemId: p.itemId, variant: "", type: "sell" }) as
              | OrderRow
              | undefined;
            const partSeller = counterparty(po, stats);
            return {
              ...p,
              seller: partSeller,
              whisper: partSeller
                ? whisperFor(partSeller.ingameName, p.name, partSeller.platinum, "buy")
                : null,
            };
          })
        : null;

    return {
      ghostSweeps: sellOrder?.sweeps_at_best ?? 0,
      ...o,
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
      watched: watched.has(`${o.itemId}|${o.variant}`),
      priceAgeH: priceAgeH === null ? null : Number(priceAgeH.toFixed(2)),
    };
  });

  return q.watchedOnly ? rows.filter((r) => r.watched) : rows;
}

export function recentAlerts(db: Db, limit = 50) {
  return db
    .prepare(
      `SELECT a.*, i.name AS item_name, i.slug AS item_slug
         FROM alert a JOIN item i ON i.id = a.item_id
        ORDER BY a.fired_at DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function status(db: Db) {
  const sweep = db
    .prepare(
      "SELECT id, started_at, finished_at, items_ok FROM sweep WHERE kind='top' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as { id: number; finished_at: string; items_ok: number } | undefined;

  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;

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
): void {
  db.prepare(
    `UPDATE whisper_log
        SET replied = COALESCE(@replied, replied),
            traded  = COALESCE(@traded, traded)
      WHERE id = @id`,
  ).run({
    id,
    replied: outcome.replied === undefined ? null : outcome.replied ? 1 : 0,
    traded: outcome.traded === undefined ? null : outcome.traded ? 1 : 0,
  });
}

export function pendingWhispers(db: Db, limit = 30) {
  return db
    .prepare(
      `SELECT w.*, i.name AS item_name
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

/** Items on the watchlist, for the frequent re-poll loop. */
export function watchedItems(db: Db): Array<{ id: string; slug: string; name: string; tags: string }> {
  return db
    .prepare(
      `SELECT DISTINCT i.id, i.slug, i.name, i.tags
         FROM watchlist w JOIN item i ON i.id = w.item_id
        ORDER BY i.slug`,
    )
    .all() as Array<{ id: string; slug: string; name: string; tags: string }>;
}
