import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, hasUniqueIndex, migrationFiles, rows } from './harness.ts';

const TABLES = [
  'clusters', 'cities', 'stations', 'city_stations', 'models',
  'forecast_snapshots', 'ensemble_snapshots', 'observations',
  'intraday_max', 'intraday_advances', 'nowcast_lift',
  'market_events', 'market_buckets', 'market_snapshots',
  'bucket_probabilities', 'model_stats', 'model_stats_history',
  'calibration_scores', 'edge_evaluations',
  'bets', 'bankroll_ledger',
  'job_runs', 'job_locks', 'alerts_log',
  'config', 'config_audit', 'backfill_progress',
];

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db.close();
});

describe('migrations 0001–0010', () => {
  it('apply clean on an empty database — all §7 tables and views exist', async () => {
    const found = await rows<{ table_name: string }>(
      db,
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = new Set(found.map((r) => r.table_name));
    for (const t of TABLES) expect(names, `missing table ${t}`).toContain(t);

    const views = await rows<{ table_name: string }>(
      db,
      `select table_name from information_schema.views where table_schema = 'public'`,
    );
    const viewNames = new Set(views.map((r) => r.table_name));
    expect(viewNames).toContain('bankroll_balance');
    expect(viewNames).toContain('edge_decile_stats');
  });

  it('re-apply idempotently — the full chain runs twice without error (db reset semantics)', async () => {
    for (const m of migrationFiles()) {
      await db.exec(m.sql);
    }
    // Seeds did not duplicate.
    const init = await rows(db, `select 1 from bankroll_ledger where entry_type = 'init'`);
    expect(init.length).toBe(1);
    const clusters = await rows(db, `select 1 from clusters`);
    expect(clusters.length).toBe(12);
  });

  it('no RPC is RETURNS SETOF — the port wrap heuristic depends on it', () => {
    // supabasePort (functions/_shared/db.ts) and webPort (apps/web port.ts)
    // normalize PostgREST results by shape: array ⇒ RETURNS TABLE row set,
    // bare value ⇒ wrap as [{ [fn]: value }]. A SETOF scalar/jsonb fn would
    // return a bare-VALUE array PostgREST-side and be misread as rows. Use
    // RETURNS TABLE (or a single jsonb object) instead.
    for (const m of migrationFiles()) {
      expect(m.sql, `${m.name} declares RETURNS SETOF`).not.toMatch(/returns\s+setof/i);
    }
  });

  it('has the migration files in order', () => {
    const names = migrationFiles().map((m) => m.name);
    expect(names).toEqual([
      '0001_extensions.sql', '0002_reference.sql', '0003_ingestion.sql',
      '0004_markets.sql', '0005_analytics.sql', '0006_trading.sql',
      '0007_ops.sql', '0008_rls.sql', '0009_cron.sql', '0010_seed.sql',
      '0011_job_rpcs.sql', '0012_discovery_rpcs.sql', '0013_grading_rpcs.sql',
      '0014_snapshot_rpcs.sql', '0015_truth_rpcs.sql', '0016_distribution_rpcs.sql',
      '0017_calibration_rpcs.sql', '0018_market_rpcs.sql', '0019_trading_rpcs.sql',
      '0020_support_rpcs.sql', '0021_operator_rpcs.sql', '0022_dashboard_rpcs.sql',
      '0023_bet_delivery.sql', '0024_fix_poll_known_events_buckets.sql',
      '0025_source_forecasts.sql',
      '0026_cron_snapshot_sources.sql',
      '0027_calib_statement_timeout.sql',
      // 0028 is RESERVED for the Phase-3 analytics_decouple migration (not yet
      // built); 0029 is the Phase-1 dashboard /events surfacing RPC. The gap is
      // intentional — see 0029_dashboard_events_list.sql header.
      '0029_dashboard_events_list.sql',
    ]);
  });
});

describe('unique / natural keys (§7, §15)', () => {
  const expectations: Array<[string, string[], { partial?: boolean }?]> = [
    ['cities', ['slug']],
    ['city_stations', ['city_id'], { partial: true }],
    ['forecast_snapshots', ['icao', 'model', 'target_date', 'lead_days', 'snapshot_slot']],
    ['ensemble_snapshots', ['icao', 'model', 'target_date', 'snapshot_slot']],
    ['observations', ['icao', 'date_local']],
    ['source_forecasts', ['icao', 'source', 'target_date', 'lead_days', 'snapshot_slot']],
    ['market_events', ['poly_event_id']],
    ['market_events', ['slug']],
    ['market_events', ['city_id', 'target_date', 'kind']],
    ['market_buckets', ['event_id', 'bucket_idx']],
    ['market_buckets', ['poly_market_id']],
    ['market_snapshots', ['bucket_id', 'captured_at']],
    ['bucket_probabilities', ['event_id', 'source', 'inputs_hash']],
    ['model_stats', ['icao', 'model', 'lead_days', 'snapshot_slot']],
    ['model_stats_history', ['icao', 'model', 'lead_days', 'snapshot_slot', 'stats_version']],
    ['calibration_scores', ['city_id', 'source', 'lead_days', 'window_tag']],
    ['bets', ['bucket_id', 'side'], { partial: true }],
    ['bankroll_ledger', ['bet_id', 'entry_type'], { partial: true }],
    ['job_runs', ['job', 'period_key']],
    ['job_locks', ['job']],
    ['edge_evaluations', ['event_id', 'bucket_idx', 'captured_hour']],
    ['intraday_max', ['icao', 'date_local']],
    ['intraday_advances', ['icao', 'date_local', 'local_hour']],
    ['nowcast_lift', ['icao', 'local_hour']],
    ['backfill_progress', ['script', 'scope']],
  ];

  for (const [table, cols, opts] of expectations) {
    it(`${table} unique (${cols.join(', ')})${opts?.partial ? ' [partial]' : ''}`, async () => {
      expect(await hasUniqueIndex(db, table, cols, opts ?? {})).toBe(true);
    });
  }

  it('alerts_log unique (dedupe_key, day) — partial expression index enforces once-per-day', async () => {
    const def = await rows<{ indexdef: string }>(
      db,
      `select indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'alerts_log'
         and indexdef like '%UNIQUE%' and indexdef like '%dedupe_key%'`,
    );
    expect(def.length).toBe(1);
    expect(def[0]!.indexdef).toContain('WHERE');

    await db.exec(
      `insert into alerts_log (kind, severity, dedupe_key, title) values ('TEST', 'INFO', 'dup-test', 'a')`,
    );
    await expect(
      db.exec(
        `insert into alerts_log (kind, severity, dedupe_key, title) values ('TEST', 'INFO', 'dup-test', 'b')`,
      ),
    ).rejects.toThrow(/duplicate key/);
    // null dedupe keys are exempt from the unique rule
    await db.exec(`insert into alerts_log (kind, severity, title) values ('TEST', 'INFO', 'c')`);
    await db.exec(`insert into alerts_log (kind, severity, title) values ('TEST', 'INFO', 'd')`);
    await db.exec(`delete from alerts_log where kind = 'TEST'`);
  });
});

describe('secondary indexes (§7.5 / §7.11)', () => {
  const expected = [
    ['forecast_snapshots', 'forecast_snapshots_icao_target_idx'],
    ['forecast_snapshots', 'forecast_snapshots_model_target_idx'],
    ['forecast_snapshots', 'forecast_snapshots_target_lead_idx'],
    ['market_snapshots', 'market_snapshots_bucket_time_idx'],
  ] as const;

  for (const [table, index] of expected) {
    it(`${table} has ${index}`, async () => {
      const found = await rows(
        db,
        `select 1 from pg_indexes where schemaname = 'public' and tablename = $1 and indexname = $2`,
        [table, index],
      );
      expect(found.length).toBe(1);
    });
  }
});

describe('seeds (0010 — §6.11 config, §7.4 models, clusters, §7.16 init)', () => {
  it('config carries every §6.11 default, bankroll $1,000, tradingMode paper', async () => {
    const cfg = await rows<{ key: string; value: string }>(db, `select key, value from config`);
    const map = new Map(cfg.map((r) => [r.key, r.value]));
    expect(map.get('bankrollUsd')).toBe('1000');
    expect(map.get('tradingMode')).toBe('paper');
    expect(map.get('kellyFraction')).toBe('0.25');
    expect(map.get('championSource')).toBe('house_gaussian');
    expect(map.get('autoApproveMaxStakeUsd')).toBe('0');
    expect(map.get('jobWallLimitSec')).toBe('150');
    expect(map.get('sigmaFloorC')).toBe('0.45');
    const sigmas = JSON.parse(map.get('priorSigmaByLead')!) as number[];
    expect(sigmas).toEqual([1.6, 1.9, 2.3, 2.7, 3.1, 3.5, 3.9, 4.3]);
    expect(map.get('operatorEmail')).toBe('david.geborek@gmail.com');
    // every tunable from the §6.11 table present
    for (const key of [
      'perTradeCapPct', 'perEventCapPct', 'clusterCapPct', 'dailyCapPct',
      'uncertaintyMargin', 'spreadBufferMin', 'minEventVolumeUsd', 'maxSpread',
      'minHoursBeforeClose', 'maxLeadDays', 'probeStakeUsd', 'minStakeUsd',
      'paperSlippage', 'paperBookMaxAgeMin', 'biasAlpha', 'sigmaWindowDays',
      'sigmaMinN', 'breakerConsecLosses', 'breakerDailyLossPct',
      'breakerDrawdownPct', 'breakerBrier', 'staleForecastHaltH', 'stalePriceHaltMin',
    ]) {
      expect(map.has(key), `missing config key ${key}`).toBe(true);
    }
  });

  it('models seeded incl. disabled traps (kma_seamless, ecmwf_ifs04, gfs025) with notes', async () => {
    const models = await rows<{ slug: string; enabled: boolean; is_ensemble: boolean; notes: string | null }>(
      db,
      `select slug, enabled, is_ensemble, notes from models`,
    );
    const bySlug = new Map(models.map((m) => [m.slug, m]));
    for (const slug of [
      'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless', 'gem_seamless',
      'meteofrance_seamless', 'ukmo_seamless', 'cma_grapes_global', 'best_match',
    ]) {
      expect(bySlug.get(slug)?.enabled, `${slug} should be enabled`).toBe(true);
      expect(bySlug.get(slug)?.is_ensemble).toBe(false);
    }
    for (const slug of ['ecmwf_ifs025_ens', 'gfs05_ens']) {
      expect(bySlug.get(slug)?.enabled).toBe(true);
      expect(bySlug.get(slug)?.is_ensemble).toBe(true);
    }
    for (const slug of ['kma_seamless', 'ecmwf_ifs04', 'gfs025']) {
      const trap = bySlug.get(slug);
      expect(trap?.enabled, `${slug} must be a disabled trap`).toBe(false);
      expect(trap?.notes, `${slug} must explain why it is disabled`).toMatch(/TRAP/);
    }
  });

  it('clusters seeded with the 12 §6.8 regions', async () => {
    const regions = await rows<{ region: string }>(db, `select region from clusters order by region`);
    expect(regions.map((r) => r.region)).toEqual([
      'africa', 'east-asia', 'europe-east', 'europe-west', 'latam', 'mideast',
      'na-central', 'na-east', 'na-west', 'oceania', 'south-asia', 'southeast-asia',
    ]);
  });

  it('bankroll_ledger seeded with init $1,000 paper; bankroll_balance view agrees', async () => {
    const ledger = await rows<{ entry_type: string; amount_usd: string; mode: string }>(
      db,
      `select entry_type, amount_usd, mode from bankroll_ledger`,
    );
    expect(ledger).toEqual([{ entry_type: 'init', amount_usd: '1000.00', mode: 'paper' }]);

    const bal = await rows<{ balance_usd: string }>(
      db,
      `select balance_usd from bankroll_balance order by created_at desc limit 1`,
    );
    expect(Number(bal[0]!.balance_usd)).toBe(1000);
  });

  it('bankroll_balance is a window sum per mode (manual arithmetic check)', async () => {
    // Explicit created_at offsets: rows inserted in one statement share now(),
    // and the view's (created_at, id) ordering needs a deterministic sequence.
    await db.exec(`
      insert into bankroll_ledger (entry_type, amount_usd, mode, created_at) values
        ('manual', -50.00, 'paper', now() + interval '1 second'),
        ('manual', 25.00, 'paper', now() + interval '2 seconds'),
        ('init', 500.00, 'live', now() + interval '3 seconds')
    `);
    const paper = await rows<{ balance_usd: string }>(
      db,
      `select balance_usd from bankroll_balance where mode = 'paper' order by created_at, id`,
    );
    expect(paper.map((r) => Number(r.balance_usd))).toEqual([1000, 950, 975]);
    const live = await rows<{ balance_usd: string }>(
      db,
      `select balance_usd from bankroll_balance where mode = 'live'`,
    );
    expect(live.map((r) => Number(r.balance_usd))).toEqual([500]);
    await db.exec(`delete from bankroll_ledger where entry_type = 'manual' or mode = 'live'`);
  });

  it('job_locks seeded with an immediately-claimable poll-markets lease', async () => {
    const locks = await rows<{ job: string; claimable: boolean }>(
      db,
      `select job, (expires_at <= now()) as claimable from job_locks`,
    );
    expect(locks).toEqual([{ job: 'poll-markets', claimable: true }]);
  });
});

describe('RLS (ADR-13, §11.5)', () => {
  it('every table has RLS enabled', async () => {
    const unprotected = await rows<{ relname: string }>(
      db,
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(unprotected.map((r) => r.relname)).toEqual([]);
  });

  it('anon sees nothing', async () => {
    const cfg = await asRole(db, 'anon', null, () => rows(db, `select * from config`));
    expect(cfg.length).toBe(0);
    const cities = await asRole(db, 'anon', null, () => rows(db, `select * from models`));
    expect(cities.length).toBe(0);
  });

  it('authenticated non-operator sees nothing', async () => {
    const cfg = await asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
      rows(db, `select * from config`),
    );
    expect(cfg.length).toBe(0);
  });

  it('the operator email reads everything', async () => {
    const cfg = await asRole(db, 'authenticated', { email: 'david.geborek@gmail.com' }, () =>
      rows(db, `select * from config`),
    );
    expect(cfg.length).toBeGreaterThan(30);
    const models = await asRole(db, 'authenticated', { email: 'david.geborek@gmail.com' }, () =>
      rows(db, `select * from models`),
    );
    expect(models.length).toBe(15); // 14 seeded (§7.4 incl. 3 traps) + the 0017 'blend' pseudo-model
  });

  it('writes are service-role only', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'david.geborek@gmail.com' }, () =>
        rows(db, `insert into config (key, value) values ('hack', '1') returning key`),
      ),
    ).rejects.toThrow();

    const inserted = await asRole(db, 'service_role', null, () =>
      rows(db, `insert into config (key, value) values ('rls-test', '1') returning key`),
    );
    expect(inserted.length).toBe(1);
    await db.exec(`delete from config where key = 'rls-test'`);
  });
});

