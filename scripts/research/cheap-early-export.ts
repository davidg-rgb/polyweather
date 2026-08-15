/**
 * cheap-early-export — the READ-ONLY DB export that feeds `cheap-early-improve.py` (the cheap-early
 * improvement-lever sweep over the real order book).
 *
 * The sweep grades the `opening-captures-archive` (the ONLY real bid/ask/depth we have) against DB truth.
 * Five artifacts, all under scripts/research/out/, all pure SELECT:
 *
 *   1. cheap-early-winners.json      "<city>|<target_date>" → { winner_temp, unit, ... }  (grading truth)
 *   2. cheap-early-ladders.json      event_id → { city, target_date, unit, buckets:[{idx,label,low,high}] }
 *                                    — the bucket_idx→label map that turns a `bucket_probabilities.probs`
 *                                      ARRAY POSITION into a TEMPERATURE (see the alignment note below).
 *   3. cheap-early-dists.json        bucket_probabilities (house_ensemble/house_gaussian, nowcast=false,
 *                                    seeded=false) = our BIAS-CORRECTED accuracy forecast, with made_at so
 *                                    the sweep can pick the latest row ≤ capture time (no look-ahead).
 *   4. cheap-early-city-grades.json  city_prediction_grades — the as-of rolling city-skill filter.
 *   5. cheap-early-live-fills.json   the real live buy-table fills since 2026-08-09 — the replica
 *                                    reconciliation set (if the replica can't reproduce these, nothing else counts).
 *
 * THE probs[i] → TEMPERATURE ALIGNMENT RULE (verified in code, not assumed):
 *   `buildDistributionForEvent` (supabase/functions/_shared/distributions.ts) builds `probs` over
 *   `ladder = inp.buckets.map(...)`, and `inp.buckets` comes from `get_build_inputs`
 *   (0033_get_build_inputs_ra3_guard.sql:39) which aggregates market_buckets **`order by b.bucket_idx`**.
 *   market_buckets.bucket_idx is contiguous 0..n−1 for every event (asserted below), therefore
 *   **probs[i] ↔ market_buckets.bucket_idx = i**. The sweep never uses that index for anything but the
 *   label lookup — it then parses the TEMPERATURE out of the label and joins on temperature, so the
 *   raw-gamma-order archive index (traps.md #7) can never contaminate the join.
 *
 * Read-only: SELECT only, no trades, no credentials printed. Writes only scripts/research/out/.
 * Run:  pnpm tsx scripts/research/cheap-early-export.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'cheap-early-export';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');

/** The sweep's horizon: the opening-captures archive starts ~2026-07-05, so 07-01 is a safe floor. */
const SINCE = '2026-07-01';
/** The live buy-table lane was re-pointed at the cheap-early cell on 2026-08-09 (CHEAP-EARLY-ENTRY.md §7). */
const LIVE_SINCE = '2026-08-09';

/** First integer in the label — "31°C"→31, "88-89°F"→88, "75°F or below"→75, "-3°C"→−3. */
export function parseTemp(label: string | null | undefined): number | null {
  const m = /-?\d+/.exec(String(label ?? ''));
  return m ? Number(m[0]) : null;
}

const day = (d: unknown): string =>
  typeof d === 'string' ? d.slice(0, 10) : new Date(d as string).toISOString().slice(0, 10);

const num = (v: unknown): number | null => (v == null ? null : Number(v));

interface WinnerRow {
  city: string; event_id: string; target_date: string; unit: string;
  resolved_at: string | null; winner_idx: number; winner_label: string | null;
}
interface LadderRow { event_id: string; bucket_idx: number; label: string | null; low_native: number | null; high_native: number | null; city: string; target_date: string; unit: string }
interface DistRow { event_id: string; source: string; made_at: string; lead_days: number; probs: unknown[]; mu_native: unknown; sigma_native: unknown }
interface GradeRow { event_id: string; city: string; target_date: string; hit: boolean | null; mismatch: boolean | null }
interface FillRow {
  created_at: string; avg_price: unknown; price: unknown; size_matched: unknown; order_id: string | null;
  event_id: string; bucket_idx: number; label: string | null; city: string; target_date: string; unit: string;
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  mkdirSync(OUT, { recursive: true });
  const write = (name: string, data: unknown, note: string) => {
    writeFileSync(join(OUT, name), JSON.stringify(data));
    console.log(`  wrote out/${name} — ${note}`);
  };

