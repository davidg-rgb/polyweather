/**
 * scripts/city-sim — seed + analyse the GENERALIZED multi-city paper-trade (migration 0070).
 *
 * The Amsterdam paper-trade (scripts/amsterdam-sim.ts) for N operator-chosen cities (Singapore + Karachi
 * today). For each ACTIVE city in city_sim_config it reconstructs the config arm hours over the city's
 * history from persisted intraday running maxima + in-lock-hour market snapshots (the SAME
 * city_sim_* RPCs + @weather-edge/core planners the city-paper-trade Edge Function uses, so a backfilled
 * bet is byte-identical to a live one), grades anything whose observation has finalized, then prints, per
 * city:
 *
 *   A — the DECISION BASIS: per local hour, our exact-bucket hit rate (pure running-max floor), the market
 *       ask on our predicted bucket, and the realised EV per $1 — the "best time of day" evidence.
 *   B — the LEADERBOARD: each arm's record so far (net P&L, ROI, hit rate) — who's winning.
 *
 * Idempotent (record ON CONFLICT DO NOTHING; settle only flips pending) — safe to re-run any time to extend
 * history forward. NOT trading — the analytics-pivot deliverable (see CLAUDE.md).
 *
 * Run: pnpm tsx scripts/city-sim.ts [--city singapore] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--analyze-only]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { type GradeInputRow, type PlaceInputs, planPlacements, planSettlements } from '../packages/core/src/index.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

interface CityConfig {
  cityId: string;
  slug: string;
  icao: string;
  unit: string;
  tz: string;
  armHours: number[];
  forecastMaxHour: number;
  stakeUsd: number;
  displayName: string;
}
type CityPlaceInputs = (PlaceInputs & { cityId: string; icao: string; unit: string; stakeUsd: number }) | null;

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const f2 = (v: unknown, dp = 2): string => {
  const n = num(v);
  return n === null ? '—' : n.toFixed(dp);
};
const usd = (v: unknown): string => {
  const n = num(v);
  if (n === null) return '—';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
};
const pct = (v: unknown): string => {
  const n = num(v);
  return n === null ? '—' : `${(n * 100).toFixed(0)}%`;
};

async function activeConfigs(db: ScriptDb): Promise<CityConfig[]> {
  const r = await db.query<{ v: CityConfig[] }>(`select public.city_sim_active_configs() as v`);
  return r[0]?.v ?? [];
}

/** Distinct target dates for a city that CAN be simulated: have intraday + at least one snapshot. */
async function simulableDates(
  db: ScriptDb,
  cfg: CityConfig,
  from: string | null,
  to: string | null,
): Promise<string[]> {
  const r = await db.query<{ d: string }>(
    `select distinct me.target_date::text as d
     from market_events me
     where me.city_id = $1 and me.kind = 'highest'
       and exists (select 1 from intraday_advances ia where ia.icao = $2 and ia.date_local = me.target_date)
       and exists (select 1 from market_buckets mb
                   join market_snapshots ms on ms.bucket_id = mb.id where mb.event_id = me.id)
       and ($3::date is null or me.target_date >= $3::date)
       and ($4::date is null or me.target_date <= $4::date)
     order by 1`,
    [cfg.cityId, cfg.icao, from, to],
  );
  return r.map((x) => x.d);
}

async function place(db: ScriptDb, cfg: CityConfig, date: string, nowIso: string): Promise<number> {
  const r = await db.query<{ v: CityPlaceInputs }>(
    `select public.city_sim_place_inputs($1::uuid, $2::date, $3::timestamptz) as v`,
    [cfg.cityId, date, nowIso],
  );
  const input = r[0]?.v ?? null;
  if (!input || input.arms.length === 0) return 0;
  const placements = planPlacements(input, { stakeUsd: input.stakeUsd });
  if (placements.length === 0) return 0;
  // Pass the RAW array — postgres-js JSON-encodes for the `$4::jsonb` cast (a JSON.stringify would
  // double-encode into a scalar → "cannot extract elements").
  const rec = await db.query<{ n: number }>(
    `select public.city_sim_record($1::uuid, $2::text, $3::text, $4::jsonb) as n`,
    [cfg.cityId, cfg.icao, cfg.unit, placements],
  );
  return Number(rec[0]?.n ?? 0);
}

