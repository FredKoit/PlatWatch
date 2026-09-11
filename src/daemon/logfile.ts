import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * An append-only log that rotates while running, not just at startup.
 *
 * It used to check the size once, on start. A daemon that runs for weeks never
 * restarts, so it never rotated — and the README said "rotated at 5 MB", which
 * was only true of a daemon that kept crashing.
 *
 * Writes are synchronous on purpose: a buffered stream lost every line written
 * just before process.exit, including the "already running, not starting"
 * message, which is precisely the one you would go looking for.
 */
export function rotatingWriter(path: string, limitBytes = 5 * 1024 * 1024) {
  mkdirSync(dirname(path), { recursive: true });

  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // no log yet
  }

  const rotate = () => {
    try {
      // Replaces any previous .1 — one generation back is enough to diagnose
      // a problem without the log ever growing without bound.
      renameSync(path, `${path}.1`);
    } catch {
      // Nothing to rotate, or the file is momentarily held; retry next write.
      return;
    }
    size = 0;
  };

  if (size > limitBytes) rotate();

  return (chunk: string | Uint8Array): void => {
    appendFileSync(path, chunk);
    size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (size > limitBytes) rotate();
  };
}
