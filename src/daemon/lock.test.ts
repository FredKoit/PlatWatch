import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { acquireLock } from "./lock";

/** A port nothing is using, so the test never collides with a running daemon. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

test("only one holder at a time", async () => {
  const port = await freePort();
  const first = await acquireLock("ingest sweep", port);
  assert.ok(first, "the first command takes the lock");

  const second = await acquireLock("watch", port);
  assert.equal(second, null, "a second API-hitting process is refused");

  await first!.release();
});

test("releasing the lock lets the next command run", async () => {
  const port = await freePort();
  const first = await acquireLock("ingest stats", port);
  await first!.release();

  const next = await acquireLock("watch", port);
  assert.ok(next, "free again once released");
  await next!.release();
});

test("the port explains itself while a command holds it", async () => {
  const port = await freePort();
  const lock = await acquireLock("ingest sweep", port);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /busy running "ingest sweep"/);
  await lock!.release();
});
