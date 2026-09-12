import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/index";
import {
  logWhisper,
  opportunities,
  pendingWhispers,
  priceHistory,
  recentAlerts,
  alertPerformance,
  setAlertFeedback,
  resolveWhisper,
  setArbitrage,
  setWatched,
  status,
  tradePlan,
} from "./api";
import { closeTrade, correctTrade, deleteTrade, listTrades, openTrade, pnl, setTradeTarget, tradeAudit } from "../trade/journal";
import { DEFAULT_DUCAT_POLICY, ducatOpportunities, planSpend } from "../rank/ducats";
import { refreshWatched } from "../ingest/watchlist";
import { backupDatabase, listBackups } from "../db/backup";
import { exportCsv, type ExportKind } from "./export";
import { appSettings, saveAppSettings, type AppSettings } from "../config/settings";
import type { Notice } from "../live/notify";

/**
 * A local, dependency-free HTTP server.
 *
 * Binds to loopback only: the database holds your own trade history and there
 * is no authentication, so it must not be reachable from the network.
 */

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), "ui.html");
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");

function json(res: ServerResponse, body: unknown, code = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function text(res: ServerResponse, body: string, type: string, filename?: string): void {
  res.writeHead(200, {
    "content-type": `${type}; charset=utf-8`,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...(filename ? { "content-disposition": `attachment; filename="${filename}"` } : {}),
  });
  res.end(body);
}

const integer = (value: unknown, min: number, max = 1_000_000) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const shortText = (value: unknown, max = 200) =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;

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

export function createApp(db: Db, opts: {
  testNotification?: (notice: Notice) => Promise<void>;
  refreshMarkets?: typeof refreshWatched;
  restoreBackup?: (name: string) => Promise<void>;
} = {}) {
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

      if (req.method === "GET" && (path === "/assets/ui.css" || path === "/assets/ui.js" || path === "/assets/core.js")) {
        const name = path.slice("/assets/".length);
        const body = await readFile(join(ASSET_DIR, name), "utf8");
        text(res, body, name.endsWith(".css") ? "text/css" : "text/javascript");
        return;
      }

      if (req.method === "GET" && path === "/api/settings") { json(res, appSettings(db)); return; }
      if (req.method === "PUT" && path === "/api/settings") {
        const b = await readBody(req); const a = b["alert"] as Record<string, unknown> | undefined;
        const confidence = b["minConfidence"];
        const next: AppSettings = {
          discordWebhook: typeof b["discordWebhook"] === "string" ? b["discordWebhook"].trim() : "",
          defaultBudget: integer(b["defaultBudget"], 0, 1_000_000) ?? -1,
          maxPerItem: integer(b["maxPerItem"], 0, 1_000_000) ?? -1,
          cashReserve: integer(b["cashReserve"], 0, 1_000_000) ?? -1,
          maxPerGroup: integer(b["maxPerGroup"], 1, 100) ?? -1,
          minConfidence: confidence === "low" || confidence === "medium" || confidence === "high" ? confidence : "medium",
          pollSeconds: integer(b["pollSeconds"], 15, 3600) ?? -1,
          alert: { sellDiscount: Number(a?.["sellDiscount"]), buyPremium: Number(a?.["buyPremium"]),
            minProfit: integer(a?.["minProfit"], 0, 100000) ?? -1, minVolume48h: integer(a?.["minVolume48h"], 0, 100000) ?? -1 },
        };
        if (next.defaultBudget < 0 || next.maxPerItem < 0 || next.cashReserve < 0 || next.maxPerGroup < 1 || next.pollSeconds < 0 || next.alert.minProfit < 0 ||
            next.alert.minVolume48h < 0 || !(next.alert.sellDiscount > 0 && next.alert.sellDiscount <= 1) ||
            !(next.alert.buyPremium >= 1 && next.alert.buyPremium <= 10) ||
            (next.discordWebhook && !/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//.test(next.discordWebhook))) {
          json(res,{error:"invalid settings"},400); return;
        }
        saveAppSettings(db,next); json(res,next); return;
      }
      if (req.method === "POST" && path === "/api/settings/test-notification") {
        if (!opts.testNotification) { json(res,{error:"notification test unavailable"},503); return; }
        await opts.testNotification({ title:"PlatWatch test", body:"Notifications are connected and working." });
        json(res,{ok:true}); return;
      }

      if (req.method === "GET" && path.startsWith("/api/export/")) {
        const kind = path.slice("/api/export/".length) as ExportKind;
        if (!(["trades", "whispers", "alerts"] as string[]).includes(kind)) {
          json(res, { error: "export must be trades, whispers, or alerts" }, 404);
          return;
        }
        text(res, exportCsv(db, kind), "text/csv", `platwatch-${kind}.csv`);
        return;
      }

      if (req.method === "POST" && path === "/api/backup") {
        json(res, await backupDatabase(db), 201);
        return;
      }
      if (req.method === "GET" && path === "/api/backups") { json(res,await listBackups()); return; }
      if (req.method === "POST" && path === "/api/restore") {
        if(!opts.restoreBackup){json(res,{error:"restore unavailable"},503);return;}
        const b=await readBody(req); const name=shortText(b["name"],240);
        if(!name || !/^platwatch-.*\.db$/.test(name)){json(res,{error:"valid backup name required"},400);return;}
        await opts.restoreBackup(name); json(res,{ok:true,restarting:true}); return;
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
            ...(sort === "return" || sort === "speed" ? { sortBy: sort } : {}),
            limit: Number(url.searchParams.get("limit") ?? 100),
            watchedOnly: url.searchParams.get("watched") === "1",
          }),
        );
        return;
      }

      if (req.method === "GET" && path === "/api/plan") {
        const cap = url.searchParams.get("maxPerItem");
        const reserve = url.searchParams.get("cashReserve");
        const groupCap = url.searchParams.get("maxPerGroup");
        const sort = url.searchParams.get("sort");
        const conf = url.searchParams.get("minConfidence");
        json(
          res,
          tradePlan(db, {
            budget: Math.max(0, Number(url.searchParams.get("budget") ?? 0) || 0),
            maxPerItem: cap && Number(cap) > 0 ? Number(cap) : null,
            cashReserve: reserve ? Math.max(0, Number(reserve) || 0) : 0,
            maxPerGroup: groupCap && Number(groupCap) > 0 ? Number(groupCap) : null,
            ...(sort === "profit" || sort === "return" || sort === "speed" || sort === "effort" ? { sortBy: sort } : {}),
            ...(conf === "low" || conf === "medium" || conf === "high" ? { minConfidence: conf } : {}),
          }),
        );
        return;
      }

      if (req.method === "GET" && path === "/api/history") {
        const itemId = url.searchParams.get("itemId");
        const history = itemId
          ? priceHistory(
              db,
              itemId,
              url.searchParams.get("variant") ?? "",
              Number(url.searchParams.get("days") ?? 90),
            )
          : null;
        if (!history) {
          json(res, { error: "unknown item" }, 404);
          return;
        }
        json(res, history);
        return;
      }

      if (req.method === "GET" && path === "/api/sets") {
        const capital = url.searchParams.get("maxBuyAt");
        const sort = url.searchParams.get("sort");
        json(
          res,
          setArbitrage(db, {
            ...(sort === "return" || sort === "score" || sort === "speed" ? { sortBy: sort } : {}),
            ...(capital && Number(capital) > 0 ? { maxBuyAt: Number(capital) } : {}),
            includeHeldBack: url.searchParams.get("heldBack") === "1",
            limit: Number(url.searchParams.get("limit") ?? 300),
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
        const itemId = shortText(b["itemId"]);
        const userId = shortText(b["userId"]);
        const ingameName = shortText(b["ingameName"], 64);
        const platinum = integer(b["platinum"], 1);
        if (!itemId || !userId || !ingameName || platinum === null ||
            !db.prepare("SELECT 1 FROM item WHERE id=?").get(itemId)) {
          json(res, { error: "valid itemId, userId, ingameName, and positive integer platinum are required" }, 400);
          return;
        }
        const id = logWhisper(db, {
          itemId, userId, ingameName, platinum,
          ...(b["orderId"] ? { orderId: String(b["orderId"]) } : {}),
          ...(b["note"] ? { note: String(b["note"]) } : {}),
        });
        json(res, { id }, 201);
        return;
      }

      if (req.method === "PATCH" && path.startsWith("/api/whispers/")) {
        const id = Number(path.slice("/api/whispers/".length));
        const b = await readBody(req);
        if (!Number.isInteger(id) || id < 1 ||
            (b["replied"] === undefined && b["traded"] === undefined) ||
            (b["replied"] !== undefined && typeof b["replied"] !== "boolean") ||
            (b["traded"] !== undefined && typeof b["traded"] !== "boolean")) {
          json(res, { error: "a valid whisper id and boolean replied or traded value are required" }, 400);
          return;
        }
        const changed = resolveWhisper(db, id, {
          ...(b["replied"] !== undefined ? { replied: Boolean(b["replied"]) } : {}),
          ...(b["traded"] !== undefined ? { traded: Boolean(b["traded"]) } : {}),
        });
        if (!changed) { json(res, { error: "whisper not found" }, 404); return; }
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
      if (req.method === "GET" && path === "/api/alerts/performance") { json(res, alertPerformance(db)); return; }
      const alertFeedback = req.method === "PATCH" ? /^\/api\/alerts\/(\d+)\/feedback$/.exec(path) : null;
      if (alertFeedback) {
        const b=await readBody(req); const outcomes=["bought","already_gone","no_reply","margin_disappeared"];
        if (!outcomes.includes(String(b["outcome"]))) { json(res,{error:"invalid alert outcome"},400); return; }
        const tradeId=b["tradeId"]===undefined?undefined:integer(b["tradeId"],1);
        if (tradeId===null || !setAlertFeedback(db,Number(alertFeedback[1]),b["outcome"] as any,tradeId,typeof b["note"]==="string"?b["note"]:undefined)) {
          json(res,{error:"alert or trade not found"},404); return;
        }
        json(res,{ok:true}); return;
      }

      if (req.method === "POST" && path === "/api/verify") {
        const b = await readBody(req);
        const ids = Array.isArray(b["itemIds"])
          ? [...new Set((b["itemIds"] as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))]
          : [];
        if (ids.length === 0 || ids.length > 12) {
          json(res, { error: "itemIds must contain between 1 and 12 markets" }, 400);
          return;
        }
        const marks = ids.map(() => "?").join(",");
        const items = db.prepare(
          `SELECT id, slug, name, tags FROM item WHERE id IN (${marks})`,
        ).all(...ids) as Array<{ id: string; slug: string; name: string; tags: string }>;
        if (items.length !== ids.length) {
          json(res, { error: "one or more markets are unknown" }, 404);
          return;
        }
        const result = await (opts.refreshMarkets ?? refreshWatched)(db, items);
        json(res, { ...result, verifiedAt: new Date().toISOString(), itemIds: ids });
        return;
      }

      if (req.method === "POST" && path === "/api/trades") {
        const b = await readBody(req);
        const itemId = shortText(b["itemId"]);
        const quantity = integer(b["quantity"] ?? 1, 1, 10_000);
        const buyPrice = integer(b["buyPrice"], 0);
        const expectedSell = b["expectedSell"] === undefined ? undefined : integer(b["expectedSell"], 0);
        const expectedMargin = b["expectedMargin"] === undefined ? undefined : integer(b["expectedMargin"], -1_000_000);
        const targetPrice = b["targetPrice"] === undefined || b["targetPrice"] === "" ? undefined : integer(b["targetPrice"], 1);
        const source = b["source"] ?? "manual";
        const buyWaitH = b["buyWaitH"] === undefined || b["buyWaitH"] === "" ? undefined : Number(b["buyWaitH"]);
        if (!itemId || quantity === null || buyPrice === null || expectedSell === null ||
            expectedMargin === null || targetPrice === null ||
            !["spread", "set", "alert", "manual"].includes(String(source)) ||
            (buyWaitH !== undefined && (!Number.isFinite(buyWaitH) || buyWaitH < 0 || buyWaitH > 8760)) ||
            !db.prepare("SELECT 1 FROM item WHERE id=?").get(itemId)) {
          json(res, { error: "trade requires a known item, integer quantity and prices, and a valid source" }, 400);
          return;
        }
        const id = openTrade(db, {
          itemId,
          variant: String(b["variant"] ?? ""),
          quantity,
          buyPrice,
          ...(b["boughtFrom"] ? { boughtFrom: String(b["boughtFrom"]) } : {}),
          ...(expectedSell !== undefined ? { expectedSell } : {}),
          ...(expectedMargin !== undefined ? { expectedMargin } : {}),
          ...(targetPrice !== undefined ? { targetPrice } : {}),
          source: source as "spread" | "set" | "alert" | "manual",
          ...(buyWaitH !== undefined ? { buyWaitH } : {}),
        });
        json(res, { id }, 201);
        return;
      }

      // Before the generic PATCH below, which would read "5/target" as trade NaN.
      const target = req.method === "PATCH" ? /^\/api\/trades\/(\d+)\/target$/.exec(path) : null;
      if (target) {
        const b = await readBody(req);
        const price = integer(b["targetPrice"], 1);
        if (price === null) {
          json(res, { error: "targetPrice must be a positive integer" }, 400);
          return;
        }
        if (!setTradeTarget(db, Number(target[1]), price)) {
          json(res, { error: "no open position with that id" }, 404);
          return;
        }
        json(res, { ok: true });
        return;
      }

      const correction = req.method === "PATCH" ? /^\/api\/trades\/(\d+)\/correct$/.exec(path) : null;
      if (correction) {
        const b=await readBody(req); const quantity=integer(b["quantity"],1,10000); const buyPrice=integer(b["buyPrice"],0);
        if(quantity===null||buyPrice===null){json(res,{error:"quantity and buyPrice must be non-negative integers"},400);return;}
        if(!correctTrade(db,Number(correction[1]),{quantity,buyPrice,note:typeof b["note"]==="string"?b["note"]:undefined})){json(res,{error:"trade not found"},404);return;}
        json(res,{ok:true}); return;
      }
      const auditPath = req.method === "GET" ? /^\/api\/trades\/(\d+)\/audit$/.exec(path) : null;
      if (auditPath) { json(res, tradeAudit(db,Number(auditPath[1]))); return; }

      if (req.method === "PATCH" && path.startsWith("/api/trades/")) {
        const id = integer(path.slice("/api/trades/".length), 1);
        const b = await readBody(req);
        const sellPrice = integer(b["sellPrice"], 0);
        const quantity = b["quantity"] === undefined ? undefined : integer(b["quantity"], 1, 10_000);
        if (id === null || sellPrice === null || quantity === null) {
          json(res, { error: "sellPrice must be non-negative and quantity a positive integer" }, 400);
          return;
        }
        const closed = closeTrade(db, id, {
          sellPrice,
          ...(quantity !== undefined ? { quantity } : {}),
          ...(b["soldTo"] ? { soldTo: String(b["soldTo"]) } : {}),
        });
        if (!closed) {
          json(res, { error: "no open position with that id" }, 404);
          return;
        }
        json(res, { ok: true });
        return;
      }

      if (req.method === "DELETE" && path.startsWith("/api/trades/")) {
        const id = integer(path.slice("/api/trades/".length), 1);
        if (id === null) { json(res, { error: "invalid trade id" }, 400); return; }
        if (!deleteTrade(db, id)) { json(res, { error: "trade not found" }, 404); return; }
        json(res, { ok: true });
        return;
      }

      if (req.method === "POST" && path === "/api/watch") {
        const b = await readBody(req);
        const itemId = shortText(b["itemId"]);
        if (!itemId || typeof b["on"] !== "boolean" || !db.prepare("SELECT 1 FROM item WHERE id=?").get(itemId)) {
          json(res, { error: "known itemId and boolean on are required" }, 400);
          return;
        }
        setWatched(db, itemId, String(b["variant"] ?? ""), b["on"]);
        json(res, { ok: true });
        return;
      }

      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
