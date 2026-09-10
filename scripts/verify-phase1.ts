/**
 * Phase 1 acceptance gate.
 *
 * Done when: 100 sequential /top calls finish with zero non-200 responses.
 * Also exercises the catalogue cache and the isolated v1 statistics source.
 */
import { performance } from "node:perf_hooks";
import { loadCatalog, isVeiledRiven } from "../src/wfm/catalog";
import { getTopOrders } from "../src/wfm/client";
import { statistics, volume48h } from "../src/wfm/statistics";
import { limiter } from "../src/wfm/http";
import { WfmError } from "../src/wfm/errors";

const SAMPLE_SIZE = 100;

function ms(n: number): string {
  return `${n.toFixed(0)}ms`;
}

async function main(): Promise<number> {
  let failures = 0;

  console.log("── catalogue ────────────────────────────────");
  const cold = await loadCatalog();
  console.log(
    `  ${cold.items.length} items · collection version ${cold.version} · ` +
      `${cold.fromCache ? "from cache" : "downloaded"}`,
  );

  const warm = await loadCatalog();
  if (warm.fromCache) {
    console.log(`  second call served from cache — 1.6 MB skipped`);
  } else {
    console.log(`  ! second call re-downloaded; version keying is not working`);
    failures++;
  }

  const veiled = cold.items.filter(isVeiledRiven).length;
  console.log(`  ${veiled} veiled riven mods (fungible — kept; unveiled rivens are not in this catalogue)`);

  const sample = cold.items.slice(0, SAMPLE_SIZE);
  if (sample.length < SAMPLE_SIZE) {
    console.log(`  ! only ${sample.length} items available to sample`);
    failures++;
  }

  console.log(`\n── ${sample.length} sequential /top calls ─────────────`);
  const started = performance.now();
  const latencies: number[] = [];
  let withOrders = 0;

  for (let i = 0; i < sample.length; i++) {
    const item = sample[i]!;
    const t0 = performance.now();
    try {
      const top = await getTopOrders(item.slug);
      latencies.push(performance.now() - t0);
      if (top.sell.length > 0 || top.buy.length > 0) withOrders++;
    } catch (err) {
      failures++;
      const detail = err instanceof WfmError ? err.message : String(err);
      console.log(`  ! ${item.slug}: ${detail}`);
    }
    if ((i + 1) % 25 === 0) {
      const elapsed = (performance.now() - started) / 1000;
      console.log(
        `  ${i + 1}/${sample.length} · ${(( i + 1) / elapsed).toFixed(2)} req/s · queue ${limiter.pending}`,
      );
    }
  }

  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log(
    `  done in ${elapsed.toFixed(1)}s · ${(latencies.length / elapsed).toFixed(2)} req/s · ` +
      `latency p50 ${ms(p50)} p95 ${ms(p95)}`,
  );
  console.log(`  ${withOrders}/${latencies.length} items had at least one live order`);

  console.log(`\n── v1 statistics (the fragile dependency) ───`);
  try {
    const stats = await statistics.getStatistics("rhino_prime_set");
    console.log(
      `  rhino_prime_set · ${stats.hourly.length} hourly, ${stats.daily.length} daily buckets · ` +
        `48h volume ${volume48h(stats)}`,
    );
  } catch (err) {
    failures++;
    console.log(`  ! statistics failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`    If this is a 403, v1 has been retired — swap StatisticsSource.`);
  }

  console.log(`\n────────────────────────────────────────────`);
  if (failures === 0) {
    const projected = (cold.items.length / (latencies.length / elapsed)) / 60;
    console.log(`PASS — zero non-200 responses across ${latencies.length} calls`);
    console.log(`Full ${cold.items.length}-item sweep projects to ~${projected.toFixed(0)} min`);
    return 0;
  }
  console.log(`FAIL — ${failures} problem(s) above`);
  return 1;
}

// Set exitCode rather than calling process.exit(), which truncates buffered
// stdout when it is a pipe. Limiter timers are unref'd, so the process ends.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error("verification crashed:", err);
    process.exitCode = 1;
  },
);
