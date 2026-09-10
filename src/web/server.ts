import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/index";
import {
  logWhisper,
  opportunities,
  pendingWhispers,
  recentAlerts,
  resolveWhisper,
  setWatched,
  status,
} from "./api";
import { closeTrade, deleteTrade, listTrades, openTrade, pnl } from "../trade/journal";
import { DEFAULT_DUCAT_POLICY, ducatOpportunities, planSpend } from "../rank/ducats";

/**
 * A local, dependency-free HTTP server.
 *
 * Binds to loopback only: the database holds your own trade history and there
 * is no authentication, so it must not be reachable from the network.
 */

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), "ui.html");

function json(res: ServerResponse, body: unknown, code = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function createApp(db: Db) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        // Read per request so the page can be edited without a restart.
        const html = await readFile(UI_PATH, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && path === "/api/status") {
        json(res, status(db));
        return;
      }

      if (req.method === "GET" && path === "/api/opportunities") {
        const kindParam = url.searchParams.get("kind");
        const capital = url.searchParams.get("maxBuyAt");
        const sort = url.searchParams.get("sort");
        json(
          res,
          opportunities(db, {
            ...(kindParam === "spread" || kindParam === "set" ? { kind: kindParam } : {}),
            ...(capital && Number(capital) > 0 ? { maxBuyAt: Number(capital) } : {}),
            ...(sort === "return" ? { sortBy: "return" as const } : {}),
            limit: Number(url.searchParams.get("limit") ?? 100),
            watchedOnly: url.searchParams.get("watched") === "1",
          }),
        );
        return;
      }

      if (req.method === "GET" && path === "/api/ducats") {
        const capital = url.searchParams.get("maxBuyAt");
        const budget = Number(url.searchParams.get("budget") ?? 0);
        const rows = ducatOpportunities(db, {
          ...DEFAULT_DUCAT_POLICY,
          ...(capital && Number(capital) > 0 ? { maxBuyAt: Number(capital) } : {}),
        });
        json(res, {
          rows: rows.slice(0, Number(url.searchParams.get("limit") ?? 100)),
          total: rows.length,
          plan: budget > 0 ? planSpend(rows, budget) : null,
        });
        return;
      }

      if (req.method === "GET" && path === "/api/alerts") {
        json(res, recentAlerts(db, Number(url.searchParams.get("limit") ?? 50)));
        return;
      }

      if (req.method === "GET" && path === "/api/whispers") {
        json(res, pendingWhispers(db));
        return;
      }

      if (req.method === "POST" && path === "/api/whispers") {
        const b = await readBody(req);
        const id = logWhisper(db, {
          itemId: String(b["itemId"]),
          userId: String(b["userId"]),
          ingameName: String(b["ingameName"]),
          platinum: Number(b["platinum"]),
          ...(b["orderId"] ? { orderId: String(b["orderId"]) } : {}),
          ...(b["note"] ? { note: String(b["note"]) } : {}),
        });
        json(res, { id }, 201);
        return;
      }

      if (req.method === "PATCH" && path.startsWith("/api/whispers/")) {
        const id = Number(path.slice("/api/whispers/".length));
        const b = await readBody(req);
        resolveWhisper(db, id, {
          ...(b["replied"] !== undefined ? { replied: Boolean(b["replied"]) } : {}),
          ...(b["traded"] !== undefined ? { traded: Boolean(b["traded"]) } : {}),
        });
        json(res, { ok: true });
        return;
      }

      if (req.method === "GET" && path === "/api/trades") {
        json(res, listTrades(db, Number(url.searchParams.get("limit") ?? 100)));
        return;
      }

      if (req.method === "GET" && path === "/api/pnl") {
        json(res, pnl(db));
        return;
      }

      if (req.method === "POST" && path === "/api/trades") {
        const b = await readBody(req);
        const id = openTrade(db, {
          itemId: String(b["itemId"]),
          variant: String(b["variant"] ?? ""),
          quantity: Number(b["quantity"] ?? 1),
          buyPrice: Number(b["buyPrice"]),
          ...(b["boughtFrom"] ? { boughtFrom: String(b["boughtFrom"]) } : {}),
          ...(b["expectedSell"] !== undefined ? { expectedSell: Number(b["expectedSell"]) } : {}),
          ...(b["expectedMargin"] !== undefined
            ? { expectedMargin: Number(b["expectedMargin"]) }
            : {}),
          ...(b["source"] ? { source: b["source"] as "spread" | "set" | "alert" | "manual" } : {}),
        });
        json(res, { id }, 201);
        return;
      }

      if (req.method === "PATCH" && path.startsWith("/api/trades/")) {
        const id = Number(path.slice("/api/trades/".length));
        const b = await readBody(req);
        closeTrade(db, id, {
          sellPrice: Number(b["sellPrice"]),
          ...(b["soldTo"] ? { soldTo: String(b["soldTo"]) } : {}),
        });
        json(res, { ok: true });
        return;
      }

      if (req.method === "DELETE" && path.startsWith("/api/trades/")) {
        deleteTrade(db, Number(path.slice("/api/trades/".length)));
        json(res, { ok: true });
        return;
      }

      if (req.method === "POST" && path === "/api/watch") {
        const b = await readBody(req);
        setWatched(db, String(b["itemId"]), String(b["variant"] ?? ""), Boolean(b["on"]));
        json(res, { ok: true });
        return;
      }

      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
