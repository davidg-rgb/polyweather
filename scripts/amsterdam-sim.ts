/**
 * scripts/amsterdam-sim — seed + analyse the Amsterdam paper-trade simulation.
 *
 * Reconstructs the 13/14/15/16-local arms over Amsterdam's history from persisted intraday running
 * maxima + market snapshots (the SAME amsterdam_sim_* RPCs + @weather-edge/core planners the
 * amsterdam-paper-trade Edge Function uses, so a backfilled bet is byte-identical to a live one),
 * grades anything whose EHAM observation has finalized, then prints two tables:
 *
 *   A — the DECISION BASIS: per local hour over all resolved Amsterdam events, our exact-bucket hit
 *       rate, the market's ask on our predicted bucket, and the realised EV per $1 — the data behind
 *       "best time of day".
 *   B — the LEADERBOARD: each arm's record so far ($10/day, net P&L, ROI, hit rate) — who's winning.
 *
 * Idempotent (record ON CONFLICT DO NOTHING; settle only flips pending) — safe to re-run any time to
 * extend the history forward. NOT trading — the analytics-pivot deliverable (see CLAUDE.md).
 *
 * Run: pnpm tsx scripts/amsterdam-sim.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--analyze-only]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  AMSTERDAM_SIM_ARM_HOURS,
  type GradeInputRow,
  type PlaceInputs,
  planPlacements,
  planSettlements,
} from '../packages/core/src/index.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

const AMS_CITY = 'amsterdam';
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

/** Distinct Amsterdam target dates that CAN be simulated: have intraday + at least one snapshot. */
async function simulableDates(db: ScriptDb, from: string | null, to: string | null): Promise<string[]> {
  const r = await db.query<{ d: string }>(
    `select distinct me.target_date::text as d
     from market_events me
     join cities c on c.id = me.city_id
     where c.slug = $1 and me.kind = 'highest'
       and exists (select 1 from intraday_advances ia where ia.icao = 'EHAM' and ia.date_local = me.target_date)
       and exists (select 1 from market_buckets mb
                   join market_snapshots ms on ms.bucket_id = mb.id where mb.event_id = me.id)
       and ($2::date is null or me.target_date >= $2::date)
       and ($3::date is null or me.target_date <= $3::date)
     order by 1`,
    [AMS_CITY, from, to],
  );
  return r.map((x) => x.d);
}

async function place(db: ScriptDb, date: string, nowIso: string): Promise<number> {
  const r = await db.query<{ v: PlaceInputs | null }>(
    `select public.amsterdam_sim_place_inputs($1::date, $2::timestamptz) as v`,
    [date, nowIso],
  );
  const input = r[0]?.v ?? null;
  if (!input || input.arms.length === 0) return 0;
  const placements = planPlacements(input);
  if (placements.length === 0) return 0;
  // Pass the RAW array — postgres-js detects the `$1::jsonb` cast and JSON-encodes it (a
  // JSON.stringify here would double-encode into a scalar string → "cannot extract elements").
  const rec = await db.query<{ n: number }>(`select public.amsterdam_sim_record($1::jsonb) as n`, [placements]);
  return Number(rec[0]?.n ?? 0);
}

async function grade(db: ScriptDb): Promise<number> {
  // grade_inputs returns { rows: GradeInputRow[] } (wrapped, migration 0044 — see the handler note).
  const g = await db.query<{ v: { rows: GradeInputRow[] } }>(`select public.amsterdam_sim_grade_inputs() as v`);
  const pending = g[0]?.v?.rows ?? [];
  if (pending.length === 0) return 0;
  const settlements = planSettlements(pending);
  const s = await db.query<{ n: number }>(`select public.amsterdam_sim_settle($1::jsonb) as n`, [settlements]);
  return Number(s[0]?.n ?? 0);
}

/** Table A — per-hour decision basis over all resolved Amsterdam events (the "best time" evidence). */
async function decisionBasis(db: ScriptDb): Promise<void> {
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
       join cities c on c.id = me.city_id
       where c.slug = $1 and me.winning_bucket_idx is not null),
     hours as (select generate_series(11,18) h),
     base as (
       select ev.id event_id, ev.target_date, ev.winning_bucket_idx, hh.h,
         (select max(ia.max_tenths_c) from intraday_advances ia
          where ia.icao='EHAM' and ia.date_local=ev.target_date and ia.local_hour<=hh.h) runmax
       from ev cross join hours hh),
     pred as (
       select b.*, round(b.runmax)::int pred_native,
         (b.target_date::timestamp + make_interval(hours => b.h))   at time zone 'Etc/GMT-2' lockstart,
         (b.target_date::timestamp + make_interval(hours => b.h+1)) at time zone 'Etc/GMT-2' asof
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
    [AMS_CITY],
  );

  console.log('\n── A · Best time of day — PURE running-max floor baseline (all resolved Amsterdam events) ──');
  console.log('  (Baseline only: this table scores wuRound(running max), the pre-forecast predictor. The bets');
  console.log('   actually placed (Table B) use the forecast-aware lift at 13/14 — see AMSTERDAM-SIM.md.)');
  console.log('  hour  days  exact-hit   n-odds  avg-ask(pred)   EV/$1');
  for (const r of rowsA) {
    const star = (AMSTERDAM_SIM_ARM_HOURS as readonly number[]).includes(r.local_hour) ? ' ◀ arm' : '';
    console.log(
      `  ${String(r.local_hour).padStart(2)}:00  ${String(r.n_days).padStart(4)}   ` +
        `${pct(r.exact_hit).padStart(6)}     ${String(r.n_ask).padStart(4)}    ` +
        `${f2(r.avg_ask_pred, 3).padStart(6)}        ${f2(r.ev_per_dollar, 3).padStart(7)}${star}`,
    );
  }
  console.log('  (EV/$1 over the dense-odds days only — n-odds; thin until the live sim accrues n.)');
}

/** Table B — the live leaderboard (who gains the most). */
async function leaderboard(db: ScriptDb): Promise<void> {
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
     from amsterdam_paper_bets group by arm_hour order by coalesce(sum(pnl_usd),0) desc, arm_hour`,
    [],
  );

  console.log('\n── B · Leaderboard — $10/day per arm, net P&L (who gains the most) ──');
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
      from: { type: 'string' },
      to: { type: 'string' },
      'analyze-only': { type: 'boolean', default: false },
    },
  });
  const db = makeScriptDb();
  try {
    const analyzeOnly = values['analyze-only'] === true;
    if (!analyzeOnly) {
      const dates = await simulableDates(db, values.from ?? null, values.to ?? null);
      const now = new Date().toISOString();
      let placed = 0;
      for (const d of dates) placed += await place(db, d, now);
      const graded = await grade(db);
      console.log(
        `Amsterdam sim seeded: ${dates.length} simulable day(s) (${dates[0] ?? '—'} → ${dates.at(-1) ?? '—'}), ` +
          `${placed} new placement(s), ${graded} newly graded.`,
      );
    } else {
      console.log('Amsterdam sim — analysis only (no writes).');
    }
    await decisionBasis(db);
    await leaderboard(db);
    console.log('');
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('amsterdam-sim crashed:', err?.message ?? err);
    process.exit(1);
  });
}
