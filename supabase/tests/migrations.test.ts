import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
      // 0028 = Phase-3 HD-1 de-gate (list_buildable_events drops cs.verified=true,
      // decoupling the analytics house build from the trading gate); 0029 = the
      // Phase-1 dashboard /events surfacing RPC. Shipped out of numeric order
      // (0029 first) — see each file's header.
      '0028_analytics_decouple.sql',
      '0029_dashboard_events_list.sql',
      // 0030 = Phase-3 C3/R-A6 dead-man halt auto-recovery (clear_system_halt RPC +
      // health-monitor recovery branch); 0031 = Phase-3 DF-2/3 get_build_inputs
      // p_allow_backfill opt-in param (default-false keeps the live build bit-identical).
      '0030_clear_system_halt.sql',
      '0031_get_build_inputs_allow_backfill.sql',
      // 0032 = halt-lifecycle hardening (reason-aware clear_system_halt + operator-aware apply_halt +
      // revokes/grants on both + config_audit(key,created_at) index); 0033 = get_build_inputs R-A3
      // structural backfill guard (target_date>=current_date) + live-over-backfill tie-break.
      '0032_halt_lifecycle_hardening.sql',
      '0033_get_build_inputs_ra3_guard.sql',
      // 0034 = internal-RPC lockdown sweep — revoke the whole SECURITY DEFINER RPC layer from
      // public/anon/authenticated, keeping service_role everywhere + the exact dashboard surface on
      // authenticated + health_check on anon. Generalises the 0023/0032 per-function revokes.
      '0034_lockdown_internal_rpcs.sql',
      // 0035 = /city per-station daily-Tmax inspector (dash_station_observations) — ships its own
      // post-0034 revoke/grant; added to WEB_AUTHENTICATED below.
      '0035_dashboard_station_observations.sql',
      // 0036 = grade-bets sweep recency window (sweep_grading_targets gains p_since; bounds the
      // backfill-resurrected backlog) + dash_city_detail "today's market" hardening.
      '0036_grading_sweep_window_and_today_market.sql',
      // 0037 = operator_export_predictions — prediction-vs-actual CSV (always °C); own revoke/grant.
      '0037_operator_export_predictions.sql',
      // 0038 = dash_station_predictions — /city prediction-vs-actual + forecast-skill panel (always °C,
      // on-page complement to 0037's CSV); own post-0034 revoke/grant, added to WEB_AUTHENTICATED below.
      '0038_dashboard_station_predictions.sql',
      // 0039 = Amsterdam paper-trade sim (amsterdam_paper_bets + 4 service-role place/grade RPCs +
      // dash_amsterdam_sim on authenticated, added to WEB_AUTHENTICATED below) + the daily cron.
      '0039_amsterdam_paper_sim.sql',
      // 0040 = forecast-aware Amsterdam nowcast — adds forecast_c, lifts the running-max floor to the
      // bias-corrected lead-1 forecast at early arms in amsterdam_sim_place_inputs (signatures unchanged).
      '0040_amsterdam_forecast_nowcast.sql',
      // 0041 = trailing-window bias (review follow-up) — amsterdam_sim_place_inputs' bias becomes the last
      // 30 finalized pairs instead of an all-history mean; refreshes two stale 0039 column comments.
      '0041_amsterdam_nowcast_trailing_bias.sql',
      // 0042 = edge/EV confidence intervals — dash_amsterdam_sim gains a betsByArm payload (graded (won,
      // ask) per arm) so the loader computes per-arm hit/edge/EV CIs via core/sim/stats (read-only,
      // additive, no new surface). dash_amsterdam_sim stays in WEB_AUTHENTICATED (unchanged signature).
      '0042_amsterdam_edge_ci.sql',
      // 0043 = floor "truth accuracy" — new amsterdam_truth table (KNMI decimal high) + 3 service-role truth
      // RPCs (upsert/inputs/record) + bet columns (actual_decimal_c/truth_won/signed_error_c); dash gains a
      // truth panel + truthByArm. dash_amsterdam_sim stays in WEB_AUTHENTICATED (unchanged signature).
      '0043_amsterdam_truth_floor_accuracy.sql',
      // 0044 = wrap the two Amsterdam *_inputs RPCs in { rows: [...] } — they returned a TOP-LEVEL jsonb
      // array, which supabasePort misreads as a RETURNS TABLE row set, silently zeroing the Edge tick's
      // grade + truth-fill since 0039/0043 (19 bets stuck pending). Pure envelope change; callers read .rows.
      '0044_amsterdam_inputs_wrap.sql',
      // 0045 = calib_scored_rows access-path fix — run-calibration's daily cron timed out at step (3)
      // SCORES (calibration_scores frozen since 2026-06-19) because the RPC scanned ~91k non-nowcast bp
      // rows to keep ~1,914 scored ones. Adds a partial index on (event_id) where scored_for_leads<>'{}'
      // and nowcast=false + the matching explicit WHERE predicate (semantic no-op) + 60s headroom (0027 twin).
      '0045_calib_scored_rows_perf.sql',
      // 0046 = surface tomorrow's prediction + the live "as-of-now" running max — redefines the whole 0043
      // dash_amsterdam_sim body (additive) with `tomorrow` (bias-corrected lead-1 forecast → bucket → odds)
      // and `liveRunMax` (intraday_max) blocks. Unchanged signature; stays in WEB_AUTHENTICATED.
      '0046_amsterdam_tomorrow_live.sql',
      // 0047 = code-review follow-up to 0046: tomorrow.nModels counts DISTINCT models (was count(*) captures,
      // ~2x when 10Z+22Z both land). Whole dash_amsterdam_sim body re-stated (create-or-replace); count only.
      '0047_amsterdam_nmodels_distinct.sql',
      // 0048 = in-lock-hour ask guard: amsterdam_sim_place_inputs only records an ask QUOTED inside the arm's
      // lock hour [lockstart, asof); no in-hour quote → arm skipped (was an unbounded backward forward-fill
      // that stamped pre-hour/phantom odds onto thin early-day bets). 0041 body verbatim; ask bound added.
      '0048_amsterdam_in_hour_ask_guard.sql',
      // 0049 = sharp-wallet & WEATHER-leaderboard benchmark tracker (tracked_wallets +
      // wallet_leaderboard_snapshots + wallet_positions_daily + 2 service-role record RPCs); dash_amsterdam_sim
      // gains an additive `sharps` key (whole body re-stated) — stays in WEB_AUTHENTICATED. New daily cron
      // sharp-wallet-track at 16:00 UTC (count 14 → 15 below). WALLET-RECON-HANDOFF.md Build #1.
      '0049_sharp_wallet_tracker.sql',
      // 0050 = wallet-forensics persistence (Build #2): wallet_pnl_daily + wallet_bet_calibration +
      // wallet_forensics_record (idempotent, service-role only). RLS/grants mirror 0043/0049; no cron, no
      // dashboard-surface change. WALLET-RECON-HANDOFF.md Build #2 (the skill-vs-survivorship gate).
      '0050_wallet_forensics_persist.sql',
      // 0051 = ncep_nbm_conus model seed (Build #3 US sub-lever): one additive row in `models`
      // (CONUS National Blend of Models, registered for the day-before bucket A/B; live-verified slug is
      // `ncep_nbm_conus`). No table, RLS, cron, or RPC change. WALLET-RECON-HANDOFF.md §6 Build #3 / §7 item 2.
      '0051_nbm_conus_model.sql',
      // 0052 = today's predicted high from the freshest same-day forecast: dash_amsterdam_sim gains an
      // additive `today` block (whole 0049 body re-stated; freshest forecast_snapshots capture for today,
      // matched-lead trailing debias). Unchanged signature; stays in WEB_AUTHENTICATED.
      '0052_amsterdam_today_forecast.sql',
      // 0053 = badatmath-replica paper-trial persistence: replica_positions + replica_runs +
      // replica_record_positions/_run (service-role writes) + dash_replica_sim (operator read, added to
      // WEB_AUTHENTICATED below). Powers the /replica dashboard. No cron. BADATMATH-REPLICA.md.
      '0053_replica_paper_trial.sql',
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
    ['config_audit', 'config_audit_key_created_idx'], // 0032 FIX 9 — last-writer lookup
    ['bucket_probabilities', 'bucket_probabilities_scored_idx'], // 0045 — calib_scored_rows access path
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

  it('0045: bucket_probabilities_scored_idx is PARTIAL on (event_id) over scored, non-nowcast rows', async () => {
    // The partial predicate is what makes calib_scored_rows scale with scored rows (~3/event/day)
    // instead of the whole bucket_probabilities table. A plain full index would not gate the timeout.
    const [idx] = await rows<{ indexdef: string }>(
      db,
      `select indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'bucket_probabilities'
         and indexname = 'bucket_probabilities_scored_idx'`,
    );
    expect(idx).toBeDefined();
    expect(idx!.indexdef).toMatch(/\(event_id\)/);
    expect(idx!.indexdef).toContain('WHERE');
    expect(idx!.indexdef).toMatch(/scored_for_leads <>/);
    expect(idx!.indexdef).toMatch(/nowcast/);
  });
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
    expect(models.length).toBe(16); // 14 seeded (§7.4 incl. 3 traps) + the 0017 'blend' pseudo-model + ncep_nbm_conus (0051)
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

