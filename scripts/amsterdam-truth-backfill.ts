/**
 * scripts/amsterdam-truth-backfill — backfill the decimal true daily high (KNMI) + fill floor "truth
 * accuracy" on the Amsterdam paper bets.
 *
 * The paper sim grades on the MARKET's resolution (wuRound of WU's reported integer high, bucketed) — that
 * drives the P&L and stays its own number. This script adds the cleaner forecast-skill lens (operator
 * directive 2026-06-17): the integer FLOOR of the REAL station high, taken at 0.1°C from KNMI (Schiphol,
 * station 240, var TX — free, no-auth). It:
 *
 *   1. fetches KNMI TX over the range (default: earliest EHAM obs/market day → today, Etc/GMT-2),
 *   2. upserts it into amsterdam_truth (idempotent — a KNMI revision overwrites),
 *   3. fills truth_won (= predicted_native_c == floor(decimal actual)) + signed_error_c (= nowcast basis −
 *      decimal actual) on every bet whose day now has a decimal actual (the SAME amsterdam_sim_truth_* RPCs
 *      + @weather-edge/core planTruth the amsterdam-paper-trade Edge Function uses, so a backfilled truth row
 *      is byte-identical to a live one),
 *   4. prints the per-arm market-vs-truth accuracy + decimal MAE/bias, and the coverage.
 *
 * Idempotent — safe to re-run any time to extend the truth forward (the Edge Function also refreshes the last
 * few days each tick, so this is mainly the one-time ~880-day backfill + a manual catch-up). NOT trading.
 *
 * Run: pnpm tsx scripts/amsterdam-truth-backfill.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--analyze-only]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { localDateAt, planTruth, type TruthInputRow } from '../packages/core/src/index.ts';
import { fetchJson } from '../packages/io/src/index.ts';
import { fetchKnmiTx, KNMI_TRUTH_SOURCE } from '../supabase/functions/_shared/knmi.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

const AMS_TZ = 'Etc/GMT-2';
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const f2 = (v: unknown, dp = 2): string => {
  const n = num(v);
  return n === null ? '—' : n.toFixed(dp);
};
const pct = (v: unknown): string => {
  const n = num(v);
  return n === null ? '—' : `${(n * 100).toFixed(0)}%`;
};
const signed = (v: unknown, dp = 2): string => {
  const n = num(v);
  return n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
};

/** The earliest day we want decimal truth for: min over EHAM obs + Amsterdam markets + placed bets. */
async function defaultFrom(db: ScriptDb): Promise<string> {
  const r = await db.query<{ d: string | null }>(
    `select min(d)::text as d from (
       select min(date_local) d from observations where icao = 'EHAM'
       union all select min(target_date) from amsterdam_paper_bets
       union all select min(me.target_date) from market_events me
         join cities c on c.id = me.city_id where c.slug = 'amsterdam'
     ) q`,
  );
  return r[0]?.d ?? '2024-01-01';
}

/** Fetch KNMI TX for [from, to] and upsert into amsterdam_truth. Returns {fetched, written}. */
async function ingest(db: ScriptDb, from: string, to: string): Promise<{ fetched: number; written: number }> {
  const rows = await fetchKnmiTx(fetchJson, from, to, { timeoutMs: 60_000, retries: 2 });
  if (rows.length === 0) return { fetched: 0, written: 0 };
  const payload = rows.map((r) => ({ dateLocal: r.dateLocal, txTenthsC: r.txTenthsC, source: KNMI_TRUTH_SOURCE }));
  const res = await db.query<{ n: number }>(`select public.amsterdam_truth_upsert($1::jsonb) as n`, [payload]);
  return { fetched: rows.length, written: Number(res[0]?.n ?? 0) };
}

