import { test } from "node:test";
import assert from "node:assert/strict";
import { noticeToastContent, toastContent, toastSink } from "./notify";
import type { Alert } from "./detect";

const alert = (over: Partial<Alert> = {}): Alert => ({
  kind: "underpriced_sell",
  orderId: "o",
  itemId: "i",
  slug: "rhino_prime_set",
  name: "Rhino Prime Set",
  variant: "",
  platinum: 40,
  reference: 64,
  profit: 24,
  profitPct: 0.375,
  volume48h: 104,
  ingameName: "Tenno123",
  userStatus: "ingame",
  baselineAgeH: 1,
  suspicious: false,
  whisper: "/w Tenno123 ...",
  ...over,
});

test("a single alert says what to do, at what price, for how much", () => {
  const c = toastContent([alert()]);
  assert.equal(c.title, "Buy Rhino Prime Set @ 40p (+24p)");
  assert.equal(c.body, "vs 64p · vol 104/48h · Tenno123");
});

test("a generous bid reads as a sell", () => {
  const c = toastContent([alert({ kind: "overpriced_buy", platinum: 95, reference: 60, profit: 35 })]);
  assert.ok(c.title.startsWith("Sell Rhino Prime Set @ 95p"));
});

test("a burst becomes one toast, led by the best find", () => {
  const c = toastContent([
    alert({ orderId: "a", name: "Small", profit: 11 }),
    alert({ orderId: "b", name: "Big", profit: 40 }),
    alert({ orderId: "c", name: "Mid", profit: 20 }),
  ]);
  assert.equal(c.title, "3 new PlatWatch alerts");
  assert.ok(c.body.startsWith("Best: Buy Big"), c.body);
});

test("a suspicious alert never leads over a genuine one", () => {
  // Bigger profit, but more often a typo or bait than an opportunity.
  const c = toastContent([
    alert({ orderId: "a", name: "Bait", profit: 500, suspicious: true }),
    alert({ orderId: "b", name: "Real", profit: 20 }),
  ]);
  assert.ok(c.body.includes("Real"), c.body);
});

test("a suspicious alert on its own says so", () => {
  const c = toastContent([alert({ suspicious: true })]);
  assert.ok(c.body.includes("suspicious"));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("alerts arriving together are batched into one notification", async () => {
  const shown: Array<{ title: string }> = [];
  const sink = toastSink({ url: "u", batchMs: 20, show: (c) => shown.push(c) });

  await sink.send(alert({ orderId: "a" }));
  await sink.send(alert({ orderId: "b" }));
  await sink.send(alert({ orderId: "c" }));
  assert.equal(shown.length, 0, "nothing shown until the batch window closes");

  await sleep(40);
  assert.equal(shown.length, 1, "three alerts, one toast");
  assert.equal(shown[0]!.title, "3 new PlatWatch alerts");
});

test("alerts in separate windows get separate notifications", async () => {
  const shown: Array<{ title: string }> = [];
  const sink = toastSink({ url: "u", batchMs: 15, show: (c) => shown.push(c) });

  await sink.send(alert({ orderId: "a" }));
  await sleep(35);
  await sink.send(alert({ orderId: "b" }));
  await sleep(35);
  assert.equal(shown.length, 2);
});

test("the click opens the PlatWatch UI", async () => {
  let opened = "";
  const sink = toastSink({
    url: "http://127.0.0.1:5173",
    batchMs: 5,
    show: (_c, url) => {
      opened = url;
    },
  });
  await sink.send(alert());
  await sleep(20);
  assert.equal(opened, "http://127.0.0.1:5173");
});

test("an exit notice on something you hold is never folded into a batch of market alerts", async () => {
  const shown: Array<{ title: string; body: string }> = [];
  const sink = toastSink({ url: "u", batchMs: 15, show: (c) => shown.push(c) });
  await sink.send(alert());
  await sink.send(alert({ orderId: "o2" }));
  await sink.notify!({ title: "Sell Rhino Prime Set now: Buyer bids 52p", body: "at or above your 50p target" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(shown.length, 2, "one toast for the alerts, one for the position");
  assert.equal(shown[1]!.title, "Sell Rhino Prime Set now: Buyer bids 52p");
});

test("several notices together say how many, led by the first", () => {
  const c = noticeToastContent([
    { title: "A undercut at 40p", body: "2 listed below your 45p target" },
    { title: "B is sitting unsold", body: "held 4.0d" },
  ]);
  assert.equal(c.title, "2 updates on positions you hold");
  assert.match(c.body, /^A undercut at 40p/);
});
