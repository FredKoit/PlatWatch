import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CACHE_DIR } from "./config";
import { getItems, getVersions } from "./client";
import type { WfmItemSummary } from "./types";

interface CatalogCache {
  /** The decoded `collections.items` timestamp this snapshot was taken at. */
  version: string;
  fetchedAt: string;
  items: WfmItemSummary[];
}

const CACHE_FILE = join(CACHE_DIR, "items.json");

/** Collection tokens are base64-encoded ISO timestamps. */
export function decodeCollectionVersion(token: string): string {
  try {
    return Buffer.from(token, "base64").toString("utf8");
  } catch {
    return token;
  }
}

async function readCache(): Promise<CatalogCache | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as CatalogCache;
    return Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(cache: CatalogCache): Promise<void> {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");
}

export interface CatalogResult {
  items: WfmItemSummary[];
  version: string;
  /** True when the 1.6 MB download was skipped. */
  fromCache: boolean;
}

/**
 * The item catalogue, refetched only when the server says it changed.
 *
 * Costs one small `/versions` call per invocation instead of 1.6 MB.
 */
export async function loadCatalog(
  signal?: AbortSignal,
  force = false,
): Promise<CatalogResult> {
  const versions = await getVersions(signal);
  const token = versions.collections["items"];
  const version = token ? decodeCollectionVersion(token) : "unknown";

  if (!force) {
    const cached = await readCache();
    if (cached && cached.version === version) {
      return { items: cached.items, version, fromCache: true };
    }
  }

  const items = await getItems(signal);
  await writeCache({ version, fetchedAt: new Date().toISOString(), items });
  return { items, version, fromCache: false };
}

/**
 * Rivens are NOT a hazard in this catalogue, contrary to the obvious guess.
 *
 * The per-roll unveiled rivens that cannot carry a slug-level price are not
 * here at all — they live in a separate auction system (`collections.rivens`
 * in /v2/versions). The only riven entries in `/v2/items` are the 8 *veiled*
 * mods, which are fungible commodities and price normally (~8-10p). They rank
 * like anything else, so nothing needs excluding on that basis.
 *
 * Two things verified against the live API, both worth keeping in mind:
 *
 * 1. List tags are NOT abbreviated — `/v2/items` and `/v2/item/{slug}` return
 *    identical tag sets. What differs is the vocabulary between items:
 *    `companion_weapon_riven_mod_(veiled)` is tagged `mod,riven` while the
 *    other seven carry `mod,riven_mod,veiled_riven`. Match a category with a
 *    set of candidate tags, never a single tag name.
 *
 * 2. Slugs have ALIASES. `mirage_prime_systems` resolves to the catalogue's
 *    `mirage_prime_systems_blueprint` — same id, different address. Identity
 *    belongs on `id`; a slug is only how you address the API. Resolving
 *    `setParts` by slug will appear to lose parts that are present.
 */
export function isVeiledRiven(item: WfmItemSummary): boolean {
  return item.slug.includes("riven");
}
