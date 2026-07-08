/**
 * fahrenheit-source-test.ts — WS-A C3a: does per-city SOURCE-SELECTION beat raw Google on US °F markets?
 *
 * Operator thesis (2026-07-08): the Google-bucket play excludes °F because raw Google is cold-biased there
 * (GOOGLE-FAHRENHEIT-INVESTIGATION.md: 14% bucket hit, +1.05 buckets too cold, ZERO take-profits). Instead of
 * bidding raw Google, bid on GOOGLE + the source that best MATCHES that city's resolved high — the same taker
 * rules as the °C markets, run as a SEPARATE °F cohort. This script measures the FORECAST-MATCH half (the user's
 * literal "highest forecast match"): over the full resolved °F universe, how well does each source's forecast
 * center land on the market's own winning bucket, and does per-city source-selection (frozen TRAIN→OOS, via
 * core/sim/source-selector) beat raw Google AND the calibrated blend out-of-sample?
 *
 * The bidding metric is the °F LADDER bucket match (googleBucketIdx vs winning_bucket_idx) — NOT °C MAE — because
 * that is what a bid resolves on. The P&L half (does a better forecast-match translate to bankable taker edge)
 * is the follow-on C3b (needs the book series off the offline archive).
 *
 * Candidate sources: google / weatherapi / openweathermap (source_forecasts, °C) + blend = the calibrated house
 * champion (bucket_probabilities.mu_native for source='house_gaussian', native °F → °C here). Lead 1 (day-before,
 * the accuracy + bidding convention). Reads persistent tables only (market_events / market_buckets /
 * source_forecasts / bucket_probabilities) — NOT the pruned opening_captures — so it scores the FULL °F universe.
 *
 * READ-ONLY (DATABASE_URL, same path as the other google-* research). Run:
 *   pnpm tsx scripts/research/fahrenheit-source-test.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import {
  scoreSources,
  selectSourcesPerCity,
  selectionMap,
  summarizeSelections,
  type SelectorCfg,
  type SourceSelEvent,
} from '../../packages/core/src/sim/source-selector.ts';
import { googleBucketIdx } from '../../packages/core/src/sim/google-bucket-replay.ts';
import type { OpeningBucket } from '../../packages/core/src/sim/opening-convergence.ts';

const LEAD = 1;
const SOURCES = ['google', 'weatherapi', 'openweathermap', 'blend'] as const;
/** PRE-REGISTERED selector config for the °F reality (thin per-city n): relaxed vs the module defaults, and
 *  explicitly EXPLORATORY — the point is the frozen instrument + the pooled read; per-city overrides need more
 *  forward days. metric within1 (the stable ranker on a short sample). */
const SEL_CFG: SelectorCfg = {
  candidates: [...SOURCES],
  baseline: 'google',
  fallback: 'blend',
  metric: 'within1',
  minTrainN: 4,
  minTestN: 3,
  marginPp: 0.1,
};

interface Row {
  event_id: string;
  icao: string;
  target_date: string;
  winning_bucket_idx: number;
  ladder: { idx: number; label: string }[] | null;
  google_c: string | number | null;
  weatherapi_c: string | number | null;
  openweathermap_c: string | number | null;
  blend_c: string | number | null;
}

const num = (x: string | number | null | undefined): number | null =>
  x == null ? null : Number.isFinite(Number(x)) ? Number(x) : null;

const mkBucket = (idx: number, label: string): OpeningBucket => ({
  idx,
  label,
  loF: null,
  hiF: null,
  mid: 0,
  bestAsk: 0,
  execAsk: 0,
  depthUsd: 0,
  bestBid: 0,
  sellbackUsd: 0,
  execBid: 0,
  sellbackDepthUsd: 0,
  houseProb: null,
  tokenYes: '',
  tokenNo: '',
  conditionId: '',
});

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0).padStart(3)}% (${n}/${d})` : '  n/a');

const SQL = `
with fev as (
  select me.id, me.icao_at_creation icao, me.target_date, me.winning_bucket_idx
  from market_events me
  where me.kind='highest' and me.unit='F' and me.winning_bucket_idx is not null
)
select f.id as event_id, f.icao, f.target_date::text as target_date, f.winning_bucket_idx,
  (select jsonb_agg(jsonb_build_object('idx', mb.bucket_idx, 'label', mb.label) order by mb.bucket_idx)
     from market_buckets mb where mb.event_id = f.id) as ladder,
  (select sf.tmax_c from source_forecasts sf where sf.icao=f.icao and sf.target_date=f.target_date
     and sf.source='google' and sf.lead_days=$1 order by sf.captured_at desc limit 1) as google_c,
  (select sf.tmax_c from source_forecasts sf where sf.icao=f.icao and sf.target_date=f.target_date
     and sf.source='weatherapi' and sf.lead_days=$1 order by sf.captured_at desc limit 1) as weatherapi_c,
  (select sf.tmax_c from source_forecasts sf where sf.icao=f.icao and sf.target_date=f.target_date
     and sf.source='openweathermap' and sf.lead_days=$1 order by sf.captured_at desc limit 1) as openweathermap_c,
  (select (bp.mu_native-32)*5.0/9.0 from bucket_probabilities bp where bp.event_id=f.id
     and bp.source='house_gaussian' and bp.lead_days=$1 and bp.mu_native is not null
     order by bp.made_at desc limit 1) as blend_c