async function grade(db: ScriptDb): Promise<number> {
  const g = await db.query<{ v: { rows: GradeInputRow[] } }>(`select public.city_sim_grade_inputs() as v`);
  const pending = g[0]?.v?.rows ?? [];
  if (pending.length === 0) return 0;
  const settlements = planSettlements(pending);
  const s = await db.query<{ n: number }>(`select public.city_sim_settle($1::jsonb) as n`, [settlements]);
  return Number(s[0]?.n ?? 0);
}

/** Table A — per-hour decision basis over all resolved events for the city (the "best time" evidence). */
async function decisionBasis(db: ScriptDb, cfg: CityConfig): Promise<void> {
  // runmax + ladder are unit-aware: convert the °C floor to the city native unit before bucketing.
  const rowsA = await db.query<{
    local_hour: number;
    n_days: number;
    exact_hit: string;
    n_ask: number;
    avg_ask_pred: string;
    ev_per_dollar: string;
  }>(
    `with ev as (
       select me.id, me.target_date, me.winning_bucket_idx from market_events me
       where me.city_id = $1 and me.kind = 'highest' and me.winning_bucket_idx is not null),
     hours as (select generate_series(9,17) h),
     base as (
       select ev.id event_id, ev.target_date, ev.winning_bucket_idx, hh.h,
         (select case when $4='F' then max(ia.max_tenths_c)*9.0/5.0+32 else max(ia.max_tenths_c) end
          from intraday_advances ia
          where ia.icao=$2 and ia.date_local=ev.target_date and ia.local_hour<=hh.h) runmax
       from ev cross join hours hh),
     pred as (
       select b.*, round(b.runmax)::int pred_native,
         (b.target_date::timestamp + make_interval(hours => b.h))   at time zone $3 lockstart,
         (b.target_date::timestamp + make_interval(hours => b.h+1)) at time zone $3 asof
       from base b where b.runmax is not null),
     pb as (
       select p.*, mb.bucket_idx pred_idx, mb.id pred_bucket_id
       from pred p join market_buckets mb on mb.event_id=p.event_id
         and (mb.low_native is null or p.pred_native>=mb.low_native)
         and (mb.high_native is null or p.pred_native<=mb.high_native)),
     wa as (
       select pb.*, (select ms.best_ask from market_snapshots ms
         where ms.bucket_id=pb.pred_bucket_id
           and ms.captured_at>=pb.lockstart and ms.captured_at<pb.asof and ms.best_ask is not null
         order by ms.captured_at desc limit 1) ask from pb)
     select h local_hour, count(*) n_days,
       round(avg((pred_idx=winning_bucket_idx)::int),2)::text exact_hit,
       count(ask) n_ask, round(avg(ask)::numeric,3)::text avg_ask_pred,
       round(avg(case when ask is not null and ask>0 then
         (case when pred_idx=winning_bucket_idx then (1-ask)/ask else -1 end) end)::numeric,3)::text ev_per_dollar
     from wa group by h order by h`,
    [cfg.cityId, cfg.icao, cfg.tz, cfg.unit],
  );

  console.log(`\n── A · ${cfg.displayName} (${cfg.icao}) — best time of day, pure running-max floor (all resolved events) ──`);
  console.log('  (Baseline only: scores wuRound(running max), the pre-forecast predictor. Placed bets (Table B)');
  console.log(`   use the forecast-aware lift at arms <= ${cfg.forecastMaxHour}. Arms raced: ${cfg.armHours.join('/')}.)`);
  console.log('  hour  days  exact-hit   n-odds  avg-ask(pred)   EV/$1');
  for (const r of rowsA) {
    const star = cfg.armHours.includes(r.local_hour) ? ' ◀ arm' : '';
    console.log(
      `  ${String(r.local_hour).padStart(2)}:00  ${String(r.n_days).padStart(4)}   ` +
        `${pct(r.exact_hit).padStart(6)}     ${String(r.n_ask).padStart(4)}    ` +
        `${f2(r.avg_ask_pred, 3).padStart(6)}        ${f2(r.ev_per_dollar, 3).padStart(7)}${star}`,
    );
  }
  console.log('  (EV/$1 over the dense-odds days only — n-odds; thin until the live sim accrues n.)');
}

