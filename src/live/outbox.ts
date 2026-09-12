import type { Db } from "../db/index";
import type { Alert } from "./detect";
import type { Notice, Sink } from "./notify";
import { getMeta, setMeta } from "../db/index";

export type Delivery =
  | { kind: "alert"; payload: Alert }
  | { kind: "notice"; payload: Notice };

interface Queued {
  id: number;
  kind: "alert" | "notice";
  payload: string;
  attempts: number;
}

/** Idempotently persist a message before attempting Discord delivery. */
export function queueDelivery(db: Db, dedupeKey: string, delivery: Delivery, now = Date.now()): void {
  const at = new Date(now).toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO notification_outbox
       (dedupe_key, kind, payload, created_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(dedupeKey, delivery.kind, JSON.stringify(delivery.payload), at, at);
}

/**
 * Deliver due messages. Failures stay queued with bounded exponential backoff;
 * successful rows are removed. The outbox survives daemon restarts.
 */
export async function deliverPending(
  db: Db,
  sink: Sink,
  now = Date.now(),
  limit = 50,
): Promise<{ delivered: number; failed: number; pending: number }> {
  const due = db.prepare(
    `SELECT id, kind, payload, attempts FROM notification_outbox
      WHERE next_attempt_at <= ? ORDER BY id LIMIT ?`,
  ).all(new Date(now).toISOString(), limit) as Queued[];
  let delivered = 0;
  let failed = 0;
  if (due.length) setMeta(db, `notify:${sink.name}:lastAttempt`, new Date(now).toISOString());
  for (const row of due) {
    try {
      const payload = JSON.parse(row.payload) as Alert | Notice;
      if (row.kind === "alert") await sink.send(payload as Alert);
      else if (sink.notify) await sink.notify(payload as Notice);
      else throw new Error(`${sink.name} cannot deliver notices`);
      db.prepare("DELETE FROM notification_outbox WHERE id = ?").run(row.id);
      delivered++;
      setMeta(db, `notify:${sink.name}:lastSuccess`, new Date(now).toISOString());
      setMeta(db, `notify:${sink.name}:lastError`, "");
    } catch (error) {
      const attempts = row.attempts + 1;
      const delay = Math.min(60, 2 ** Math.min(6, attempts - 1)) * 60_000;
      db.prepare(
        `UPDATE notification_outbox
            SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
      ).run(
        attempts,
        new Date(now + delay).toISOString(),
        error instanceof Error ? error.message : String(error),
        row.id,
      );
      failed++;
      setMeta(db, `notify:${sink.name}:lastError`, error instanceof Error ? error.message : String(error));
    }
  }
  const pending = (db.prepare("SELECT COUNT(*) c FROM notification_outbox").get() as { c: number }).c;
  return { delivered, failed, pending };
}
