import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb, type Db } from "../db/index";
import { createApp } from "./server";

let db: Db | undefined;
let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => { await closeServer?.(); closeServer = undefined; db?.close(); db = undefined; });

async function browserHarness() {
  db = openDb(":memory:");
  db.prepare("INSERT INTO item(id,slug,name,tags) VALUES('item-1','test_item','Test Item','[]')").run();
  const server = createApp(db, { refreshMarkets: async () => ({ ok: 1, failed: 0, liveUpdates: 1 }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeServer = () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("browser assets are external modules and served with useful content types", async () => {
  const base = await browserHarness();
  const html = await (await fetch(base)).text();
  assert.match(html, /href="\/assets\/ui\.css"/);
  assert.match(html, /type="module" src="\/assets\/ui\.js"/);
  assert.doesNotMatch(html, /<style>/);
  for (const asset of ["ui.css", "ui.js", "core.js"]) {
    const response = await fetch(`${base}/assets/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", asset.endsWith("css") ? /text\/css/ : /text\/javascript/);
  }
});

test("verify, buy, partial sell, and close work as one browser workflow", async () => {
  const base = await browserHarness();
  const request = (path: string, method: string, body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const verified = await request("/api/verify", "POST", { itemIds: ["item-1"] });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json() as { liveUpdates: number }).liveUpdates, 1);

  const bought = await request("/api/trades", "POST", { itemId: "item-1", quantity: 5, buyPrice: 10, expectedSell: 20, expectedMargin: 10, source: "manual" });
  assert.equal(bought.status, 201);
  const id = (await bought.json() as { id: number }).id;
  assert.equal((await request(`/api/trades/${id}`, "PATCH", { sellPrice: 18, quantity: 2 })).status, 200);
  let rows = await (await fetch(base + "/api/trades")).json() as Array<{ id:number;quantity:number;sellPrice:number|null }>;
  assert.equal(rows.find((r) => r.id === id)?.quantity, 3);
  assert.ok(rows.some((r) => r.quantity === 2 && r.sellPrice === 18));
  assert.equal((await request(`/api/trades/${id}`, "PATCH", { sellPrice: 20, quantity: 3 })).status, 200);
  rows = await (await fetch(base + "/api/trades")).json() as typeof rows;
  assert.equal(rows.filter((r) => r.sellPrice !== null).reduce((n, r) => n + r.quantity, 0), 5);
});

test("invalid browser writes return an actionable client error", async () => {
  const base = await browserHarness();
  const response = await fetch(base + "/api/trades", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: "missing", buyPrice: -1 }) });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /known item/);
});

test("a live alert whisper can be logged and its outcome saved", async () => {
  const base = await browserHarness();
  db!.prepare(`INSERT INTO order_seen(order_id,item_id,user_id,ingame_name,type,platinum,created_at,updated_at,first_seen,last_seen)
    VALUES('order-1','item-1','user-1','Seller','sell',10,'x','x','x','x')`).run();
  db!.prepare(`INSERT INTO alert(order_id,item_id,kind,platinum,reference,profit,ingame_name,user_status,fired_at)
    VALUES('order-1','item-1','underpriced_sell',10,20,10,'Seller','ingame','2026-09-12T00:00:00Z')`).run();
  const [alert] = await (await fetch(base + "/api/alerts")).json() as Array<{id:number;user_id:string}>;
  assert.equal(alert!.user_id, "user-1");
  const headers = { "content-type": "application/json" };
  assert.equal((await fetch(base + "/api/whispers", { method:"POST", headers, body:JSON.stringify({orderId:"order-1",itemId:"item-1",userId:alert!.user_id,ingameName:"Seller",platinum:10}) })).status, 201);
  assert.equal((await fetch(`${base}/api/alerts/${alert!.id}/feedback`, { method:"PATCH", headers, body:JSON.stringify({outcome:"no_reply"}) })).status, 200);
  const refreshed = await (await fetch(base + "/api/alerts")).json() as Array<{outcome:string}>;
  assert.equal(refreshed[0]!.outcome, "no_reply");
});