describe('clear_system_halt (0030/0032 — reason-aware C3 / R-A6 dead-man auto-recovery)', () => {
  // The dead-man reason prefixes the health-monitor passes (packages/core risk.ts contract).
  const FC = 'dead-man:forecast';
  const PR = 'dead-man:price';
  const DEAD_MAN = [FC, PR];
  const pgArray = (xs: string[]) => `array[${xs.map((x) => `'${x}'`).join(',')}]::text[]`;
  const clear = async (scope: string, prefixes: string[]) =>
    rows<{ clear_system_halt: boolean }>(
      db,
      `select public.clear_system_halt('${scope}', ${pgArray(prefixes)})`,
    );

  afterEach(async () => {
    await db.exec(`delete from config_audit where key = 'halt:global'`);
    await db.exec(`delete from config where key = 'halt:global'`);
  });

  it('deletes a SYSTEM dead-man halt whose reason matches a prefix and returns true', async () => {
    await db.exec(`select public.apply_halt('global', '${FC}: freshest forecast 31h old')`); // actor='system'
    const [r] = await clear('global', DEAD_MAN);
    expect(r!.clear_system_halt).toBe(true);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(0);
  });

  it('FIX 1: does NOT clear a SYSTEM calibration-drift halt even when its writer is system', async () => {
    // run-calibration applies actor='system' with a NON-dead-man reason; recovery must leave it.
    await db.exec(
      `select public.apply_halt('global', 'calibration drift: champion ≥ market_consensus on both 30d and 60d pooled windows')`,
    );
    const [r] = await clear('global', DEAD_MAN);
    expect(r!.clear_system_halt).toBe(false);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
  });

  it('FIX 1: does NOT clear a SYSTEM P&L / drawdown halt (no dead-man prefix)', async () => {
    await db.exec(`select public.apply_halt('global', 'drawdown 30.0% ≥ 25%')`);
    const [r] = await clear('global', DEAD_MAN);
    expect(r!.clear_system_halt).toBe(false);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
  });

  it('FIX 1: prefix match is a starts-with — a price dead-man clears under the price prefix', async () => {
    await db.exec(`select public.apply_halt('global', '${PR}: freshest price 31min old ≥ 30min')`);
    // Passing ONLY the forecast prefix must NOT clear a price halt (exact, distinct tags).
    const [no] = await clear('global', [FC]);
    expect(no!.clear_system_halt).toBe(false);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
    // Passing the price prefix clears it.
    const [yes] = await clear('global', [PR]);
    expect(yes!.clear_system_halt).toBe(true);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(0);
  });

  it('REFUSES to delete an OPERATOR-authored halt (actor=admin-ui) and returns false', async () => {
    // operator_halt self-guards via operator_guard → is_operator → auth.jwt(); asRole sets the
    // operator email claim AND the role, then restores — no manual set_config triple (finding D).
    await asRole(db, 'service_role', { email: 'david.geborek@gmail.com' }, () =>
      rows(db, `select public.operator_halt('global', '${FC}: looks like a dead-man reason')`),
    );
    // Even with a reason that WOULD match a prefix, an operator (admin-ui) last-writer is untouchable.
    const [r] = await clear('global', DEAD_MAN);
    expect(r!.clear_system_halt).toBe(false);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
  });

  it('REFUSES when the LAST writer was the operator even if the FIRST was the system', async () => {
    await db.exec(`select public.apply_halt('global', '${FC}: system applied')`); // actor='system'
    // Operator subsequently re-authors the same halt → last writer is admin-ui. In production
    // these are separate invocations at distinct wall-clock times; created_at strictly orders
    // them (config_audit's PK is a random uuid, not monotonic, so created_at is the discriminator).
    await db.exec(
      `insert into config_audit (key, old_value, new_value, actor, created_at)
       values ('halt:global', 'system applied', 'operator override', 'admin-ui', now() + interval '1 second')`,
    );
    const [r] = await clear('global', DEAD_MAN);
    expect(r!.clear_system_halt).toBe(false);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
  });

  it('returns false when no halt exists (idempotent no-op)', async () => {
    const [r] = await clear('global', DEAD_MAN);
    expect(r!.clear_system_halt).toBe(false);
  });

  it('audits the deletion with actor=system-recover (the widened 0007 check admits it)', async () => {
    await db.exec(`select public.apply_halt('global', '${FC}: freshest forecast 31h old')`);
    const [r] = await clear('global', DEAD_MAN);
    expect(r!.clear_system_halt).toBe(true); // the clear succeeded → it appended the recover audit
    // The widened 0007 CHECK admits 'system-recover'; exactly one such audit row was written, and
    // its new_value marks the auto-recovery. (Assert by actor, not by "newest row": the apply audit
    // and the recover audit can share created_at in-test, and id is a random uuid → ordering ties.)
    const recover = await rows<{ new_value: string }>(
      db,
      `select new_value from config_audit where key = 'halt:global' and actor = 'system-recover'`,
    );
    expect(recover).toHaveLength(1);
    expect(recover[0]!.new_value).toBe('auto-recovered');
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(0);
  });

  it('the 0030 single-arg clear_system_halt(text) overload is dropped (0032)', async () => {
    const overloads = await rows<{ nargs: number }>(
      db,
      `select pronargs as nargs from pg_proc where proname = 'clear_system_halt'
         and pronamespace = 'public'::regnamespace`,
    );
    // Exactly one overload remains: the 2-arg (text, text[]) form.
    expect(overloads.map((o) => o.nargs).sort()).toEqual([2]);
  });
});

