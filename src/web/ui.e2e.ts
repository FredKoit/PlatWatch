import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { openDb, type Db } from "../db/index";
import { getChecklist, saveChecklist } from "../trade/checklists";
import { openTrade } from "../trade/journal";
import { createApp } from "./server";

/**
 * Browser tests. They click the real page and let its own event handlers run —
 * the dialogs, the clipboard, the tab switches — against a server on a
 * throwaway database in the temp directory. Never the real database.
 *
 *   npm run test:browser
 *
 * Needs a Chromium: PLATWATCH_CHROMIUM, a Playwright browser download, or Edge.
 */

function browserPath(): string {
  const fromEnv = process.env["PLATWATCH_CHROMIUM"];
  if (fromEnv) return fromEnv;
  const cache = process.env["LOCALAPPDATA"]
    ? join(process.env["LOCALAPPDATA"], "ms-playwright")
    : join(process.env["HOME"] ?? "", ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      for (const exe of [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"], ["chrome-linux", "chrome"]]) {
        const path = join(cache, dir, ...exe);
        if (existsSync(path)) return path;
      }
    }
  }
  const edge = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
  if (existsSync(edge)) return edge;
  throw new Error("no Chromium found — set PLATWATCH_CHROMIUM to a chrome or msedge executable");
}

let browser: Browser;
before(async () => { browser = await chromium.launch({ executablePath: browserPath(), headless: true }); });
after(async () => { await browser?.close(); });

interface Harness {
  db: Db;
  dir: string;
  port: number;
  base: string;
  server: Server;
  context: BrowserContext;
  page: Page;
  /** Stop the "daemon": close the server and drop every open connection. */
  stop(): Promise<void>;
  /** Start it again on the same port and database, as a restart would. */
  start(): Promise<void>;
}

const listen = (server: Server, port = 0) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});
const close = (server: Server) => new Promise<void>((resolve) => {
  server.close(() => resolve());
  server.closeAllConnections();
});

async function harness(seed: (db: Db) => void = () => {}, initScript?: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "platwatch-ui-"));
  const db = openDb(join(dir, "platwatch.db"));
  db.prepare(
    `INSERT INTO item (id, slug, name, tags) VALUES
       ('item-1', 'test_item', 'Test Item', '[]'),
       ('item-2', 'other_item', 'Other Item', '[]'),
       ('set-1', 'alpha_prime_set', 'Alpha Prime Set', '["set"]'),
       ('set-2', 'beta_prime_set', 'Beta Prime Set', '["set"]'),
       ('part-1', 'alpha_prime_barrel', 'Alpha Prime Barrel', '[]'),
       ('part-2', 'alpha_prime_stock', 'Alpha Prime Stock', '[]')`,
  ).run();
  seed(db);
  const h = { db, dir } as Harness;
  h.server = createApp(db);
  h.port = await listen(h.server);
  h.base = `http://127.0.0.1:${h.port}`;
  h.stop = () => close(h.server);
  h.start = async () => { h.server = createApp(db); await listen(h.server, h.port); };
  h.context = await browser.newContext();
  await h.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: h.base });
  // A test must never reach the real site.
  await h.context.route("https://warframe.market/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>warframe.market (stub)</title>" }));
  if (initScript) await h.context.addInitScript(initScript);
  h.page = await h.context.newPage();
  await h.page.goto(h.base);
  return h;
}

