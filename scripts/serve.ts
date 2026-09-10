/**
 * Local UI.
 *
 *   tsx scripts/serve.ts                 — http://127.0.0.1:5173
 *   tsx scripts/serve.ts --port 8080
 *   tsx scripts/serve.ts --no-watchlist  — skip the frequent re-poll loop
 *
 * Binds to loopback only. The database holds your own trade history and the
 * server has no authentication, so it must not be exposed to the network.
 */
import { openDb } from "../src/db/index";
import { createApp } from "../src/web/server";
import { watchedItems } from "../src/web/api";
import { startSweep } from "../src/db/index";
import { sweepTopOrders } from "../src/ingest/sweep";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(`--${name}`);

const port = Number(flag("port") ?? 5173);
const db = openDb();
const controller = new AbortController();

const server = createApp(db);
server.listen(port, "127.0.0.1", () => {
  console.log(`FrameTax UI  →  http://127.0.0.1:${port}`);
  console.log("  loopback only · Ctrl-C to stop");
});

/**
 * Watchlist refresh.
 *
 * The nightly sweep is 22 minutes for the whole catalogue, which is far too
 * slow for something you are actively trading. Watched items get their own
 * short cycle, and because they share the global rate limiter this cannot
 * exceed the API budget no matter how many you add.
 */
const WATCH_INTERVAL_MS = 5 * 60_000;

async function refreshWatchlist(): Promise<void> {
  while (!controller.signal.aborted) {
    const items = watchedItems(db);
    if (items.length > 0) {
      const sweepId = startSweep(db, "top");
      try {
        const result = await sweepTopOrders(db, items, { sweepId, signal: controller.signal });
        console.log(
          `[watchlist] refreshed ${result.ok} item(s) in ${(result.elapsedMs / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        console.error(`[watchlist] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));
  }
}

if (!has("no-watchlist")) void refreshWatchlist();

process.on("SIGINT", () => {
  console.log("\nstopping…");
  controller.abort();
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
