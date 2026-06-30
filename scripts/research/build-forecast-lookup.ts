/**
 * scripts/research/build-forecast-lookup — build the per-event forecast lookup that CONNECTS our weather
 * predictions to the Polymarket odds archive: for every archived event we can map to a tracked market, the
 * predicted Tmax at **2 days prior (lead 2), 1 day prior (lead 1), and day-of (lead 0)**.
 *
 * Output: out/forecast-by-event.csv — keyed by `event_id` (the Gamma poly_event_id, the archive's join key), so
 * `enrich-market-history.ts` can broadcast these per-event columns onto every price-point row of the odds file.
 *
 * THE PREDICTED TEMPERATURE. Two views per lead, both in the market's NATIVE unit (°C / °F — directly comparable
 * to the bucket labels):
 *   - `pred_c_lL`  = the CALIBRATED house blend — Σ weight·(tmax − bias) / Σ weight over the models present at
 *     that lead (model_stats latest version), i.e. our accuracy prediction (the production "blend" center).
 *   - `pred_raw_lL`= the RAW multi-model ensemble mean (no debias) — the proxy for "what the consumer apps /
 *     Wunderground-Google show", the convergence Schelling point.
 *   - `pred_bucket_lL` = the market bucket index the CALIBRATED prediction lands in (floor to the °bin), so a row
 *     can be filtered to "the odds on the predicted bucket".
 * (The crowd-vs-accuracy split is the same one CONVERGENCE-TUNING Finding 2 / the 2026-06-29 seed split surface.)
 *
 * Coverage: only events mapped to a DB `market_events` row WITH `forecast_snapshots` (≥ 2026-04-01) get a
 * forecast — ~2 134 of the 6 275 archived events; older/untracked events get blanks. Reported at the end.
 *
 * Read-only. Run: pnpm tsx scripts/research/build-forecast-lookup.ts   →  out/forecast-by-event.csv
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'build-forecast-lookup';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const OUT_PATH = join(OUT_DIR, 'forecast-by-event.csv');

// ── pure helpers (tested) ────────────────────────────────────────────────────────────────────────────
const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));

/** Convert °C → the market's native unit (°F for a Fahrenheit city, else °C). */
export function toNative(tmaxC: number | null, unit: string | null): number | null {
  if (!fin(tmaxC)) return null;
  return String(unit ?? '').trim().toUpperCase().startsWith('F') ? tmaxC * 9 / 5 + 32 : tmaxC;
}

/** One market bucket's integer-native span (open tails: low=null lower tail, high=null upper tail). */
export interface BucketSpan {
  idx: number;
  low: number | null;
  high: number | null;
}

/**
 * The bucket index a native prediction lands in — floor the prediction to the °bin (the market resolves on the
 * floored integer high) and find the span containing it (open tails clamp the ends). null if no bucket matches.
 */
export function predictedBucket(predNative: number | null, buckets: BucketSpan[]): number | null {
  if (!fin(predNative) || !Array.isArray(buckets) || buckets.length === 0) return null;
  const k = Math.floor(predNative);
  for (const b of buckets) {
    const okLow = b.low == null || k >= b.low;
    const okHigh = b.high == null || k <= b.high;
    if (okLow && okHigh) return b.idx;
  }
  return null;
}

/** Round to 2 dp or '' for null (the CSV cell). */
const cell = (v: number | null): string => (fin(v) ? (Math.round(v * 100) / 100).toString() : '');

export interface EventForecast {
  eventId: string;
  city: string;
  weatherDate: string;
  unit: string;
  predC: Record<number, number | null>; // lead → calibrated native
  predRaw: Record<number, number | null>; // lead → raw native
  nModels: Record<number, number>;
}

/** Assemble the wide CSV row for one event (the column order the enrich step expects). */
export function forecastRow(ev: EventForecast, buckets: BucketSpan[]): string {
  const bkt = (lead: number): string => {
    const b = predictedBucket(ev.predC[lead] ?? null, buckets);
    return b == null ? '' : String(b);
  };
  return [
    ev.eventId, ev.city, ev.weatherDate, ev.unit,
    cell(ev.predC[2] ?? null), cell(ev.predC[1] ?? null), cell(ev.predC[0] ?? null),
    cell(ev.predRaw[2] ?? null), cell(ev.predRaw[1] ?? null), cell(ev.predRaw[0] ?? null),
    bkt(2), bkt(1), bkt(0),
  ].join(',');
}

export const FORECAST_HEADER =
  'event_id,fc_city,weather_date,unit,pred_c_l2,pred_c_l1,pred_c_l0,pred_raw_l2,pred_raw_l1,pred_raw_l0,pred_bucket_l2,pred_bucket_l1,pred_bucket_l0';