from fev f
order by f.target_date, f.icao`;

/** within-1 bucket-hit of a single source over events (mirrors the selector's metric, for the OOS aggregate). */
function within1Rate(events: readonly SourceSelEvent[], source: string): { hit: number; n: number } {
  let hit = 0;
  let n = 0;
  for (const e of events) {
    if (e.winningBucketIdx == null) continue;
    const c = e.forecastC[source];
    if (c == null) continue;
    const idx = googleBucketIdx(e.ladder, c, e.unit);
    if (idx == null) continue;
    n += 1;
    if (Math.abs(idx - e.winningBucketIdx) <= 1) hit += 1;
  }
  return { hit, n };
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<Row>(SQL, [LEAD]);
    type Ev = SourceSelEvent & { target_date: string };
    const events: Ev[] = rows
      .filter((r) => Array.isArray(r.ladder) && r.ladder.length > 0)
      .map((r) => ({
        eventId: r.event_id,
        city: r.icao,
        unit: 'F' as const,
        target_date: r.target_date,
        ladder: r.ladder!.map((b) => mkBucket(Number(b.idx), String(b.label))),
        winningBucketIdx: r.winning_bucket_idx,
        forecastC: {
          google: num(r.google_c),
          weatherapi: num(r.weatherapi_c),
          openweathermap: num(r.openweathermap_c),
          blend: num(r.blend_c),
        },
      }));

    console.log(`\nFAHRENHEIT SOURCE-SELECTION TEST (WS-A C3a) — forecast-match on the °F ladder, lead ${LEAD}`);
    console.log(`${events.length} resolved °F events with a ladder, ${new Set(events.map((e) => e.city)).size} cities, ${new Set(events.map((e) => e.target_date ?? '')).size} — pooled per-source hit-rate:\n`);

    // 1 ── pooled per-source bucket-match (each source over its own coverage) ────────────────────────────
    const pooled = scoreSources(events, [...SOURCES]);
    console.log(`  source            n    exact         within-1       mean|miss|`);
    for (const s of SOURCES) {
      const sc = pooled[s]!;
      console.log(
        `  ${s.padEnd(16)} ${String(sc.n).padStart(3)}  ${pct(sc.exact, sc.n)}   ${pct(sc.within1, sc.n)}   ${Number.isFinite(sc.meanMiss) ? sc.meanMiss.toFixed(2) : ' n/a'}`,
      );
    }

    // 2 ── apples-to-apples: only events where ALL FOUR sources are present ──────────────────────────────
    const common = events.filter((e) => SOURCES.every((s) => e.forecastC[s] != null));
    const pooledC = scoreSources(common, [...SOURCES]);
    console.log(`\n  APPLES-TO-APPLES (${common.length} events with all 4 sources present):`);
    for (const s of SOURCES) {
      const sc = pooledC[s]!;
      console.log(`  ${s.padEnd(16)} within-1 ${pct(sc.within1, sc.n)}   exact ${pct(sc.exact, sc.n)}   mean|miss| ${Number.isFinite(sc.meanMiss) ? sc.meanMiss.toFixed(2) : 'n/a'}`);
    }

    // 3 ── frozen per-city selection: TRAIN (earlier dates) → OOS validate on TEST (later dates) ──────────
    const dates = [...new Set(events.map((e) => e.target_date))].sort();
    const cut = dates[Math.max(0, Math.ceil(dates.length * 0.6) - 1)] ?? dates[dates.length - 1]!;
    const train = events.filter((e) => e.target_date <= cut);
    const test = events.filter((e) => e.target_date > cut);
    console.log(`\n  PER-CITY SELECTION (frozen; pre-registered EXPLORATORY cfg — thin °F n):`);
    console.log(`  TRAIN ≤ ${cut} (${train.length} ev) → TEST > ${cut} (${test.length} ev); metric ${SEL_CFG.metric}, minTrain ${SEL_CFG.minTrainN}/minTest ${SEL_CFG.minTestN}/margin ${(SEL_CFG.marginPp * 100).toFixed(0)}pp\n`);
    const sels = selectSourcesPerCity(train, test, SEL_CFG);
    for (const s of sels) {
      const tag = s.reason === 'selected' ? `→ ${s.chosen} ✓` : `→ blend (${s.reason.replace('fallback-', '')})`;
      console.log(`    ${s.city.padEnd(6)} train winner ${(s.trainWinner ?? '—').padEnd(14)} ${tag}`);
    }
    const sum = summarizeSelections(sels);
    console.log(`\n  ${sum.nSelected}/${sum.nCities} cities got a source override; ${sum.nFallback} kept the blend.`);
    if (sum.selectedCities.length) console.log(`  overrides: ${sum.selectedCities.map((c) => `${c.city}=${c.source}`).join(', ')}`);

    // 4 ── the decisive OOS aggregate: selected-source vs raw-google vs blend on the TEST set ─────────────
    const map = selectionMap(sels);
    const selEvents = test.map((e) => ({ ...e, forecastC: { sel: e.forecastC[map.get(e.city) ?? 'blend'] ?? null } }));
    const selHit = within1Rate(selEvents as SourceSelEvent[], 'sel');
    const gHit = within1Rate(test, 'google');
    const bHit = within1Rate(test, 'blend');
    console.log(`\n  === OOS (TEST) within-1 bucket-hit — the decision ===`);
    console.log(`    raw google      ${pct(gHit.hit, gHit.n)}`);
    console.log(`    calibrated blend ${pct(bHit.hit, bHit.n)}`);
    console.log(`    SOURCE-SELECTED  ${pct(selHit.hit, selHit.n)}   (per-city chosen; == blend where no override cleared)`);
    console.log('');
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
