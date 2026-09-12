import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, getMeta } from "./index";
import { applyPendingRestore, backupDatabase, listBackups, stageRestore } from "./backup";

test("online backups are valid databases and rotate old copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "platwatch-backup-"));
  const db = openDb(":memory:");
  try {
    db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('safe')");
    for (let i = 0; i < 3; i++) {
      await backupDatabase(db, { directory, keep: 2, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    }
    const files = await readdir(directory);
    assert.equal(files.length, 2);
    const copy = openDb(join(directory, files.sort().at(-1)!));
    assert.equal((copy.prepare("SELECT value FROM proof").get() as {value:string}).value, "safe");
    copy.close();
    assert.ok((await stat(join(directory, files[0]!))).size > 0);
    assert.ok(getMeta(db, "backup:lastSuccess"));
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a selected backup is staged and restored before the database opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "platwatch-restore-"));
  const database = join(directory, "platwatch.db");
  const backups = join(directory, "backups");
  const name = "platwatch-2026-01-01.db";
  try {
    await mkdir(backups);
    await writeFile(database, "current");
    await writeFile(join(backups, name), "backup");
    assert.equal((await listBackups(database))[0]!.name, name);
    await stageRestore(name, database);
    assert.equal(applyPendingRestore(database), join(backups, name));
    assert.equal(await readFile(database, "utf8"), "backup");
    assert.equal(applyPendingRestore(database), null, "the request is consumed once");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
