import type { Db } from "../db/index";

const cell = (value: unknown) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function csv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]!);
  return [columns.map(cell).join(","), ...rows.map((row) => columns.map((c) => cell(row[c])).join(","))].join("\r\n") + "\r\n";
}

export type ExportKind = "trades" | "whispers" | "alerts";
export function exportCsv(db: Db, kind: ExportKind): string {
  const sql: Record<ExportKind, string> = {
    trades: `SELECT t.id, i.name AS item, t.variant, t.quantity, t.buy_price, t.bought_at,
                    t.bought_from, t.sell_price, t.sold_at, t.sold_to, t.expected_sell,
                    t.expected_margin, t.target_price, t.source, t.note
               FROM trade t JOIN item i ON i.id=t.item_id ORDER BY t.bought_at DESC`,
    whispers: `SELECT w.id, i.name AS item, w.ingame_name, w.platinum, w.sent_at,
                      w.replied, w.traded, w.note
                 FROM whisper_log w JOIN item i ON i.id=w.item_id ORDER BY w.sent_at DESC`,
    alerts: `SELECT a.id, i.name AS item, a.kind, a.platinum, a.reference, a.profit,
                    a.volume_48h, a.ingame_name, a.user_status, a.suspicious, a.fired_at
               FROM alert a JOIN item i ON i.id=a.item_id ORDER BY a.fired_at DESC`,
  };
  return csv(db.prepare(sql[kind]).all() as Array<Record<string, unknown>>);
}