/** Fill truth_won + signed_error on every bet whose day now has a decimal actual. Returns rows filled. */
async function fillTruth(db: ScriptDb): Promise<number> {
  const g = await db.query<{ v: TruthInputRow[] }>(`select public.amsterdam_sim_truth_inputs() as v`);
  const pending = g[0]?.v ?? [];
  if (pending.length === 0) return 0;
  const truth = planTruth(pending);
  const r = await db.query<{ n: number }>(`select public.amsterdam_sim_truth_record($1::jsonb) as n`, [truth]);
  return Number(r[0]?.n ?? 0);
}

/** Per-arm market accuracy (graded P&L truth) vs floor "truth accuracy" (vs the real decimal high). */
async function report(db: ScriptDb): Promise<void> {
  const cov = (
    await db.query<{ n_days: number; first: string | null; last: string | null; n_bets_truth: number }>(
      `select (select count(*) from amsterdam_truth) n_days,
              (select min(date_local)::text from amsterdam_truth) first,
              (select max(date_local)::text from amsterdam_truth) last,
              (select count(*) from amsterdam_paper_bets where truth_won is not null) n_bets_truth`,
    )
  )[0]!;
  console.log(
    `\nKNMI decimal truth: ${cov.n_days} day(s) (${cov.first ?? '—'} → ${cov.last ?? '—'}); ` +
      `${cov.n_bets_truth} bet(s) carry a floor-truth outcome.`,
  );

  const rows = await db.query<{
    arm_hour: number;
    n_graded: number;
    market_hit: string | null;
    n_truth: number;
    truth_hit: string | null;
    mae: string | null;
    bias: string | null;
  }>(
    `select arm_hour,
       count(*) filter (where status <> 'pending') n_graded,
       round(avg((won)::int) filter (where status <> 'pending'), 3)::text market_hit,
       count(*) filter (where truth_won is not null) n_truth,
       round(avg((truth_won)::int) filter (where truth_won is not null), 3)::text truth_hit,
       round(avg(abs(signed_error_c)) filter (where signed_error_c is not null), 3)::text mae,
       round(avg(signed_error_c) filter (where signed_error_c is not null), 3)::text bias
     from amsterdam_paper_bets group by arm_hour order by arm_hour`,
  );

  console.log('\n── Floor "truth accuracy" vs market accuracy — per arm ──');
  console.log('  (market hit = predicted bucket == winning bucket on the WU high; drives P&L.');
  console.log('   truth hit  = predicted whole °C == floor(real KNMI high); MAE/bias = nowcast basis − real high.)');
  console.log('  arm    graded  market-hit  truth-n  truth-hit    MAE     bias');
  if (rows.length === 0) {
    console.log('  (no bets recorded yet — run scripts/amsterdam-sim.ts first)');
    return;
  }
  for (const r of rows) {
    console.log(
      `  ${String(r.arm_hour)}:00  ${String(r.n_graded).padStart(6)}  ${pct(r.market_hit).padStart(8)}    ` +
        `${String(r.n_truth).padStart(5)}   ${pct(r.truth_hit).padStart(7)}   ${f2(r.mae, 3).padStart(5)}   ${signed(r.bias, 3).padStart(6)}`,
    );
  }
  console.log('  (MAE/bias in °C at 0.1° resolution. Positive bias = the nowcast ran hot vs the real high.)\n');
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
    if (values['analyze-only'] !== true) {
      const from = values.from ?? (await defaultFrom(db));
      const to = values.to ?? localDateAt(AMS_TZ, new Date());
      console.log(`Backfilling KNMI decimal truth for EHAM/Schiphol (station 240) ${from} → ${to} …`);
      const { fetched, written } = await ingest(db, from, to);
      const filled = await fillTruth(db);
      console.log(
        `Ingested ${fetched} KNMI day(s) (${written} new/changed); filled floor-truth on ${filled} bet(s).`,
      );
    } else {
      console.log('Amsterdam truth — analysis only (no fetch, no writes).');
    }
    await report(db);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('amsterdam-truth-backfill crashed:', err?.message ?? err);
    process.exit(1);
  });
}
