/**
 * scripts/reward-snapshot — REC-8/REC-9 Phase A: the liquidity-reward time-series logger
 * (REWARD-FARMING-HANDOFF.md §3 + §9). The first-pass measured the competition denominator from ONE
 * instantaneous order-book snapshot — the load-bearing weakness of its PASS. This logger samples the
 * funded-weather universe each run and APPENDS a per-market row (reward rate + near-mid book depth) to a
 * JSONL series, so the denominator becomes TIME-INTEGRATED (an epoch of samples) instead of a snapshot.
 * Re-run the first-pass over the accumulated series for an honest competition estimate.
 *
 * Deliberately file-based (out/reward-snapshots.jsonl), NOT a DB table: the REC-9 probe is the decider —
 * if it returns OVER_ADVERTISED a DB pipeline here is dead weight (the anti-cathedral guardrail). On a
 * probe CONFIRM, graduate this to a `market_rewards` table + an Edge tick (RUNBOOK / handoff §9). Schedule
 * it (Task Scheduler / cron, every ~15–30 min) to build the per-epoch series. Read-only/public/keyless.
 *
 * Run: pnpm tsx scripts/reward-snapshot.ts [--min-pool 1] [--max-pages 50] [--out PATH]
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildUniverse } from './research/reward-farming-firstpass.ts';
import type { MarketRewardInputs } from '../packages/core/src/sim/reward-farming.ts';

const DEFAULT_OUT = 'scripts/research/out/reward-snapshots.jsonl';

/** One persisted sample row (one market at one capture time). */
export interface RewardSnapshotRow {
  capturedUtc: string;
  conditionId: string;
  slug: string;
  dailyPoolUsd: number;
  minSize: number;
  maxSpreadCents: number;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  /** Total resting shares within max_spread of mid, each side. */
  bidDepthShares: number;
  askDepthShares: number;
  /** In-band maker CAPITAL each side (Σ size·price bid; Σ size·(1−price) ask). */
  bidDepthUsd: number;
  askDepthUsd: number;
}

/** Reduce one market's live book to its near-mid depth row (the competition-denominator inputs). */
export function toSnapshotRow(m: MarketRewardInputs, capturedUtc: string): RewardSnapshotRow {
  const mid = m.bestBid != null && m.bestAsk != null ? (m.bestBid + m.bestAsk) / 2 : null;
  const band = m.maxSpreadCents / 100;
  const inBidBand = mid == null ? [] : m.bids.filter((o) => mid - o.price <= band + 1e-9);
  const inAskBand = mid == null ? [] : m.asks.filter((o) => o.price - mid <= band + 1e-9);
  return {
    capturedUtc,
    conditionId: m.conditionId,
    slug: m.slug,
    dailyPoolUsd: m.dailyPoolUsd,
    minSize: m.minSize,
    maxSpreadCents: m.maxSpreadCents,
    mid,
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
    bidDepthShares: inBidBand.reduce((a, o) => a + o.size, 0),
    askDepthShares: inAskBand.reduce((a, o) => a + o.size, 0),
    bidDepthUsd: inBidBand.reduce((a, o) => a + o.size * o.price, 0),
    askDepthUsd: inAskBand.reduce((a, o) => a + o.size * (1 - o.price), 0),
  };
}

export async function runSnapshot(
  opts: { minPool: number; maxPages: number; out: string; capturedUtc: string },
  log: (m: string) => void,
): Promise<number> {
  const inputs = await buildUniverse({ maxPages: opts.maxPages, minPool: opts.minPool, limit: 0 }, log);
  const rows = inputs.map((m) => toSnapshotRow(m, opts.capturedUtc));
  mkdirSync(dirname(opts.out), { recursive: true });
  appendFileSync(opts.out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const pool = rows.reduce((a, r) => a + r.dailyPoolUsd, 0);
  const cap = rows.reduce((a, r) => a + r.bidDepthUsd + r.askDepthUsd, 0);
  log(`appended ${rows.length} rows @ ${opts.capturedUtc} → ${opts.out}`);
  log(`  pool ${'$' + pool.toFixed(0)}/day · in-band maker capital ${'$' + cap.toFixed(0)} (the time-integrated denominator builds with each run)`);
  return rows.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { 'min-pool': { type: 'string' }, 'max-pages': { type: 'string' }, out: { type: 'string' } },
  });
  const num = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  await runSnapshot(
    {
      minPool: num(values['min-pool'], 1),
      maxPages: num(values['max-pages'], 50),
      out: values.out ?? DEFAULT_OUT,
      capturedUtc: new Date().toISOString(),
    },
    console.log,
  );
}