// ── DB I/O ────────────────────────────────────────────────────────────────────────────────────────────
interface BlendRow {
  event_id: string; city: string; unit: string; weather_date: string;
  lead_days: number; tmax_c_blend: number | null; tmax_c_raw: number | null; n_models: number;
}

async function loadBlend(db: ScriptDb): Promise<BlendRow[]> {
  return db.query<BlendRow>(
    `with latest as (select max(stats_version) v from model_stats),
     ms as (select icao, model, lead_days, avg(bias_c) bias, avg(weight) weight
            from model_stats, latest where stats_version=latest.v group by icao, model, lead_days),
     fc as (select fs.icao, fs.target_date, fs.model, fs.lead_days, avg(fs.tmax_c) tmax
            from forecast_snapshots fs
            where coalesce(fs.seeded,false)=false and fs.lead_days in (0,1,2)
            group by fs.icao, fs.target_date, fs.model, fs.lead_days),
     blend as (select fc.icao, fc.target_date, fc.lead_days,
                      sum(ms.weight*(fc.tmax-ms.bias))/nullif(sum(ms.weight),0) tmax_c_blend,
                      avg(fc.tmax) tmax_c_raw, count(*) n_models
               from fc join ms on ms.icao=fc.icao and ms.model=fc.model and ms.lead_days=fc.lead_days
               group by fc.icao, fc.target_date, fc.lead_days)
     select me.poly_event_id as event_id, c.slug as city, c.unit as unit, me.target_date::text as weather_date,
            b.lead_days::int as lead_days, b.tmax_c_blend::float8 as tmax_c_blend,
            b.tmax_c_raw::float8 as tmax_c_raw, b.n_models::int as n_models
       from blend b
       join market_events me on me.icao_at_creation = b.icao and me.target_date = b.target_date
       join cities c on c.id = me.city_id
      where me.poly_event_id is not null`,
  );
}

async function loadBuckets(db: ScriptDb): Promise<Map<string, BucketSpan[]>> {
  const rows = await db.query<{ event_id: string; idx: number; low: number | null; high: number | null }>(
    `select me.poly_event_id as event_id, mb.bucket_idx::int as idx,
            mb.low_native::int as low, mb.high_native::int as high
       from market_buckets mb join market_events me on me.id = mb.event_id
      where me.poly_event_id is not null`,
  );
  const m = new Map<string, BucketSpan[]>();
  for (const r of rows) {
    const arr = m.get(r.event_id) ?? [];
    arr.push({ idx: r.idx, low: r.low, high: r.high });
    m.set(r.event_id, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.idx - b.idx);
  return m;
}

/** Pivot the per-(event,lead) blend rows into one EventForecast per event (native units). Pure. */
export function pivotForecasts(rows: BlendRow[]): Map<string, EventForecast> {
  const byEvent = new Map<string, EventForecast>();
  for (const r of rows) {
    let ev = byEvent.get(r.event_id);
    if (!ev) {
      ev = { eventId: r.event_id, city: r.city, weatherDate: r.weather_date, unit: r.unit, predC: {}, predRaw: {}, nModels: {} };
      byEvent.set(r.event_id, ev);
    }
    ev.predC[r.lead_days] = toNative(r.tmax_c_blend, r.unit);
    ev.predRaw[r.lead_days] = toNative(r.tmax_c_raw, r.unit);
    ev.nModels[r.lead_days] = r.n_models;
  }
  return byEvent;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  mkdirSync(OUT_DIR, { recursive: true });
  const db = makeScriptDb();
  try {
    process.stderr.write(`${SCRIPT} · loading blend (leads 0/1/2) ⋈ buckets — read-only\n`);
    const [blend, buckets] = await Promise.all([loadBlend(db), loadBuckets(db)]);
    const byEvent = pivotForecasts(blend);
    const lines = [FORECAST_HEADER];
    let withAll3 = 0;
    for (const ev of byEvent.values()) {
      lines.push(forecastRow(ev, buckets.get(ev.eventId) ?? []));
      if (fin(ev.predC[0]) && fin(ev.predC[1]) && fin(ev.predC[2])) withAll3++;
    }
    writeFileSync(OUT_PATH, lines.join('\n') + '\n');
    process.stderr.write(
      `  ${byEvent.size} events with a forecast (${withAll3} have all of lead 2/1/0) → ${OUT_PATH}\n` +
      `  next: pnpm tsx scripts/research/enrich-market-history.ts  (broadcasts these onto the odds file per row)\n`,
    );
  } finally {
    await db.end();
  }
}
