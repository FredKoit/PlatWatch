import { createServer } from "node:http";

/**
 * The single-instance lock, shared by every process that talks to
 * warframe.market.
 *
 * The rate limiter is per-process, so two such processes put twice the budget
 * at a small volunteer-run service. The daemon already refused to start beside
 * another daemon, but `ingest`, `watch` and `verify-phase1` never checked — so
 * running `npm run ingest -- stats` by hand while the daemon was up doubled the
 * load, and that is an easy thing to do without thinking.
 *
 * The lock is the daemon's UI port. Binding it is atomic, and the OS releases
 * it on crash or reboot, so there is never a stale lock to clear.
 */

export const LOCK_PORT = 5173;

export interface Lock {
  release(): Promise<void>;
}

/**
 * Take the lock for a command that is not the daemon. Resolves to null when
 * something already holds it.
 *
 * While held, the port answers with a short message instead of silently
 * accepting connections, so opening the UI mid-command explains itself.
 */
export function acquireLock(label: string, port = LOCK_PORT): Promise<Lock | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end(`PlatWatch is busy running "${label}". The UI is back when it finishes.\n`);
    });
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(null);
      else reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({
        release: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * For CLI scripts: take the lock or exit explaining why. Returns the lock so
 * the caller can release it; it is also released automatically when the
 * process exits, since the OS reclaims the port.
 */
export async function requireLock(label: string, port = LOCK_PORT): Promise<Lock> {
  const lock = await acquireLock(label, port);
  if (lock) return lock;
  console.error(`PlatWatch is already running — the daemon, or another command.`);
  console.error(`Running "${label}" alongside it would double the load on warframe.market.`);
  console.error(`The daemon already crawls on a schedule. If you need this now, stop it first:`);
  console.error(`  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\platwatch-stop.ps1`);
  process.exit(1);
}