/** Table B — the live leaderboard for the city (who gains the most). */
async function leaderboard(db: ScriptDb, cfg: CityConfig): Promise<void> {
  const rowsB = await db.query<{
    arm_hour: number;
    n_bets: number;
    n_graded: number;
    n_pending: number;
    hit: string | null;
    staked: string | null;
    pnl: string;
    roi: string | null;
    avg_ask: string | null;
  }>(
    `select arm_hour,
       count(*) n_bets,
       count(*) filter (where status<>'pending') n_graded,
       count(*) filter (where status='pending') n_pending,
       round(avg((won)::int) filter (where status<>'pending'),2)::text hit,
       round(sum(stake_usd) filter (where status<>'pending'),2)::text staked,
       coalesce(round(sum(pnl_usd),2),0)::text pnl,
       round(sum(pnl_usd) / nullif(sum(stake_usd) filter (where status<>'pending'),0),3)::text roi,
       round(avg(ask),3)::text avg_ask
     from city_paper_bets where city_id = $1 group by arm_hour order by coalesce(sum(pnl_usd),0) desc, arm_hour`,
    [cfg.cityId],
  );

  console.log(`\n── B · ${cfg.displayName} leaderboard — $${cfg.stakeUsd.toFixed(0)}/day per arm, net P&L (who gains the most) ──`);
  if (rowsB.length === 0) {
    console.log('  (no bets recorded yet)');
    return;
  }
  console.log('  rank  arm    bets  graded  pending   hit   avg-ask    staked       net P&L     ROI');
  rowsB.forEach((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    console.log(
      `  ${medal} ${i + 1}  ${String(r.arm_hour)}:00  ${String(r.n_bets).padStart(4)}  ` +
        `${String(r.n_graded).padStart(6)}  ${String(r.n_pending).padStart(7)}   ${pct(r.hit).padStart(4)}   ` +
        `${f2(r.avg_ask, 3).padStart(6)}   ${(r.staked ? `$${Number(r.staked).toFixed(2)}` : '—').padStart(8)}   ` +
        `${usd(r.pnl).padStart(10)}   ${f2(r.roi, 3).padStart(6)}`,
    );
  });
}

async function main(): Promise<void> {
  loadEnv();
  const { values } = parseArgs({
    options: {
      city: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'analyze-only': { type: 'boolean', default: false },
    },
  });
  const db = makeScriptDb();
  try {
    let configs = await activeConfigs(db);
    if (values.city) configs = configs.filter((c) => c.slug === values.city);
    if (configs.length === 0) {
      console.log(values.city ? `No active city_sim_config for "${values.city}".` : 'No active city_sim_config rows.');
      return;
    }
    const analyzeOnly = values['analyze-only'] === true;
    if (!analyzeOnly) {
      const now = new Date().toISOString();
      for (const cfg of configs) {
        const dates = await simulableDates(db, cfg, values.from ?? null, values.to ?? null);
        let placed = 0;
        for (const d of dates) placed += await place(db, cfg, d, now);
        console.log(
          `${cfg.displayName}: ${dates.length} simulable day(s) (${dates[0] ?? '—'} → ${dates.at(-1) ?? '—'}), ${placed} new placement(s).`,
        );
      }
      const graded = await grade(db);
      console.log(`Graded ${graded} newly-finalized bet(s) across ${configs.length} city(ies).`);
    } else {
      console.log('city-sim — analysis only (no writes).');
    }
    for (const cfg of configs) {
      await decisionBasis(db, cfg);
      await leaderboard(db, cfg);
    }
    console.log('');
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('city-sim crashed:', err?.message ?? err);
    process.exit(1);
  });
}
