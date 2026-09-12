import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Db } from "./index";
import { DEFAULT_DB_PATH, setMeta } from "./index";

export interface BackupResult { path: string; bytes: number; removed: number; createdAt: string }
export interface BackupInfo { name: string; path: string; bytes: number; modifiedAt: string }

export async function listBackups(sourcePath = DEFAULT_DB_PATH): Promise<BackupInfo[]> {
  const directory=resolve(join(dirname(resolve(sourcePath)),"backups"));
  await mkdir(directory,{recursive:true});
  const names=(await readdir(directory)).filter(n=>/^platwatch-.*\.db$/.test(n)).sort().reverse();
  return Promise.all(names.map(async name=>{const path=resolve(directory,name);const s=await stat(path);return{name,path,bytes:s.size,modifiedAt:s.mtime.toISOString()}}));
}

export async function stageRestore(name: string, sourcePath = DEFAULT_DB_PATH): Promise<void> {
  if(!/^platwatch-.*\.db$/.test(name)) throw new Error("invalid backup name");
  const root=resolve(dirname(resolve(sourcePath)),"backups"), source=resolve(root,name);
  if(dirname(source)!==root) throw new Error("backup escaped its directory");
  await stat(source);
  await writeFile(resolve(dirname(resolve(sourcePath)),"restore-request.json"),JSON.stringify({source}),"utf8");
}

/** Applied before SQLite is opened; avoids replacing a database with live WAL handles. */
export function applyPendingRestore(sourcePath = DEFAULT_DB_PATH): string | null {
  const database=resolve(sourcePath), request=resolve(dirname(database),"restore-request.json");
  if(!existsSync(request)) return null;
  const {source}=JSON.parse(readFileSync(request,"utf8")) as {source:string};
  const root=resolve(dirname(database),"backups"), candidate=resolve(source);
  if(dirname(candidate)!==root || !/^platwatch-.*\.db$/.test(basename(candidate)) || !existsSync(candidate)) throw new Error("invalid staged restore");
  copyFileSync(candidate,database);
  for(const suffix of ["-wal","-shm"]) if(existsSync(database+suffix)) unlinkSync(database+suffix);
  unlinkSync(request);
  return candidate;
}

/** SQLite's online backup API produces a consistent copy even while the daemon writes. */
export async function backupDatabase(
  db: Db,
  opts: { sourcePath?: string; directory?: string; keep?: number; now?: Date } = {},
): Promise<BackupResult> {
  const source = resolve(opts.sourcePath ?? DEFAULT_DB_PATH);
  const directory = resolve(opts.directory ?? join(dirname(source), "backups"));
  const keep = Math.max(1, Math.floor(opts.keep ?? 7));
  const now = opts.now ?? new Date();
  await mkdir(directory, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const destination = join(directory, `platwatch-${stamp}.db`);
  await db.backup(destination);

  const names = (await readdir(directory))
    .filter((name) => /^platwatch-.*\.db$/.test(name))
    .sort()
    .reverse();
  let removed = 0;
  for (const name of names.slice(keep)) {
    const target = resolve(directory, name);
    if (dirname(target) !== directory) throw new Error("backup cleanup escaped its directory");
    await unlink(target);
    removed++;
  }
  const bytes = (await stat(destination)).size;
  const createdAt = now.toISOString();
  setMeta(db, "backup:lastSuccess", createdAt);
  setMeta(db, "backup:lastPath", destination);
  setMeta(db, "backup:lastBytes", String(bytes));
  return { path: destination, bytes, removed, createdAt };
}