describe('FIX 2: apply_halt does not clobber a live operator halt (0032)', () => {
  afterEach(async () => {
    await db.exec(`delete from config_audit where key = 'halt:global'`);
    await db.exec(`delete from config where key = 'halt:global'`);
  });

  it('a system apply_halt over a live OPERATOR halt is a no-op (last writer stays admin-ui, reason kept)', async () => {
    await asRole(db, 'service_role', { email: 'david.geborek@gmail.com' }, () =>
      rows(db, `select public.operator_halt('global', 'deliberate operator stop')`),
    );
    const before = await rows<{ value: string }>(db, `select value from config where key = 'halt:global'`);

    await db.exec(`select public.apply_halt('global', 'dead-man:forecast: stale pipeline')`);

    // The stored reason is unchanged (operator's reason survives).
    const after = await rows<{ value: string }>(db, `select value from config where key = 'halt:global'`);
    expect(after[0]!.value).toBe(before[0]!.value);
    // The last config_audit writer is STILL admin-ui (no system re-audit row appended).
    const [lastAudit] = await rows<{ actor: string }>(
      db,
      `select actor from config_audit where key = 'halt:global' order by created_at desc, id desc limit 1`,
    );
    expect(lastAudit!.actor).toBe('admin-ui');

    // A subsequent reason-aware clear therefore still refuses (the operator halt is protected).
    const [r] = await rows<{ clear_system_halt: boolean }>(
      db,
      `select public.clear_system_halt('global', array['dead-man:forecast','dead-man:price']::text[])`,
    );
    expect(r!.clear_system_halt).toBe(false);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
  });

  it('a system apply_halt with no prior halt still works (reason written, actor=system)', async () => {
    await db.exec(`select public.apply_halt('global', 'dead-man:forecast: freshest forecast 31h old')`);
    const [audit] = await rows<{ actor: string; new_value: string }>(
      db,
      `select actor, new_value from config_audit where key = 'halt:global' order by created_at desc, id desc limit 1`,
    );
    expect(audit!.actor).toBe('system');
    expect(audit!.new_value).toContain('dead-man:forecast');
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
  });
});

