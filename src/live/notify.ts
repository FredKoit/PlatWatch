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
    // \x07 rings the terminal bell — the point is to notice within minutes.
    process.stdout.write(`\x07\n[${stamp}] ${formatAlert(alert)}\n    ${alert.whisper}\n`);
  },
};

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