async function finish(h: Harness): Promise<void> {
  await h.context.close();
  await h.stop().catch(() => {});
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function addAlert(db: Db, a: { orderId: string; itemId: string; kind: string; platinum: number; reference: number; profit: number; player?: string }): number {
  return Number(db.prepare(
    `INSERT INTO alert (order_id, item_id, kind, platinum, reference, profit, volume_48h, ingame_name, user_status, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, 20, ?, 'ingame', ?)`,
  ).run(a.orderId, a.itemId, a.kind, a.platinum, a.reference, a.profit, a.player ?? "Seller", new Date().toISOString()).lastInsertRowid);
}

const buyAlert = (db: Db) =>
  addAlert(db, { orderId: "o-buy", itemId: "item-1", kind: "underpriced_sell", platinum: 110, reference: 138.75, profit: 28.75 });

async function openTab(page: Page, tab: string, rows: string): Promise<void> {
  await page.click(`nav button[data-tab="${tab}"]`);
  await page.waitForSelector(rows);
}

const count = (db: Db, sql: string) => (db.prepare(sql).get() as { c: number }).c;

test("an item name opens warframe.market in a new tab; price history stays a separate button", async () => {
  const h = await harness(buyAlert);
  try {
    await openTab(h.page, "alerts", "#alerts tbody tr[data-i]");
    const link = h.page.locator("#alerts a.market", { hasText: "Test Item" }).first();
    assert.equal(await link.getAttribute("href"), "https://warframe.market/items/test_item");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.match(await link.getAttribute("title") ?? "", /Open on warframe\.market to confirm availability/);

    const [popup] = await Promise.all([h.context.waitForEvent("page"), link.click()]);
    await popup.waitForLoadState("domcontentloaded");
    assert.equal(popup.url(), "https://warframe.market/items/test_item");
    assert.equal(await popup.evaluate("window.opener"), null, "the market page gets no handle on PlatWatch");
    await popup.close();

    await h.page.locator("#alerts .hist-btn").first().click();
    await h.page.waitForSelector("#history[open]");
    assert.equal(await h.page.locator("#hist-title a.market").getAttribute("href"), "https://warframe.market/items/test_item");
  } finally { await finish(h); }
});

test("copying an alert whisper puts it on the clipboard and logs it", async () => {
  const h = await harness(buyAlert);
  try {
    await openTab(h.page, "alerts", "#alerts tbody tr[data-i]");
    const copy = h.page.locator("#alerts button[data-w]").first();
    await Promise.all([
      h.page.waitForResponse((r) => r.url().endsWith("/api/whispers") && r.request().method() === "POST"),
      copy.click(),
    ]);
    assert.equal(await copy.textContent(), "copied");
    assert.equal(
      await h.page.evaluate("navigator.clipboard.readText()"),
      '/w Seller Hi! I want to buy: "Test Item" for 110 platinum. (warframe.market)',
    );
    assert.equal(count(h.db, "SELECT COUNT(*) c FROM whisper_log WHERE order_id = 'o-buy'"), 1);
  } finally { await finish(h); }
});

test("bought on a buy alert opens a linked position on Trades & P&L, and a retry never duplicates it", async () => {
  let alertId = 0;
  const h = await harness((db) => { alertId = buyAlert(db); });
  try {
    await openTab(h.page, "alerts", "#alerts tbody tr[data-i]");

    // First attempt: the server records the trade, but the response is lost.
    let lost = false;
    await h.page.route("**/api/alerts/*/trade", async (route) => {
      if (lost) return route.continue();
      lost = true;
      await route.fetch();
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "the response was lost" }) });
    });

    const select = h.page.locator("#alerts select[data-outcome]").first();
    await select.selectOption("bought");
    await h.page.waitForSelector("#modal[open]");
    assert.equal(await h.page.inputValue('#modal input[name="buyPrice"]'), "110");
    assert.equal(await h.page.inputValue('#modal input[name="targetPrice"]'), "138", "138.75 rounds down to a listable target");
    await h.page.fill('#modal input[name="qty"]', "2");
    await h.page.click("#modal-ok");
    await h.page.waitForSelector(".toast.error");
    assert.equal(await select.inputValue(), "", "the page does not claim success");
    assert.equal(count(h.db, "SELECT COUNT(*) c FROM trade"), 1, "the server kept the trade although the page never heard back");

    // The user retries, exactly as they would.
    await select.selectOption("bought");
    await h.page.waitForSelector("#modal[open]");
    await h.page.fill('#modal input[name="qty"]', "2");
    await h.page.click("#modal-ok");
    await h.page.waitForSelector(".toast:has-text('nothing was duplicated')");

    assert.equal(count(h.db, "SELECT COUNT(*) c FROM trade"), 1);
    const trade = h.db.prepare(
      "SELECT id, quantity, buy_price, expected_sell, target_price, alert_id, sold_at FROM trade",
    ).get() as Record<string, unknown>;
    assert.deepEqual(
      { ...trade, id: undefined },
      { id: undefined, quantity: 2, buy_price: 110, expected_sell: 138.75, target_price: 138, alert_id: alertId, sold_at: null },
    );
    assert.equal(
      (h.db.prepare("SELECT trade_id FROM alert_feedback WHERE alert_id = ?").get(alertId) as { trade_id: number }).trade_id,
      trade["id"],
    );
    await h.page.waitForSelector("#alerts tbody tr[data-i] :text('in Trades & P&L')");

    await openTab(h.page, "trades", "#trades tbody tr[data-i]");
    const row = h.page.locator("#trades tbody tr[data-i]", { hasText: "Test Item" });
    assert.equal(await row.count(), 1);
    // innerText follows the CSS, which upper-cases this line.
    assert.match(await row.innerText(), new RegExp(`alert #${alertId}`, "i"));
    assert.equal((await row.locator("td").nth(1).innerText()).trim(), "2");
  } finally { await finish(h); }
});