describe('FIX 3: halt RPCs are service-role-internal (revoked from anon/authenticated, 0032)', () => {
  const lacksExecute = async (signature: string, role: string): Promise<boolean> => {
    const [r] = await rows<{ has: boolean }>(
      db,
      `select has_function_privilege('${role}', '${signature}', 'EXECUTE') as has`,
    );
    return r!.has === false;
  };

  it('apply_halt(text, text): anon + authenticated lack EXECUTE; service_role has it', async () => {
    expect(await lacksExecute('public.apply_halt(text, text)', 'anon')).toBe(true);
    expect(await lacksExecute('public.apply_halt(text, text)', 'authenticated')).toBe(true);
    const [svc] = await rows<{ has: boolean }>(
      db,
      `select has_function_privilege('service_role', 'public.apply_halt(text, text)', 'EXECUTE') as has`,
    );
    expect(svc!.has).toBe(true);
  });

  it('clear_system_halt(text, text[]): anon + authenticated lack EXECUTE; service_role has it', async () => {
    expect(await lacksExecute('public.clear_system_halt(text, text[])', 'anon')).toBe(true);
    expect(await lacksExecute('public.clear_system_halt(text, text[])', 'authenticated')).toBe(true);
    const [svc] = await rows<{ has: boolean }>(
      db,
      `select has_function_privilege('service_role', 'public.clear_system_halt(text, text[])', 'EXECUTE') as has`,
    );
    expect(svc!.has).toBe(true);
  });

  it('public (PUBLIC pseudo-role) cannot EXECUTE either RPC', async () => {
    expect(await lacksExecute('public.apply_halt(text, text)', 'public')).toBe(true);
    expect(await lacksExecute('public.clear_system_halt(text, text[])', 'public')).toBe(true);
  });
});

