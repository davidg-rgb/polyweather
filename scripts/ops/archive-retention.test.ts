/**
 * archive-retention against PGlite (the real migration chain) + a temp output dir.
 *
 * Pins the properties the storage-tiering retention stands on: (1) only COMPLETED UTC days are archived (today
 * is never touched — no race with a live writer); (2) a day-shard's rows equal the live rows for that day
 * (verify), and (3) the prune deletes ONLY verified days older than the hot window, leaving the hot window and
 * today intact; (4) the gate holds — an unverified/absent day is BLOCKED (no archive, no delete); (5) it works
 * on a table with NO single-column PK (model_stats_history, pruned by ctid); (6) it is idempotent + resumable.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from '../../supabase/tests/harness.ts';
import { toPgliteParam } from '../lib/pglite-param.ts';
import type { ScriptDb } from '../lib/script-db.ts';
import {
  archiveAndVerify,
  archiveDir,
  executePrune,
  liveDayCount,
  planPrune,
  readArchiveManifest,
  type RetentionConfig,
} from './archive-retention.ts';

let db: PGlite;
let sdb: ScriptDb;
let outBase: string;

const NOW = new Date('2026-07-21T12:00:00Z');
const REWARDS: RetentionConfig = { table: 'market_rewards', tsColumn: 'captured_at', hotWindowDays: 14, note: 'test' };
const STATS: RetentionConfig = { table: 'model_stats_history', tsColumn: 'created_at', hotWindowDays: 30, note: 'test' };

async function seedReward(day: string, slug: string): Promise<void> {
  await db.query(
    `insert into market_rewards
       (captured_at, condition_id, slug, daily_pool_usd, min_size, max_spread_cents, mid, best_bid, best_ask,
        bid_depth_shares, ask_depth_shares, bid_depth_usd, ask_depth_usd)
     values (($1::date + time '06:00')::timestamptz, 'cond-' || $2, $2, 100, 5, 3, 0.5, 0.49, 0.51, 10, 10, 5, 5)`,
    [day, slug],
  );
}

async function seedStat(day: string, model: string, version: number): Promise<void> {
  await db.query(
    `insert into stations (icao, country_code, tz, source) values ('EHAM', 'NL', 'Etc/GMT-2', 'manual')
     on conflict (icao) do nothing`,
  );
  // PK is (icao, model, lead_days, snapshot_slot, stats_version) — vary version so rows on different days differ.
  await db.query(
    `insert into model_stats_history
       (icao, model, lead_days, snapshot_slot, bias_c, residual_sigma_c, n_residuals, mse, weight, stats_version,
        window_days, created_at)
     values ('EHAM', $2, 1, '10Z', 0.1, 1.2, 100, 1.4, 0.3, $3, 120, ($1::date + time '11:30')::timestamptz)`,
    [day, model, version],
  );
}

beforeEach(async () => {
  db = await freshDb();
  sdb = {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await db.query<T>(sql, params.map(toPgliteParam))).rows,
    end: async () => {},
  };
  outBase = mkdtempSync(join(tmpdir(), 'archret-'));
});

afterAll(() => {
  if (outBase && existsSync(outBase)) rmSync(outBase, { recursive: true, force: true });
});

describe('archive-retention', () => {
  it('archives only completed days, verifies them, and prunes the cold tail — hot window + today untouched', async () => {
    // completed cold (<cutoff 07-07): 07-01 (×2), 07-05 (×1); hot (kept): 07-19 (×1); today 07-21 (×1, not archived).
    await seedReward('2026-07-01', 'a');
    await seedReward('2026-07-01', 'b');
    await seedReward('2026-07-05', 'c');
    await seedReward('2026-07-19', 'd');
    await seedReward('2026-07-21', 'e');

    const dir = archiveDir('market_rewards', outBase);
    const m = await archiveAndVerify(sdb, REWARDS, dir, NOW);

    // today (07-21) is NOT archived; the three completed days are, all verified.
    expect(Object.keys(m.days).sort()).toEqual(['2026-07-01', '2026-07-05', '2026-07-19']);
    expect(m.days['2026-07-01']!.rows).toBe(2);
    expect(Object.values(m.days).every((d) => d.verified && !d.pruned)).toBe(true);
    expect(existsSync(join(dir, 'part-2026-07-01.ndjson.gz'))).toBe(true);

    // plan: cutoff = 07-07 → 07-01 + 07-05 prunable, 07-19 kept (inside 14d window).
    const plan = planPrune(m, REWARDS, NOW);
    expect(plan.cutoffDay).toBe('2026-07-07');
    expect(plan.prunable.map((d) => d.day)).toEqual(['2026-07-01', '2026-07-05']);
    expect(plan.blocked).toEqual([]);

    const deleted = await executePrune(sdb, REWARDS, dir, m, plan);
    expect(deleted).toBe(3); // 2 + 1

    // live table now holds only the hot day + today; total 2 rows.
    const total = await sdb.query<{ n: string }>(`select count(*)::text n from market_rewards`);
    expect(Number(total[0]!.n)).toBe(2);
    expect(await liveDayCount(sdb, REWARDS, '2026-07-19')).toBe(1);
    expect(await liveDayCount(sdb, REWARDS, '2026-07-21')).toBe(1);
    expect(await liveDayCount(sdb, REWARDS, '2026-07-01')).toBe(0);

    // manifest marks the pruned days; the shards remain on disk (the local record).
    expect(readArchiveManifest(dir)!.days['2026-07-01']!.pruned).toBe(true);
    expect(existsSync(join(dir, 'part-2026-07-01.ndjson.gz'))).toBe(true);
  });

  it('is idempotent — a re-run does not re-archive pruned days nor touch today', async () => {
    await seedReward('2026-07-01', 'a');
    await seedReward('2026-07-21', 'e');
    const dir = archiveDir('market_rewards', outBase);

    let m = await archiveAndVerify(sdb, REWARDS, dir, NOW);
    await executePrune(sdb, REWARDS, dir, m, planPrune(m, REWARDS, NOW));

    // second full pass: 07-01 stays pruned (not re-archived), today still absent, nothing new to prune.
    m = await archiveAndVerify(sdb, REWARDS, dir, NOW);
    expect(m.days['2026-07-01']!.pruned).toBe(true);
    expect(m.days['2026-07-21']).toBeUndefined();
    expect(planPrune(m, REWARDS, NOW).prunable).toEqual([]);
  });

  it('SELF-HEALS a drifted day — a late row triggers re-archive, restoring coverage (no permanent wedge)', async () => {
    await seedReward('2026-07-01', 'a');
    const dir = archiveDir('market_rewards', outBase);
    let m = await archiveAndVerify(sdb, REWARDS, dir, NOW);
    expect(m.days['2026-07-01']!.rows).toBe(1);
    expect(m.days['2026-07-01']!.verified).toBe(true);

    // a late row lands in the already-archived cold day → the next pass RE-ARCHIVES it (drift-up), instead of
    // leaving it permanently unverified (which would wedge every day's prune via executePrune's all-or-nothing gate).
    await seedReward('2026-07-01', 'late');
    m = await archiveAndVerify(sdb, REWARDS, dir, NOW);
    expect(m.days['2026-07-01']!.rows).toBe(2); // re-archived to include the late row
    expect(m.days['2026-07-01']!.verified).toBe(true); // covered again

    const plan = planPrune(m, REWARDS, NOW);
    expect(plan.blocked).toEqual([]);
    expect(plan.prunable.map((d) => d.day)).toContain('2026-07-01'); // no longer wedged
  });

  it('executePrune REFUSES structurally if the plan carries ANY blocked (uncovered) day — no archive, no delete', async () => {
    const dir = archiveDir('market_rewards', outBase);
    const manifest = { table: 'market_rewards', tsColumn: 'captured_at', updatedAt: NOW.toISOString(), days: {} };
    const plan = { cutoffDay: '2026-07-07', prunable: [], blocked: [{ day: '2026-07-01', reason: 'archive uncovered (shard < live)' }] };
    await expect(executePrune(sdb, REWARDS, dir, manifest, plan)).rejects.toThrow(/no archive, no delete/);
  });

  it('works on a table with no single-column PK (model_stats_history, pruned via ctid)', async () => {
    await seedStat('2026-06-01', 'gfs_seamless', 5); // cold (<30d cutoff 06-21)
    await seedStat('2026-06-01', 'ecmwf_ifs025', 5);
    await seedStat('2026-07-19', 'gfs_seamless', 8); // hot
    const dir = archiveDir('model_stats_history', outBase);

    const m = await archiveAndVerify(sdb, STATS, dir, NOW);
    expect(m.days['2026-06-01']!.rows).toBe(2);
    const plan = planPrune(m, STATS, NOW);
    expect(plan.cutoffDay).toBe('2026-06-21');
    expect(plan.prunable.map((d) => d.day)).toEqual(['2026-06-01']);

    const deleted = await executePrune(sdb, STATS, dir, m, plan);
    expect(deleted).toBe(2);
    expect(await liveDayCount(sdb, STATS, '2026-06-01')).toBe(0);
    expect(await liveDayCount(sdb, STATS, '2026-07-19')).toBe(1);
  });
});