test("sold on a sell alert sells part of an existing position at its real cost", async () => {
  let position = 0;
  let alertId = 0;
  const h = await harness((db) => {
    position = openTrade(db, { itemId: "item-2", buyPrice: 20, quantity: 3, targetPrice: 35 });
    alertId = addAlert(db, { orderId: "o-sell", itemId: "item-2", kind: "overpriced_buy", platinum: 40, reference: 22, profit: 18, player: "Buyer" });
  });
  try {
    await openTab(h.page, "alerts", "#alerts tbody tr[data-i]");
    await h.page.locator("#alerts select[data-outcome]").first().selectOption("bought");
    await h.page.waitForSelector("#modal[open]");
    const options = await h.page.locator('#modal select[name="position"] option').allInnerTexts();
    assert.match(options[0]!, new RegExp(`#${position} · 3 held at 20p each`));
    assert.match(options.at(-1)!, /Record untracked sale/);
    await h.page.fill('#modal input[name="qty"]', "2");
    assert.equal(await h.page.inputValue('#modal input[name="sellPrice"]'), "40");
    await h.page.click("#modal-ok");
    await h.page.waitForSelector(".toast:has-text('Recorded the sale')");

    const open = h.db.prepare("SELECT quantity, sold_at FROM trade WHERE id = ?").get(position) as { quantity: number; sold_at: string | null };
    assert.deepEqual(open, { quantity: 1, sold_at: null });
    const lot = h.db.prepare(
      "SELECT id, quantity, (sell_price - buy_price) * quantity AS profit, parent_trade_id AS parent FROM trade WHERE parent_trade_id = ?",
    ).get(position) as { id: number; quantity: number; profit: number; parent: number };
    assert.equal(lot.quantity, 2);
    assert.equal(lot.profit, 40, "priced from the position's real 20p cost");
    assert.equal((h.db.prepare("SELECT trade_id FROM alert_feedback WHERE alert_id = ?").get(alertId) as { trade_id: number }).trade_id, lot.id);

    await openTab(h.page, "trades", "#trades tbody tr[data-i]");
    assert.match(await h.page.locator("#trades tbody").innerText(), new RegExp(`sold from #${position}`, "i"));
  } finally { await finish(h); }
});

