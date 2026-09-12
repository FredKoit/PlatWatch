import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/index";
import type { Sink } from "./notify";
import { deliverPending, queueDelivery } from "./outbox";

const notice = { title: "Sell now", body: "Buyer bids at target" };

test("failed Discord delivery survives and retries after backoff", async () => {
  const db = openDb(":memory:");
  let fail = true;
  const received: string[] = [];
  const sink: Sink = {
    name: "discord",
    async send() {},
    async notify(n) { if (fail) throw new Error("offline"); received.push(n.title); },
  };
  queueDelivery(db, "exit:1:target:50", { kind: "notice", payload: notice }, 0);
  queueDelivery(db, "exit:1:target:50", { kind: "notice", payload: notice }, 0);
  assert.deepEqual(await deliverPending(db, sink, 0), { delivered: 0, failed: 1, pending: 1 });
  assert.deepEqual(await deliverPending(db, sink, 59_999), { delivered: 0, failed: 0, pending: 1 });
  fail = false;
  assert.deepEqual(await deliverPending(db, sink, 60_000), { delivered: 1, failed: 0, pending: 0 });
  assert.deepEqual(received, ["Sell now"]);
  db.close();
});

test("a queued delivery remains available until it is processed", async () => {
  const db = openDb(":memory:");
  queueDelivery(db, "alert:o1", { kind: "notice", payload: notice }, 0);
  const sink: Sink = { name: "discord", async send() {}, async notify() {} };
  assert.equal((await deliverPending(db, sink, 0)).delivered, 1);
  db.close();
});