describe('0034: internal-RPC lockdown — anon/authenticated revoked except the web surface', () => {
  // Mirrors the migration's allow-lists. The migration is the source of truth; this set is the
  // contract the dashboard depends on (apps/web routes.ts/prod.ts/.rpc + loaders.ts dash_* +
  // trading goLiveGate). Drift in either direction fails a test below.
  const WEB_AUTHENTICATED = new Set([
    'dash_today_overview', 'dash_events_list', 'dash_event_detail', 'dash_city_detail',
    'dash_calibration', 'dash_bets_ledger', 'dash_system_health', 'dash_admin_state',
    'dash_station_observations', 'dash_station_predictions',
    'dash_amsterdam_sim', 'dash_replica_sim',
    'go_live_gate_inputs',
    'operator_halt', 'operator_resume', 'operator_update_config', 'operator_verify_station',
    'operator_set_champion', 'operator_skip_bet', 'operator_manual_bet',
    'operator_record_external_fill', 'operator_export_rows', 'operator_export_predictions',
    'bet_for_execution', 'promotion_check_rows',
    'claim_alert', 'mark_alert_sent', 'health_check',
  ]);
  const WEB_ANON = new Set(['health_check']);
  // is_operator is not a dashboard RPC — it is the helper the 0008 `to authenticated` RLS policies
  // call AS the querying role, so authenticated must retain EXECUTE or operator-gated reads throw.
  const RLS_HELPERS = new Set(['is_operator']);
  const AUTHENTICATED_OK = new Set([...WEB_AUTHENTICATED, ...RLS_HELPERS]);

  interface Grant {
    proname: string;
    anon_can: boolean;
    authd_can: boolean;
    svc_can: boolean;
  }
  let grants: Grant[];

  beforeAll(async () => {
    // The same surface the migration sweeps: plain public functions, minus trigger + extension fns.
    grants = await rows<Grant>(
      db,
      `select p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authd_can,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_can
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and p.prorettype <> 'pg_catalog.trigger'::regtype
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
    );
  });

  it('sweeps a meaningful surface (the full RPC layer, >70 functions)', () => {
    expect(grants.length).toBeGreaterThan(70);
  });

  it('UNDER-revoke guard: no RPC is anon-EXECUTE-able except the /api/health probe', () => {
    const leaks = grants.filter((g) => g.anon_can && !WEB_ANON.has(g.proname)).map((g) => g.proname).sort();
    expect(leaks).toEqual([]);
  });

  it('UNDER-revoke guard: no RPC is authenticated-EXECUTE-able outside the dashboard surface', () => {
    const leaks = grants
      .filter((g) => g.authd_can && !AUTHENTICATED_OK.has(g.proname))
      .map((g) => g.proname)
      .sort();
    expect(leaks).toEqual([]);
  });

  it('OVER-revoke guard: is_operator stays authenticated-executable (the 0008 RLS policies need it)', () => {
    // Revoking this re-breaks every `for select to authenticated using (is_operator())` policy —
    // operator-gated table reads would raise "permission denied for function is_operator".
    expect(grants.find((g) => g.proname === 'is_operator')?.authd_can).toBe(true);
  });

  it('OVER-revoke guard: every dashboard-surface RPC keeps authenticated EXECUTE', () => {
    const present = new Map(grants.map((g) => [g.proname, g]));
    const broken = [...WEB_AUTHENTICATED]
      .filter((n) => present.has(n) && !present.get(n)!.authd_can)
      .sort();
    expect(broken).toEqual([]);
  });

  it('service_role retains EXECUTE on every swept function (Edge Functions unaffected)', () => {
    const lost = grants.filter((g) => !g.svc_can).map((g) => g.proname).sort();
    expect(lost).toEqual([]);
  });

  it('health_check stays anon-callable (the out-of-band uptime probe runs as anon)', () => {
    expect(grants.find((g) => g.proname === 'health_check')?.anon_can).toBe(true);
  });

  it('representative service-role-internal writers are fully locked from anon + authenticated', () => {
    const writers = [
      'settle_bets', 'fill_bet_with_caps', 'finalize_observation', 'upsert_forecast_rows',
      'claim_job_run', 'complete_job_run', 'claim_event_winner', 'score_distributions',
    ];
    for (const fn of writers) {
      const g = grants.find((x) => x.proname === fn);
      expect(g, `${fn} should exist in the public RPC layer`).toBeTruthy();
      expect(g!.anon_can, `${fn} must NOT be anon-executable`).toBe(false);
      expect(g!.authd_can, `${fn} must NOT be authenticated-executable`).toBe(false);
      expect(g!.svc_can, `${fn} must stay service_role-executable`).toBe(true);
    }
  });
});

describe('pg_cron registrations (§7.22, W11)', () => {
  it('registers all 14 jobs with the §7.22 schedules', async () => {
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
      'amsterdam-paper-trade': '30 15 * * *',
      'sharp-wallet-track': '0 16 * * *',
    };
    expect(jobs.length).toBe(15);
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