test("after a daemon restart the page clears its connection error and refreshes without a reload", async () => {
  const h = await harness();
  try {
    await h.page.waitForSelector("#today tbody tr td.empty");
    await h.page.evaluate("window.sameDocument = true");

    await h.stop();
    await h.page.click("#today-refresh");
    await h.page.waitForFunction(`/reconnecting/.test(document.querySelector("#stale").textContent)`);

    // Something changed while it was down; the refreshed view must show it.
    openTrade(h.db, { itemId: "item-1", buyPrice: 10 });
    await h.start();
    await h.page.waitForFunction(
      `document.querySelector("#stale").textContent === "" &&
        document.querySelector("#today tbody").textContent.includes("Test Item")`,
      null,
      { timeout: 20_000 },
    );
    assert.equal(await h.page.evaluate("window.sameDocument"), true, "no page reload");
    assert.equal(await h.page.locator('#tab-today .load-feedback[data-error="true"]').count(), 0);
  } finally { await finish(h); }
});

test("an unfinished set checklist is restored from SQLite in a fresh browser, even when no longer ranked", async () => {
  const seller = (name: string, platinum: number) => ({ userId: name, ingameName: name, platinum, sent: 0, replied: 0, replyRate: null });
  const part = (itemId: string, slug: string, name: string, order: string, platinum: number) => ({
    itemId, item_slug: slug, name, qty: 1, each: platinum, subtotal: platinum, available: 1, volume48h: 10,
    fills: [{ orderId: order, stock: 1, units: 1, platinum, status: "ingame", seller: seller(`${name} Seller`, platinum),
      whisper: `/w Seller Hi! I want to buy: "${name}" for ${platinum} platinum. (warframe.market)` }],
    seller: seller(`${name} Seller`, platinum), whisper: null,
  });
  const h = await harness(
    (db) => {
      saveChecklist(db, "set-1", {
        "part-1:order:o-1": { status: "purchased", paid: 25 },
        "part-2:order:o-2": { status: "contacted" },
      }, {
        itemId: "set-1", item_slug: "alpha_prime_set", name: "Alpha Prime Set", kind: "set", buyAt: 55, sellAt: 90,
        parts: [part("part-1", "alpha_prime_barrel", "Alpha Prime Barrel", "o-1", 25), part("part-2", "alpha_prime_stock", "Alpha Prime Stock", "o-2", 30)],
      });
    },
    // Progress an older version left in this browser's localStorage.
    `localStorage.setItem("platwatch:set-checklists:v1", JSON.stringify({ "set-2": { "part-9:order:o-9": "purchased" } }));`,
  );
  try {
    const row = h.page.locator('#today tr[data-checklist="set-1"]');
    await row.waitFor();
    assert.match(await row.innerText(), /1\/2 purchases acquired · no longer ranked/);
    await h.page.locator('#today tr[data-checklist="set-2"]').waitFor();
    assert.equal(getChecklist(h.db, "set-2")?.entries["part-9:order:o-9"]?.status, "purchased", "moved into SQLite");

    await row.locator('button[data-today="parts"]').click();
    await h.page.waitForSelector("#modal[open]");
    assert.match(await h.page.textContent("#modal-title") ?? "", /Assemble Alpha Prime Set — 1\/2 purchases acquired/);
    assert.equal(await h.page.inputValue('#modal select[data-check="part-1:order:o-1"]'), "purchased");
    assert.equal(await h.page.inputValue('#modal input[data-paid="part-1:order:o-1"]'), "25");
    assert.equal(await h.page.locator("#modal a.market", { hasText: "Alpha Prime Stock" }).getAttribute("href"),
      "https://warframe.market/items/alpha_prime_stock");

    await Promise.all([
      h.page.waitForResponse((r) => r.url().endsWith("/api/checklists/set-1") && r.request().method() === "PUT"),
      h.page.selectOption('#modal select[data-check="part-2:order:o-2"]', "purchased"),
    ]);
    assert.equal(getChecklist(h.db, "set-1")?.entries["part-2:order:o-2"]?.status, "purchased");
    assert.equal(await h.page.evaluate(`localStorage.getItem("platwatch:set-checklists:v1")`), null);
  } finally { await finish(h); }
});
