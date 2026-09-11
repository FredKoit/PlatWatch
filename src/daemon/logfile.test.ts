import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotatingWriter } from "./logfile";

const dir = () => mkdtempSync(join(tmpdir(), "platwatch-log-"));

test("regression: a long-running process rotates without restarting", () => {
  const d = dir();
  const log = join(d, "platwatch.log");
  const write = rotatingWriter(log, 100);

  // One process, many writes, no restart — the old code never rotated here.
  for (let i = 0; i < 30; i++) write(`line ${i} ......\n`);

  assert.ok(existsSync(`${log}.1`), "rotated mid-run");
  assert.ok(statSync(log).size <= 100 + 20, "the live log stays near the limit");
  rmSync(d, { recursive: true });
});

test("a log already over the limit is rotated at startup", () => {
  const d = dir();
  const log = join(d, "platwatch.log");
  writeFileSync(log, "x".repeat(500));
  rotatingWriter(log, 100);
  assert.ok(existsSync(`${log}.1`));
  assert.ok(!existsSync(log) || statSync(log).size === 0);
  rmSync(d, { recursive: true });
});

test("only one previous generation is kept", () => {
  const d = dir();
  const log = join(d, "platwatch.log");
  const write = rotatingWriter(log, 50);
  for (let i = 0; i < 40; i++) write(`generation test ${i}\n`);
  const files = ["platwatch.log", "platwatch.log.1", "platwatch.log.2"].filter((f) =>
    existsSync(join(d, f)),
  );
  assert.deepEqual(files, ["platwatch.log", "platwatch.log.1"], "bounded at two files");
  rmSync(d, { recursive: true });
});

test("nothing is lost across a rotation", () => {
  const d = dir();
  const log = join(d, "platwatch.log");
  const write = rotatingWriter(log, 40);
  write("before the limit, ");
  write("this line crosses it\n");
  write("after\n");
  // The write that crosses the limit rotates, so the live file may not exist
  // until the next write recreates it. That is normal; losing lines is not.
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const all = read(`${log}.1`) + read(log);
  assert.ok(all.includes("this line crosses it"), "the crossing line is kept whole");
  assert.ok(all.includes("after"));

  write("next\n");
  assert.ok(existsSync(log), "the next write recreates the live file");
  rmSync(d, { recursive: true });
});
