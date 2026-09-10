import { openDb } from "../src/db/index";
const db = openDb();
const cols = (t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
console.log("user_version          :", (db.pragma("user_version") as Array<{ user_version: number }>)[0]!.user_version);
console.log("snapshot has variant  :", cols("snapshot").includes("variant"));
console.log("order_seen has variant:", cols("order_seen").includes("variant"));
console.log("order_seen rows kept  :", (db.prepare("SELECT COUNT(*) c FROM order_seen").get() as { c: number }).c);
console.log("unique index          :", (db.prepare("SELECT sql FROM sqlite_master WHERE name='snapshot_item_sweep'").get() as { sql: string }).sql);
db.close();
