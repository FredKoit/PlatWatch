import { test } from "node:test";
import assert from "node:assert/strict";
import { hoursSinceTrade, lastTradedMs, MAX_HISTORY_STALE_HOURS } from "./freshness";
import { summariseByVariant } from "../ingest/stats";
import { DEFAULT_POLICY, gate } from "./score";
import type { StatBucket } from "../wfm/types";

/**
 * The exact state production was in when the ranking went empty:
 * 2026-09-11 07:35 UTC, stats last fetched the previous evening. The newest
 * daily bucket stored was 2026-09-09 — the daily series never includes today,
 * so at fetch time the latest closed day was the day before.
 *
 * Earlier fixtures used lastTradedDay = today, which the API never returns.
 * That is why no test caught this.
 */
const PROD_NOW = Date.parse("2026-09-11T07:35:00Z");

const liquid = {
  volume48h: 100,
  sellCount: 5,
  bookAgeH: 2,
};

test("regression: a normal liquid item was rejected by the old day-based check", () => {
  // Old logic: (now - start of 2026-09-09) = 2.3 days > 2 → rejected.
  const oldDays = (PROD_NOW - Date.parse("2026-09-09T00:00:00Z")) / 86_400_000;
  assert.ok(oldDays > 2, "this is exactly why all 1,823 items failed");

  // New logic, with only the legacy field: end of that day, in hours.
  const rejects = gate({ ...liquid, lastTradedDay: "2026-09-09", lastTradedAt: null }, DEFAULT_POLICY, PROD_NOW);
  assert.ok(
    !rejects.some((r) => r.includes("last traded")),
    `must pass on the daily fallback alone, got ${JSON.stringify(rejects)}`,
  );
});

test("the hourly timestamp is preferred and is current to the hour", () => {
  const h = hoursSinceTrade(
    { lastTradedDay: "2026-09-09", lastTradedAt: "2026-09-11T07:00:00.000Z" },
    PROD_NOW,
  );
  assert.ok(h !== null && h < 1, `expected well under an hour, got ${h}`);
});

test("a daily bucket counts from its END, not its start", () => {
  // A trade in the 2026-09-09 bucket had happened by 2026-09-10 00:00.
  assert.equal(
    lastTradedMs({ lastTradedDay: "2026-09-09" }),
    Date.parse("2026-09-10T00:00:00Z"),
  );
});

test("an item that genuinely stopped trading is still rejected", () => {
  // Abyssal Beacon shape: series ended days before.
  const rejects = gate(
    { ...liquid, lastTradedDay: "2026-09-05", lastTradedAt: null },
    DEFAULT_POLICY,
    PROD_NOW,
  );
  assert.ok(rejects.some((r) => r.includes("last traded")), "the fix must not wave everything through");
});

test("an hourly timestamp older than the limit is rejected", () => {
  const old = new Date(PROD_NOW - (MAX_HISTORY_STALE_HOURS + 1) * 3_600_000).toISOString();
  const rejects = gate({ ...liquid, lastTradedDay: null, lastTradedAt: old }, DEFAULT_POLICY, PROD_NOW);
  assert.ok(rejects.some((r) => r.includes("last traded")));
});

test("no history at all is still no history", () => {
  assert.equal(hoursSinceTrade({ lastTradedDay: null, lastTradedAt: null }, PROD_NOW), null);
  const rejects = gate({ ...liquid, lastTradedDay: null, lastTradedAt: null }, DEFAULT_POLICY, PROD_NOW);
  assert.ok(rejects.includes("no trade history"));
});

test("the ranking survives a full day between stats fetches", () => {
  // Stats fetched at 19:28; the newest hourly bucket is the 18:00 hour.
  // Next fetch is 24h later. Just before it, the item must still pass.
  const fetchedAt = Date.parse("2026-09-10T19:28:00Z");
  const lastTradedAt = "2026-09-10T19:00:00.000Z"; // end of the 18:00 bucket
  const justBeforeNextFetch = fetchedAt + 24 * 3_600_000 - 60_000;
  const rejects = gate({ ...liquid, lastTradedDay: "2026-09-09", lastTradedAt }, DEFAULT_POLICY, justBeforeNextFetch);
  assert.ok(
    !rejects.some((r) => r.includes("last traded")),
    "with daily stats, the ranking must never go dark between fetches",
  );
});

const bucket = (datetime: string, extra: Partial<StatBucket> = {}): StatBucket => ({
  datetime,
  volume: 5,
  min_price: 50,
  max_price: 60,
  open_price: 55,
  closed_price: 55,
  avg_price: 55,
  wa_price: 55,
  median: 55,
  ...extra,
});

test("stats record the end of the newest HOURLY bucket", () => {
  const summaries = summariseByVariant(
    {
      slug: "rhino_prime_set",
      hourly: [bucket("2026-09-11T05:00:00.000+00:00"), bucket("2026-09-11T06:00:00.000+00:00")],
      daily: [bucket("2026-09-09T00:00:00.000+00:00"), bucket("2026-09-10T00:00:00.000+00:00")],
    },
    PROD_NOW,
  );
  const s = summaries.get("")!;
  assert.equal(s.lastTradedDay, "2026-09-10");
  assert.equal(s.lastTradedAt, "2026-09-11T07:00:00.000Z", "end of the 06:00 hour");
});

test("with no hourly trades the daily bucket end is used", () => {
  const s = summariseByVariant(
    { slug: "x", hourly: [], daily: [bucket("2026-09-08T00:00:00.000+00:00")] },
    PROD_NOW,
  ).get("")!;
  assert.equal(s.lastTradedAt, "2026-09-09T00:00:00.000Z");
});

test("the newest bucket is found by time, not by position", () => {
  // Nothing in the API promises oldest-first ordering.
  const s = summariseByVariant(
    {
      slug: "x",
      hourly: [bucket("2026-09-11T06:00:00.000+00:00"), bucket("2026-09-11T02:00:00.000+00:00")],
      daily: [],
    },
    PROD_NOW,
  ).get("")!;
  assert.equal(s.lastTradedAt, "2026-09-11T07:00:00.000Z");
});