  try {
    // --- 0. the alignment ASSERTION the probs→temp rule rests on -------------------------------
    const [gap] = await db.query<{ bad: number }>(
      `select count(*)::int as bad from (
         select event_id, count(*)::int c, min(bucket_idx) mn, max(bucket_idx) mx
         from market_buckets group by 1
       ) t where t.mn <> 0 or t.mx <> t.c - 1`,
    );
    if ((gap?.bad ?? 1) !== 0) {
      throw new Error(
        `market_buckets.bucket_idx is NOT contiguous 0..n-1 for ${gap?.bad} events — the probs[i]↔bucket_idx=i ` +
        `alignment rule does not hold; STOP and re-derive the mapping before trusting any accuracy pick.`,
      );
    }
    console.log('  ✓ bucket_idx contiguous 0..n-1 on every event → probs[i] ↔ bucket_idx = i');

    // --- 1. winners (grading truth) -------------------------------------------------------------
    const winners = await db.query<WinnerRow>(
      `select c.slug as city, me.id as event_id, to_char(me.target_date,'YYYY-MM-DD') as target_date,
              me.unit, me.resolved_at,
              coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) as winner_idx,
              wb.label as winner_label
         from market_events me
         join cities c on c.id = me.city_id
         left join market_buckets wb
           on wb.event_id = me.id
          and wb.bucket_idx = coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx)
        where me.target_date >= $1
          and coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is not null
          and coalesce(me.grading_mismatch, false) = false
        order by me.target_date, c.slug`,
      [SINCE],
    );
    const winOut: Record<string, unknown> = {};
    let noTemp = 0;
    for (const w of winners) {
      const t = parseTemp(w.winner_label);
      if (t === null) { noTemp++; continue; }
      winOut[`${w.city}|${day(w.target_date)}`] = {
        winner_temp: t, unit: w.unit, event_id: w.event_id,
        winner_idx: w.winner_idx, winner_label: w.winner_label,
        resolved_at: w.resolved_at ?? null,
      };
    }
    write('cheap-early-winners.json', winOut,
      `${Object.keys(winOut).length} graded city-days (${noTemp} dropped: unparseable winner label)`);

    // --- 2. ladders (bucket_idx → label → temperature) -------------------------------------------
    const ladders = await db.query<LadderRow>(
      `select b.event_id, b.bucket_idx, b.label, b.low_native, b.high_native,
              c.slug as city, to_char(me.target_date,'YYYY-MM-DD') as target_date, me.unit
         from market_buckets b
         join market_events me on me.id = b.event_id
         join cities c on c.id = me.city_id
        where me.target_date >= $1
        order by b.event_id, b.bucket_idx`,
      [SINCE],
    );
    const ladderOut: Record<string, unknown> = {};
    for (const r of ladders) {
      const e = (ladderOut[r.event_id] ??= {
        city: r.city, target_date: day(r.target_date), unit: r.unit, buckets: [] as unknown[],
      }) as { buckets: unknown[] };
      e.buckets.push({
        idx: r.bucket_idx, label: r.label, temp: parseTemp(r.label),
        low: num(r.low_native), high: num(r.high_native),
      });
    }
    write('cheap-early-ladders.json', ladderOut, `${Object.keys(ladderOut).length} event ladders`);

    // --- 3. the bias-corrected accuracy distributions --------------------------------------------
    // seeded=false ⇒ the PRODUCTION build (biasCorrect defaults true — the calibrated, accuracy-maximising
    // centre). seeded=true rows are the opening-convergence seed built with biasCorrect=FALSE (the RAW
    // consensus), i.e. exactly the `houseProb` already in the capture archive — excluded here so the
    // `accuracy` pick source is genuinely a DIFFERENT forecast from the `raw` one.
    const dists = await db.query<DistRow>(
      `select bp.event_id, bp.source, bp.made_at, bp.lead_days, bp.probs, bp.mu_native, bp.sigma_native
         from bucket_probabilities bp
         join market_events me on me.id = bp.event_id
        where bp.source in ('house_ensemble','house_gaussian')
          and bp.nowcast = false
          and coalesce(bp.seeded, false) = false
          and me.target_date >= $1
        order by bp.event_id, bp.made_at`,
      [SINCE],
    );
    write('cheap-early-dists.json', dists.map((d) => ({
      event_id: d.event_id, source: d.source, made_at: d.made_at, lead_days: d.lead_days,
      probs: (d.probs ?? []).map(Number), mu_native: num(d.mu_native), sigma_native: num(d.sigma_native),
    })), `${dists.length} DB dist rows (older rows come from out/bucket_probabilities-archive/)`);

    // --- 4. city_prediction_grades (the as-of city-skill filter) ----------------------------------
    const grades = await db.query<GradeRow>(
      `select event_id, city, to_char(target_date,'YYYY-MM-DD') as target_date, hit, mismatch
         from city_prediction_grades
        order by target_date, city`,
    );
    write('cheap-early-city-grades.json', grades.map((g) => ({
      event_id: g.event_id, city: g.city, target_date: day(g.target_date),
      hit: g.hit === true, mismatch: g.mismatch === true,
    })), `${grades.length} graded city-days`);

    // --- 5. the real live fills (the replica reconciliation set) ----------------------------------
    // token_yes is the YES token the buy-table lane takes; that is the join back to the bucket it bought.
    const fills = await db.query<FillRow>(
      `select o.created_at, o.avg_price, o.price, o.size_matched, o.order_id,
              b.event_id, b.bucket_idx, b.label,
              c.slug as city, to_char(me.target_date,'YYYY-MM-DD') as target_date, me.unit
         from live_orders o
         join market_buckets b on b.token_yes = o.token_id
         join market_events me on me.id = b.event_id
         join cities c on c.id = me.city_id
        where o.mode = 'live' and o.strategy = 'buy-table' and o.purpose = 'entry'
          and coalesce(o.size_matched, 0) > 0
          and o.created_at >= $1
        order by o.created_at`,
      [LIVE_SINCE],
    );
    write('cheap-early-live-fills.json', fills.map((f) => ({
      created_at: f.created_at, city: f.city, target_date: day(f.target_date), unit: f.unit,
      event_id: f.event_id, bucket_idx: f.bucket_idx, label: f.label, temp: parseTemp(f.label),
      avg_price: num(f.avg_price), limit_price: num(f.price), size_matched: num(f.size_matched),
      order_id: f.order_id,
    })), `${fills.length} live buy-table entry fills since ${LIVE_SINCE}`);

    console.log(`\ncheap-early-export OK — winners ${Object.keys(winOut).length} · ladders ${Object.keys(ladderOut).length} · ` +
      `dists ${dists.length} · grades ${grades.length} · live fills ${fills.length}`);
  } finally {
    await db.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