describe('pg_cron registrations (§7.22, W11)', () => {
  it('registers all 13 jobs with the §7.22 schedules', async () => {
    const jobs = await rows<{ jobname: string; schedule: string }>(
      db,
      `select jobname, schedule from cron.job order by jobname`,
    );
    const expected: Record<string, string> = {
      'discover-markets': '10 2,4,5,11,17 * * *',
      'snapshot-forecasts': '15 10,22 * * *',
      'snapshot-ensembles': '35 10,22 * * *',
      'snapshot-sources': '25 10,22 * * *',
      'build-distributions': '50 10,22 * * *',
      'poll-markets': '*/5 * * * *',
      'metar-nowcast': '*/15 * * * *',
      'fetch-actuals': '20 * * * *',
      'run-calibration': '30 11 * * *',
      'grade-bets': '0 6 * * *',
      'daily-digest': '0 7 * * *',
      'health-monitor': '*/30 * * * *',
      'snapshot-downsample': '0 3 * * *',
    };
    expect(jobs.length).toBe(13);
    for (const j of jobs) {
      expect(j.schedule, `schedule for ${j.jobname}`).toBe(expected[j.jobname]);
    }
  });

  it('W11: commands read secrets from Vault — no literal secret in cron.job', async () => {
    const jobs = await rows<{ jobname: string; command: string }>(
      db,
      `select jobname, command from cron.job where jobname <> 'snapshot-downsample'`,
    );
    for (const j of jobs) {
      expect(j.command).toContain(`vault.decrypted_secrets where name = 'cron_secret'`);
      expect(j.command).toContain(`vault.decrypted_secrets where name = 'project_url'`);
      expect(j.command).toContain(`/functions/v1/${j.jobname}`);
      expect(j.command).toContain('timeout_milliseconds := 4500');
      // No secret-shaped literal anywhere in the registered command.
      expect(j.command).not.toMatch(/x-cron-secret',\s*'[^(]/);
      expect(j.command).not.toMatch(/(sk|whsec|sbp)_[A-Za-z0-9]/);
    }
  });

  it('execute-bet is NOT cron-registered (ADR-10)', async () => {
    const hits = await rows(db, `select 1 from cron.job where command like '%execute-bet%'`);
    expect(hits.length).toBe(0);
  });

  it('the SQL-only downsample job invokes ops_downsample()', async () => {
    const j = await rows<{ command: string }>(
      db,
      `select command from cron.job where jobname = 'snapshot-downsample'`,
    );
    expect(j[0]!.command).toBe('select public.ops_downsample()');
  });
});
