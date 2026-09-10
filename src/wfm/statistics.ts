import { V1 } from "./config";
import { getJson } from "./http";
import { WfmShapeError } from "./errors";
import type { ItemStatistics, StatBucket } from "./types";

/**
 * Price history, behind an interface on purpose.
 *
 * This is the ONLY v1 route the project still depends on. Its siblings already
 * answer `403 Deprecated`, and there is no v2 replacement yet
 * (`/v2/items/{slug}/statistics` is a 404). When it dies, everything that has
 * to change lives behind this interface: write a new implementation, swap the
 * export at the bottom, and no caller moves.
 */
export interface StatisticsSource {
  getStatistics(slug: string, signal?: AbortSignal): Promise<ItemStatistics>;
}

interface V1StatsPayload {
  payload?: {
    // `_closed` is completed trades — real volume.
    // `_live` is derived from standing orders and is NOT trade history.
    statistics_closed?: Record<string, StatBucket[]>;
  };
}

export class V1StatisticsSource implements StatisticsSource {
  async getStatistics(slug: string, signal?: AbortSignal): Promise<ItemStatistics> {
    // Note: this path 301-redirects to a trailing-slash URL; fetch follows it.
    const url = `${V1}/items/${encodeURIComponent(slug)}/statistics`;
    const body = await getJson<V1StatsPayload>(url, signal ? { signal } : {});

    const closed = body.payload?.statistics_closed;
    if (!closed) throw new WfmShapeError(url, "missing payload.statistics_closed");

    return {
      slug,
      hourly: closed["48hours"] ?? [],
      daily: closed["90days"] ?? [],
    };
  }
}

/** Total units traded across the 48-hour hourly buckets. */
export function volume48h(stats: ItemStatistics): number {
  return stats.hourly.reduce((sum, b) => sum + b.volume, 0);
}

/** Median of the most recent daily bucket, or null when nothing traded. */
export function latestDailyMedian(stats: ItemStatistics): number | null {
  const last = stats.daily.at(-1);
  return last ? last.median : null;
}

/** The implementation in use. Swap here when v1 finally goes dark. */
export const statistics: StatisticsSource = new V1StatisticsSource();
