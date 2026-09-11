import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Alert } from "./detect";

/**
 * Where an alert goes.
 *
 * Speed of arrival is the whole product here: an underpriced listing is gone in
 * minutes, so a dashboard you check hourly is worthless. The console sink rings
 * the terminal bell; the Discord sink reaches a phone.
 */

export interface Sink {
  name: string;
  send(alert: Alert): Promise<void>;
}

const money = (n: number) => `${n}p`;

export function formatAlert(alert: Alert): string {
  const arrow = alert.kind === "underpriced_sell" ? "BUY " : "SELL";
  const against =
    alert.kind === "underpriced_sell"
      ? `median ${money(alert.reference)}`
      : `ask ${money(alert.reference)}`;

  return (
    `${arrow} ${alert.name} @ ${money(alert.platinum)} ` +
    `(${against}, +${money(alert.profit)} / ${(alert.profitPct * 100).toFixed(0)}%) ` +
    `· vol ${alert.volume48h}/48h · ${alert.ingameName} [${alert.userStatus}]` +
    (alert.suspicious ? " · SUSPICIOUS: price far below market, likely a mistake or bait" : "")
  );
}

export const consoleSink: Sink = {
  name: "console",
  async send(alert) {
    const stamp = new Date().toLocaleTimeString();
    // \x07 rings the terminal bell — the point is to notice within minutes. But
    // only in a real terminal: run unattended, stdout is a log file, and the
    // bell is just a control character nobody will ever hear.
    const bell = process.stdout.isTTY ? "\x07" : "";
    process.stdout.write(`${bell}\n[${stamp}] ${formatAlert(alert)}\n    ${alert.whisper}\n`);
  },
};

/** The two lines of a toast for a batch of alerts. Pure, so it can be tested. */
export function toastContent(alerts: Alert[]): { title: string; body: string } {
  // Lead with the best genuine find; a suspicious one only leads if it is all
  // there is, since it is more often a typo or bait than an opportunity.
  const best = [...alerts].sort(
    (a, b) => Number(a.suspicious) - Number(b.suspicious) || b.profit - a.profit,
  )[0]!;
  const verb = best.kind === "underpriced_sell" ? "Buy" : "Sell";
  const headline = `${verb} ${best.name} @ ${best.platinum}p (+${best.profit}p)`;
  const detail =
    `vs ${best.reference}p · vol ${best.volume48h}/48h · ${best.ingameName}` +
    (best.suspicious ? " · suspicious: likely a mistake or bait" : "");

  if (alerts.length === 1) return { title: headline, body: detail };
  return {
    title: `${alerts.length} new PlatWatch alerts`,
    body: `Best: ${headline} — ${detail}`,
  };
}

/**
 * Windows toast notifications — the channel that works when nobody is at a
 * terminal.
 *
 * Run from Task Scheduler, the daemon's stdout is a log file, so without this
 * every alert went nowhere anyone would see it. The sniper exists because an
 * underpriced listing is gone within minutes; a notification in a log file is
 * the same as none.
 *
 * Alerts are batched for a few seconds so a burst becomes one toast rather than
 * a stack of them. Clicking a toast opens the UI, where the whisper can be
 * copied — it is deliberately not put on the clipboard for you.
 */
export function toastSink(opts: {
  url: string;
  batchMs?: number;
  /** Injectable for tests; defaults to running scripts/toast.ps1. */
  show?: (content: { title: string; body: string }, url: string) => void;
}): Sink {
  const batchMs = opts.batchMs ?? 3_000;
  const show = opts.show ?? showToast;
  let pending: Alert[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    show(toastContent(batch), opts.url);
  };

  return {
    name: "toast",
    async send(alert) {
      pending.push(alert);
      if (!timer) timer = setTimeout(flush, batchMs);
    },
  };
}

const TOAST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "toast.ps1");

/**
 * Hand the text to scripts/toast.ps1 through environment variables — never on
 * the command line. Item and player names come from warframe.market, and one
 * spliced into a PowerShell command could run code on this machine.
 */
function showToast(content: { title: string; body: string }, url: string): void {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", TOAST_SCRIPT],
    {
      env: { ...process.env, PW_TITLE: content.title, PW_BODY: content.body, PW_URL: url },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  // A missing PowerShell must not take the daemon down with it.
  child.on("error", () => {});
  child.unref();
}

/**
 * Discord webhook. Set DISCORD_WEBHOOK_URL to enable.
 *
 * The whisper goes in a fenced block so it can be copied on a phone in one tap.
 */
export function discordSink(webhookUrl: string): Sink {
  return {
    name: "discord",
    async send(alert) {
      const body = {
        content:
          `**${formatAlert(alert)}**\n` +
          "```\n" +
          alert.whisper +
          "\n```",
      };
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`discord webhook returned ${res.status}`);
      }
    },
  };
}

/**
 * Fan out to every sink, never letting one failure suppress an alert.
 * A dead webhook must not cost you the console line.
 */
export function fanOut(sinks: Sink[]): (alert: Alert) => Promise<void> {
  return async (alert) => {
    const results = await Promise.allSettled(sinks.map((s) => s.send(alert)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(
          `  [${sinks[i]!.name} sink failed: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }]`,
        );
      }
    });
  };
}
