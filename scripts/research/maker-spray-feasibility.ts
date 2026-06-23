/**
 * scripts/research/maker-spray-feasibility — the maker-spray paper simulator (the IMPURE spine).
 * MAKER-SPRAY-SIM.md §9 frozen kill-criterion · the 4th and LAST badatmath replication angle
 * (WALLET-RECON-HANDOFF.md §12). The script twin of `core/sim/maker-spray.ts`.
 *
 * THE QUESTION (why this is not a re-run of KILL-GATE 2). KILL-GATE 2 (db1) measured
 * `calibratedP − ask` — a TAKER crossing the spread on OUR EMOS forecast — and found the day-before
 * market efficient. Copy-trade (§11) measured mirroring badatmath's fills as a follower-taker and
 * found that uneconomic too. The one variable still unmeasured: **does resting a MAKER bid BELOW the
 * ask on our forecast clear zero EV?** badatmath does not pay the ask — it RESTS bids ~7pp below it
 * and is filled as a maker. This script walks our live EMOS forecast forward day-by-day, sprays
 * resting maker bids on the cheap (<0.25) buckets of each resolved bucket market, and simulates which
 * bids FILL from the real `market_snapshots` book evolution (the fill model embeds adverse selection
 * for free). The pure analytics live in `core/sim/maker-spray.ts`; this spine loads + assembles + runs.
 *
 * POSTURE: analytics study, NOT a trading green-light. Ships nothing to prod, no migration, no live
 * rail, never imports `packages/trading`. Read-only. Pre-registered kill-criterion (WO-5 discipline).
 *
 * TWO FORK LINEAGES, NEITHER edits the shared harness (ADR-02):
 *   (a) the EMOS spine — `EmosStation` + the forecast/obs/event/ladder/config loaders + the
 *       walk-forward fold + the `forkRmse` accumulator — is FORKED VERBATIM from
 *       `db1-daybefore-efficiency.ts` (these are inline in `runDb1`, not exported → copy, don't import);
 *   (b) the snapshot-series loader is FORKED from `copytrade-feasibility.ts`'s `loadSnapshots`,
 *       widened to the tz-correct C-2 window and carrying `last_trade` (the script-local MakerSnapshot).
 *   (c) `loadBucketSeries` (the wider tz-correct window) is the only genuinely NEW query.
 *
 * THE BINDING CORRECTNESS FIX (ADR-05). `market_events.target_date` is STATION-LOCAL, so db1's
 * `(target_date±1)::timestamptz` is wrong by the city's UTC offset (multi-hour, systematic per city).
 * db1 only takes the LAST ask (a point read where hours round away); the maker model scans the WHOLE
 * post-entry series, so the skew is material. This script joins `cities.tz` and computes the precise
 * resolution/entry instants in TS via `localDayWindow(tz, target_date)` (pure, DST-correct); the SQL
 * loads a per-city-correct UTC SUPERSET window via `AT TIME ZONE c.tz`.
 *
 * Run: pnpm tsx scripts/research/maker-spray-feasibility.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--leads 1,2] [--stations EHAM,EGLC] [--rest-at bid|bid+tick|ask-offset] [--ask-offset 0.07]
 *        [--fill-model ask_touch|last_trade] [--entry-lead-h 24[,43]] [--lookback-days 3]
 *        [--cheap-max 0.25] [--maker-rebate 0] [--margin 0.02] [--mc-iters 1000] [--cross-val] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  computeModelWeights,
  correctPoint,
  fitSigma,
  fToC,
  gaussianBucketProbs,
  localDayWindow,
  parseConfigRows,
  toNative,
  updateBias,
  type AppConfig,
  type BucketDef,
} from '../../packages/core/src/index.ts';
import {
  type CrossValResult,
  type FillModel,
  type FillSnapshot,
  type MakerSprayReport,
  type MakerSprayVerdict,
  type RestRule,
  type RestingBid,
  crossValidateFillModel,
  makerSprayVerdict,
  simulateSpray,
} from '../../packages/core/src/sim/maker-spray.ts';
import type { SimLadderBucket } from '../../packages/core/src/sim/amsterdam.ts';
import {
  SHARP_WALLET_ADDRESS,
  type WalletActivity,
} from '../../packages/io/src/polymarket-wallet.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { crawlActivity } from '../lib/polymarket-crawl.ts';
// FORK the db1 EMOS spine via its EXPORTED public entrypoint — runDb1 — for the fork-equality gate
// ONLY (ADR-02: copy don't import the INLINE loaders; calling the public entrypoint is allowed, Pass-2).
import { runDb1, type Db1Args, type Db1Deps } from './db1-daybefore-efficiency.ts';

export const SCRIPT = 'maker-spray-feasibility';

// =====================================================================================
// SCRIPT-LOCAL TYPE (Pass-1 C1): the imported FillSnapshot's lastTrade is optional; the
// loaded MakerSnapshot carries it explicitly as number|null (the C-2 SQL always selects it).
// =====================================================================================

/** A book snapshot row carrying last_trade — the script-local superset of copy-trade's BucketSnapshot. */
export interface MakerSnapshot extends FillSnapshot {
  capturedAt: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  lastTrade: number | null;
}

// =====================================================================================
// FORKED EMOS SPINE (verbatim from db1-daybefore-efficiency.ts — the shared harness is NOT edited)
// =====================================================================================

interface ModelWindow {
  bias: number | null;
  fs: number[]; // trailing forecasts (°C), capped at sigmaWindowDays
  os: number[]; // trailing observations (°C), aligned
}

/**
 * Per-station EMOS engine — FORKED VERBATIM from db1-daybefore-efficiency.ts (ADR-02a). Per (model,
 * lead) trailing-window bias + residual store, producing the LIVE baseline blended μ (correctPoint per
 * model + inverse-MSE blend) and σ (fitSigma over the blended corrected-forecast residual window).
 * Mirrors the live calibration path so the fork is the live model, not a re-derivation.
 */
export class EmosStation {
  private readonly win = new Map<string, ModelWindow>();
  /** Trailing blended corrected-forecast residuals (blendμ − obs), per lead, for σ. */
  private readonly blendRes = new Map<number, number[]>();

  constructor(private readonly cfg: AppConfig) {}

  private get(model: string, lead: number): ModelWindow {
    const k = `${model}|${lead}`;
    let w = this.win.get(k);
    if (!w) {
      w = { bias: null, fs: [], os: [] };
      this.win.set(k, w);
    }
    return w;
  }

  /** Blended corrected μ (°C) from the current windows: inverse-MSE weights over corrected residuals. */
  blendedMu(points: { model: string; f: number }[], lead: number): number | null {
    const mse = new Map<string, number>();
    for (const { model } of points) {
      const w = this.get(model, lead);
      const n = w.fs.length;
      if (n < this.cfg.sigmaMinN) continue;
      const bias = w.bias ?? 0;
      let s = 0;
      for (let i = 0; i < n; i++) {
        const r = correctPoint(w.fs[i]!, bias) - w.os[i]!;
        s += r * r;
      }
      mse.set(model, s / n);
    }
    const weights = computeModelWeights(mse);
    const haveW = [...weights.values()].some((v) => v > 0);
    let num = 0;
    let den = 0;
    for (const { model, f } of points) {
      const w = this.get(model, lead);
      const weight = haveW ? (weights.get(model) ?? 0) : 1 / points.length;
      if (weight <= 0) continue;
      num += weight * correctPoint(f, w.bias ?? 0);
      den += weight;
    }
    return den > 0 ? num / den : null;
  }

  /** σ (°C) from the trailing blended-residual window for this lead, or null when too thin. */
  sigma(lead: number): number | null {
    const res = this.blendRes.get(lead) ?? [];
    const fit = fitSigma(res, this.cfg.sigmaMinN);
    return fit ? fit.sigma : null;
  }

  /** Fold a day's truth: per-model EMA bias + window, and the blended residual store for σ. */
  fold(points: { model: string; f: number }[], lead: number, obsC: number): void {
    const mu = this.blendedMu(points, lead);
    if (mu != null && Number.isFinite(mu)) {
      const arr = this.blendRes.get(lead) ?? [];
      arr.push(mu - obsC);
      if (arr.length > this.cfg.sigmaWindowDays) arr.shift();
      this.blendRes.set(lead, arr);
    }
    for (const { model, f } of points) {
      const w = this.get(model, lead);
      w.bias = updateBias(w.bias, f - obsC, this.cfg.biasAlpha);
      w.fs.push(f);
      w.os.push(obsC);
      if (w.fs.length > this.cfg.sigmaWindowDays) {
        w.fs.shift();
        w.os.shift();
      }
    }
  }
}

// =====================================================================================
// LOADERS
// =====================================================================================

const dISO = (d: string | Date): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** A resolved bucket event with its ladder, tz, fee rate, and per-bucket tick sizes. */
export interface MakerEventRow {
  eventId: string;
  icao: string;
  citySlug: string;
  region: string;
  tz: string;
  targetDate: string;
  unit: 'C' | 'F';
  winnerIdx: number;
  feeRate: number;
  ladder: SimLadderBucket[];
  bucketDefs: BucketDef[];
  /** tick_size per bucketIdx (null → fall back to the spray default). */
  tickByBucket: Map<number, number | null>;
}

/** Per-station scope + forecasts + finalized obs — FORKED from db1's inline loaders (ADR-02a). */
export interface EmosLoadResult {
  cfg: AppConfig;
  icaos: string[];
  unitByIcao: Map<string, 'C' | 'F'>;
  /** icao → targetISO → lead → model → tmaxC(°C). */
  fc: Map<string, Map<string, Map<number, Map<string, number>>>>;
  /** icao → targetISO → °C. */
  obs: Map<string, Map<string, number>>;
}

/**
 * Load the EMOS spine inputs (config, scope, forecasts, finalized obs) — the db1 C-1 loaders, forked
 * verbatim (ADR-02a). Read-only.
 */
export async function loadEmosInputs(
  db: Db,
  args: { to: string; stations?: string[]; leads: number[] },
): Promise<EmosLoadResult> {
  const cfg = parseConfigRows(
    await db.query<{ key: string; value: string }>(`select key, value from config`),
  );

  // scope: stations with finalized obs (mirror mos-pointskill / db1)
  let stationRows = await db.query<{ icao: string; unit: 'C' | 'F' }>(
    `select distinct s.icao, c.unit
     from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null
     join cities c on c.id = cs.city_id`,
  );
  if (args.stations) {
    const want = new Set(args.stations.map((s) => s.toUpperCase()));
    stationRows = stationRows.filter((s) => want.has(s.icao.toUpperCase()));
  }
  const icaos = stationRows.map((s) => s.icao);
  const unitByIcao = new Map(stationRows.map((s) => [s.icao, s.unit]));
  if (icaos.length === 0) throw new Error('no stations in scope');

  // forecasts (backfill slot) — the mos-pointskill loader
  const fRows = await db.query<{
    icao: string;
    model: string;
    target_date: string | Date;
    lead_days: number;
    tmax_c: string;
  }>(
    `select icao, model, target_date, lead_days, tmax_c
     from forecast_snapshots
     where snapshot_slot = 'backfill' and icao = any($1) and lead_days = any($2) and target_date <= $3`,
    [icaos, args.leads, args.to],
  );
  const fc = new Map<string, Map<string, Map<number, Map<string, number>>>>();
  for (const r of fRows) {
    const t = dISO(r.target_date);
    const byT = fc.get(r.icao) ?? new Map();
    const byLead = byT.get(t) ?? new Map();
    const byModel = byLead.get(r.lead_days) ?? new Map();
    byModel.set(r.model, Number(r.tmax_c));
    byLead.set(r.lead_days, byModel);
    byT.set(t, byLead);
    fc.set(r.icao, byT);
  }

  // finalized observations → °C
  const oRows = await db.query<{
    icao: string;
    date_local: string | Date;
    tmax_wu_native: number;
    unit: 'C' | 'F';
  }>(
    `select icao, date_local, tmax_wu_native, unit
     from observations where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obs = new Map<string, Map<string, number>>();
  for (const r of oRows) {
    const m = obs.get(r.icao) ?? new Map<string, number>();
    const native = Number(r.tmax_wu_native);
    m.set(dISO(r.date_local), (r.unit ?? unitByIcao.get(r.icao)) === 'F' ? fToC(native) : native);
    obs.set(r.icao, m);
  }

  return { cfg, icaos, unitByIcao, fc, obs };
}

/**
 * Load resolved bucket events + ladders + tz + per-bucket tick sizes — db1's event/ladder loaders
 * forked verbatim (ADR-02a) PLUS `c.tz` (ADR-05) and per-bucket `tick_size` (the maker needs it).
 */
export async function loadEvents(
  db: Db,
  args: { from: string; to: string; icaos: string[] },
): Promise<MakerEventRow[]> {
  const evRows = await db.query<{
    event_id: string;
    icao: string | null;
    city_slug: string;
    region: string;
    tz: string;
    target_date: string | Date;
    unit: 'C' | 'F';
    winning_bucket_idx: number;
    fee_rate: string | null;
  }>(
    `select me.id event_id, me.icao_at_creation icao, c.slug city_slug, c.region, c.tz,
            me.target_date, me.unit, me.winning_bucket_idx,
            (select max(mb.fee_rate) from market_buckets mb where mb.event_id = me.id) fee_rate
     from market_events me
     join cities c on c.id = me.city_id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3`,
    [args.icaos, args.from, args.to],
  );

  const bRows = await db.query<{
    event_id: string;
    bucket_idx: number;
    low_native: number | null;
    high_native: number | null;
    tick_size: string | null;
  }>(
    `select mb.event_id, mb.bucket_idx, mb.low_native, mb.high_native, mb.tick_size
     from market_buckets mb
     join market_events me on me.id = mb.event_id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3
     order by mb.event_id, mb.bucket_idx`,
    [args.icaos, args.from, args.to],
  );
  const laddersByEvent = new Map<string, SimLadderBucket[]>();
  const tickByEvent = new Map<string, Map<number, number | null>>();
  for (const r of bRows) {
    const arr = laddersByEvent.get(r.event_id) ?? [];
    arr.push({ bucketIdx: r.bucket_idx, low: r.low_native, high: r.high_native });
    laddersByEvent.set(r.event_id, arr);
    const tk = tickByEvent.get(r.event_id) ?? new Map<number, number | null>();
    tk.set(r.bucket_idx, r.tick_size == null ? null : Number(r.tick_size));
    tickByEvent.set(r.event_id, tk);
  }

  const events: MakerEventRow[] = [];
  for (const r of evRows) {
    if (!r.icao) continue;
    const ladder = laddersByEvent.get(r.event_id);
    if (!ladder || ladder.length < 2) continue;
    events.push({
      eventId: r.event_id,
      icao: r.icao,
      citySlug: r.city_slug,
      region: r.region,
      tz: r.tz,
      targetDate: dISO(r.target_date),
      unit: r.unit,
      winnerIdx: r.winning_bucket_idx,
      feeRate: r.fee_rate == null ? 0 : Number(r.fee_rate),
      ladder,
      bucketDefs: ladder.map((b) => ({ low: b.low, high: b.high, unit: r.unit })),
      tickByBucket: tickByEvent.get(r.event_id) ?? new Map(),
    });
  }
  return events;
}

/**
 * F-002 (C-2). The FULL ascending book series per resolved event × bucket over the tz-correct UTC
 * SUPERSET window (ADR-05). Forks copytrade's `loadSnapshots` (ADR-02b), adds `last_trade` and the
 * wider `AT TIME ZONE c.tz` window. The window is a per-city-correct superset; the PRECISE
 * resolution/entry instants are computed downstream in TS via `localDayWindow` (the SQL never uses
 * `(target_date±1)::timestamptz`). Returns Map<eventId, Map<bucketIdx, MakerSnapshot[]>> (ASC by
 * captured_at). Read-only.
 */
export async function loadBucketSeries(
  db: Db,
  args: { icaos: string[]; from: string; to: string; lookbackDays: number },
): Promise<Map<string, Map<number, MakerSnapshot[]>>> {
  const out = new Map<string, Map<number, MakerSnapshot[]>>();
  const rows = await db.query<{
    event_id: string;
    bucket_idx: number;
    captured_at: string | Date;
    best_bid: string | null;
    best_ask: string | null;
    mid: string | null;
    last_trade: string | null;
  }>(
    `select mb.event_id, mb.bucket_idx, ms.captured_at, ms.best_bid, ms.best_ask, ms.mid, ms.last_trade
     from market_snapshots ms
     join market_buckets mb on mb.id = ms.bucket_id
     join market_events  me on me.id = mb.event_id
     join cities         c  on c.id  = me.city_id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3
       and ms.captured_at >= ((me.target_date::timestamp - ($4 || ' days')::interval) at time zone c.tz)
       and ms.captured_at <  ((me.target_date::timestamp + interval '2 days')          at time zone c.tz)
     order by mb.event_id, mb.bucket_idx, ms.captured_at asc`,
    [args.icaos, args.from, args.to, String(args.lookbackDays)],
  );
  for (const r of rows) {
    let byBucket = out.get(r.event_id);
    if (!byBucket) {
      byBucket = new Map<number, MakerSnapshot[]>();
      out.set(r.event_id, byBucket);
    }
    const arr = byBucket.get(r.bucket_idx) ?? [];
    arr.push({
      capturedAt: Math.floor(new Date(r.captured_at).getTime() / 1000),
      bid: r.best_bid == null ? null : Number(r.best_bid),
      ask: r.best_ask == null ? null : Number(r.best_ask),
      mid: r.mid == null ? null : Number(r.mid),
      lastTrade: r.last_trade == null ? null : Number(r.last_trade),
    });
    byBucket.set(r.bucket_idx, arr);
  }
  return out;
}

// =====================================================================================
// ASSEMBLE — the walk-forward fold (mirrors db1) → RestingBid[] + the forkRmse accumulator
// =====================================================================================

/** The first usable ask at/after a unix-second instant (the market-implied prob at entry, F-006). */
function askAtOrAfter(series: MakerSnapshot[], t: number): number | null {
  for (const s of series) {
    if (s.capturedAt >= t && s.ask != null && Number.isFinite(s.ask) && s.ask > 0 && s.ask <= 1) {
      return s.ask;
    }
  }
  return null;
}

export interface AssembleArgs {
  from: string;
  to: string;
  leads: number[];
  /** Hours before resolution the maker rests its bid (ADR-05). */
  entryLeadHours: number;
}

export interface AssembleResult {
  bids: RestingBid[];
  /** Blended-μ point RMSE over the same build-days (the fork-correctness accumulator). */
  forkRmse: number;
  forkN: number;
}

/**
 * Walk-forward fold (mirrors db1 VERBATIM) → calibratedP via gaussianBucketProbs; per resolved event
 * compute the station-LOCAL resolution/entry instants via `localDayWindow(c.tz, target_date)`
 * (ADR-05), set marketProbAtEntry = the ask at entryTs, capture tzOffsetHours for the skew report, and
 * emit one RestingBid per bucket WITH its snapshot series. Retains the forkRmse accumulator. Does NOT
 * resolve the entry SNAPSHOT (makerEntry owns that, Pass-1 integrity) — it only sets entryTs and passes
 * the series. Pure given its loaded inputs.
 */
export function assembleBids(
  emos: EmosLoadResult,
  events: MakerEventRow[],
  seriesMap: Map<string, Map<number, MakerSnapshot[]>>,
  args: AssembleArgs,
): AssembleResult {
  const { cfg, icaos, fc, obs } = emos;
  const leadSet = new Set(args.leads);
  const entryLeadSec = args.entryLeadHours * 3600;

  // index events by (icao, targetDate) — the walk scores by build-day
  const eventByKey = new Map<string, MakerEventRow>();
  for (const e of events) eventByKey.set(`${e.icao}|${e.targetDate}`, e);

  const stateByIcao = new Map(icaos.map((i) => [i, new EmosStation(cfg)]));

  const foldDay = (icao: string, t: string): void => {
    const o = obs.get(icao)?.get(t);
    const byLeadMap = fc.get(icao)?.get(t);
    if (o === undefined || !byLeadMap) return;
    const sm = stateByIcao.get(icao)!;
    for (const [lead, byModel] of byLeadMap) {
      if (!leadSet.has(lead)) continue;
      sm.fold(
        [...byModel].map(([model, f]) => ({ model, f })),
        lead,
        o,
      );
    }
  };

  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);

  // warm-up: fold everything strictly before `from` (mirrors db1)
  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldDay(icao, t);

  const bids: RestingBid[] = [];
  // De-dup guard: the EV unit is a market POSITION (eventId, bucketIdx), not a (NWP-lead × position). Emit one
  // bid per event — pooling every lead counted each position once PER LEAD (with --leads 1,2 the default,
  // exactly 2×), inflating the effective n and shrinking every downstream CI by ~√leadCount.
  const emittedEvents = new Set<string>();
  let forkSe = 0;
  let forkN = 0;

  for (const d of listDatesISO(args.from, args.to)) {
    for (const icao of icaos) {
      const o = obs.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) continue;
      const sm = stateByIcao.get(icao)!;
      const ev = eventByKey.get(`${icao}|${d}`);
      // NWP leads in ASCENDING order so the de-dup below keeps the SHORTEST-lead (most-recent) forecast.
      for (const lead of [...byLeadMap.keys()].sort((a, b) => a - b)) {
        if (!leadSet.has(lead)) continue;
        const byModel = byLeadMap.get(lead)!;
        const points = [...byModel].map(([model, f]) => ({ model, f }));
        if (points.length === 0) continue;

        const mu = sm.blendedMu(points, lead); // °C
        if (mu == null || !Number.isFinite(mu)) continue;

        // fork-correctness: point RMSE of the blended μ vs obs (the live baseline metric — db1 identical)
        forkSe += (mu - o) ** 2;
        forkN++;

        if (!ev) continue; // no resolved bucket market for this (station, day) — only the RMSE uses it

        const sigmaC = sm.sigma(lead);
        if (sigmaC == null || !Number.isFinite(sigmaC)) continue;

        const muNative = toNative(mu, ev.unit);
        const sigmaNative = ev.unit === 'F' ? sigmaC * (9 / 5) : sigmaC;
        if (sigmaNative <= 0.2) continue; // gaussianBucketProbs would refuse (§11.1, db1 :515)
        let probs: number[];
        try {
          probs = gaussianBucketProbs(muNative, sigmaNative, ev.bucketDefs);
        } catch {
          continue;
        }

        // station-LOCAL resolution/entry instants (ADR-05 — the binding correctness fix)
        const resolutionTs = Math.floor(localDayWindow(ev.tz, ev.targetDate).endUtc.getTime() / 1000);
        const entryTs = resolutionTs - entryLeadSec;
        // UTC offset (hours) at the resolution instant — for the maxTzSkew report
        const startTs = Math.floor(localDayWindow(ev.tz, ev.targetDate).startUtc.getTime() / 1000);
        const localMidnightUtcSec = Date.parse(`${ev.targetDate}T00:00:00Z`) / 1000;
        const tzOffsetHours = (localMidnightUtcSec - startTs) / 3600;

        // One emission per event: fork RMSE above counted every lead; the bids list takes the first
        // (shortest) lead that clears all guards, so each market position appears exactly once.
        if (emittedEvents.has(ev.eventId)) continue;
        emittedEvents.add(ev.eventId);

        const byBucket = seriesMap.get(ev.eventId);
        for (let i = 0; i < ev.ladder.length; i++) {
          const b = ev.ladder[i]!;
          const series = byBucket?.get(b.bucketIdx) ?? [];
          const tick = ev.tickByBucket.get(b.bucketIdx) ?? null;
          bids.push({
            conditionId: ev.eventId,
            bucketIdx: b.bucketIdx,
            calibratedP: probs[i]!,
            marketProbAtEntry: askAtOrAfter(series, entryTs),
            bucketWon: b.bucketIdx === ev.winnerIdx,
            feeRate: ev.feeRate,
            tickSize: tick ?? 0.01,
            citySlug: ev.citySlug,
            station: icao,
            tzOffsetHours,
            targetDate: ev.targetDate,
            resolutionTs,
            entryTs,
            snapshots: series,
          });
        }
      }
    }
    for (const icao of icaos) foldDay(icao, d);
  }

  return { bids, forkRmse: Math.sqrt(forkSe / Math.max(1, forkN)), forkN };
}

// =====================================================================================
// FORK-EQUALITY GATE (Pass-1 W2 / R-3) — assert our forked accumulator byte-matches a LIVE db1 run
// =====================================================================================

export interface ForkEqualityResult {
  db1Rmse: number;
  makerRmse: number;
  equal: boolean;
}

/**
 * The correctness gate (Pass-1 W2 / R-3). Call the EXPORTED `runDb1(args).forkRmse` (db1's PUBLIC
 * entrypoint — NOT its private inline loaders, so ADR-02 "copy don't import" is not violated) AND our
 * forked accumulator over the IDENTICAL window/scope, then assert byte-equality. NB: the frozen
 * 1.2991°C is only the documented DEFAULT-window expectation, NOT the gate (it drifts with backfill
 * growth + flags). The gate is `db1Rmse === makerRmse`.
 *
 * `entryLeadHours` does not change the RMSE accumulator (it only depends on μ/obs over the build-days),
 * so any value matching db1's lead set scores the identical RMSE — we use the smallest lead's window.
 */
export async function forkEqualityRmse(
  db: Db,
  args: { from: string; to: string; leads: number[]; stations?: string[] },
): Promise<ForkEqualityResult> {
  // our fork on this window
  const emos = await loadEmosInputs(db, { to: args.to, stations: args.stations, leads: args.leads });
  const events = await loadEvents(db, { from: args.from, to: args.to, icaos: emos.icaos });
  const seriesMap = await loadBucketSeries(db, {
    icaos: emos.icaos,
    from: args.from,
    to: args.to,
    lookbackDays: 1,
  });
  const ours = assembleBids(emos, events, seriesMap, {
    from: args.from,
    to: args.to,
    leads: args.leads,
    entryLeadHours: 24,
  });

  // db1's public entrypoint on the identical scope
  const db1Args: Db1Args = {
    from: args.from,
    to: args.to,
    leads: args.leads,
    stations: args.stations,
    minBets: 5,
    json: false,
  };
  const db1Deps: Db1Deps = { db, log: () => {} };
  const db1Res = await runDb1(db1Args, db1Deps);

  return {
    db1Rmse: db1Res.forkRmse,
    makerRmse: ours.forkRmse,
    // byte-equality on the IEEE-754 value (both compute Math.sqrt(Σse / N) over the same build-days)
    equal: Object.is(db1Res.forkRmse, ours.forkRmse),
  };
}

// =====================================================================================
// CLI ARG PARSING (P1: enough to drive load → assemble → forkEquality; the study wiring is P2)
// =====================================================================================

export interface MakerSprayArgs {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
  restRule: RestRule;
  fillModel: FillModel;
  /** 'all' = rest on every cheap bucket (baseline); 'forecast' = rest only where calibratedP > restPx. */
  select: 'all' | 'forecast';
  askOffset: number;
  entryLeadHours: number[];
  lookbackDays: number;
  cheapMax: number;
  makerRebate: number;
  /** Maker rebate as a SHARE OF THE TAKER FEE (default 0). >0 → the realistic weather_fees model. */
  rebateRate: number;
  margin: number;
  mcIters: number;
  crossVal: boolean;
  json: boolean;
}

/** Map the CLI `--rest-at` token to the internal RestRule enum (Pass-1 L1). */
export function parseRestRule(v: string | undefined): RestRule {
  switch (v) {
    case 'bid+tick':
      return 'bid_plus_tick';
    case 'ask-offset':
      return 'ask_offset';
    case 'bid':
    case undefined:
      return 'bid';
    default:
      throw new Error(`--rest-at must be bid|bid+tick|ask-offset, got '${v}'`);
  }
}

/** Map the CLI `--select` token to the selection mode (default 'all'). */
export function parseSelect(v: string | undefined): 'all' | 'forecast' {
  switch (v) {
    case 'forecast':
      return 'forecast';
    case 'all':
    case undefined:
      return 'all';
    default:
      throw new Error(`--select must be all|forecast, got '${v}'`);
  }
}

/** Map the CLI `--fill-model` token to the internal FillModel enum. */
export function parseFillModel(v: string | undefined): FillModel {
  switch (v) {
    case 'last_trade':
    case 'last-trade':
      return 'last_trade';
    case 'ask_touch':
    case 'ask-touch':
    case undefined:
      return 'ask_touch';
    default:
      throw new Error(`--fill-model must be ask_touch|last_trade, got '${v}'`);
  }
}

// =====================================================================================
// LOAD + ASSEMBLE (the shared spine the study, the sweep, and the fork-equality gate sit on)
// =====================================================================================

export interface MakerSprayDeps {
  db: Db;
  log: (msg: string) => void;
}

const f4 = (x: number): string => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : '—');
const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');

/** The maker spray options the pure simulator reads, derived once from the CLI args. */
function sprayOptsFor(args: MakerSprayArgs): {
  rule: RestRule;
  fillModel: FillModel;
  select: 'all' | 'forecast';
  askOffset: number;
  cheapMax: number;
  rebate: number;
  rebateRate: number;
  mcIters: number;
  bootstrapSeed: number;
} {
  return {
    rule: args.restRule,
    fillModel: args.fillModel,
    select: args.select,
    askOffset: args.askOffset,
    cheapMax: args.cheapMax,
    rebate: args.makerRebate,
    rebateRate: args.rebateRate,
    mcIters: args.mcIters,
    bootstrapSeed: 42, // the repo reproducibility contract (do NOT expose — determinism is load-bearing)
  };
}

/** Loaded scope + assembled RestingBid[] for one entry-lead, the spine `run`/`runSweep` reuse. */
export interface LoadedSpine {
  nStations: number;
  nEvents: number;
  bids: RestingBid[];
  forkRmse: number;
  forkN: number;
}

/**
 * Load the EMOS inputs + events + the tz-correct C-2 series, then assemble RestingBid[] for ONE
 * entry-lead. The DB reads happen once per (scope, lookback); `assembleBids` is pure given them, so a
 * sweep over entry-leads re-assembles cheaply on the loaded maps. Read-only.
 */
export async function loadAndAssemble(
  db: Db,
  args: MakerSprayArgs,
  entryLeadHours: number,
): Promise<LoadedSpine> {
  const emos = await loadEmosInputs(db, { to: args.to, stations: args.stations, leads: args.leads });
  const events = await loadEvents(db, { from: args.from, to: args.to, icaos: emos.icaos });
  const seriesMap = await loadBucketSeries(db, {
    icaos: emos.icaos,
    from: args.from,
    to: args.to,
    lookbackDays: args.lookbackDays,
  });
  const { bids, forkRmse, forkN } = assembleBids(emos, events, seriesMap, {
    from: args.from,
    to: args.to,
    leads: args.leads,
    entryLeadHours,
  });
  return { nStations: emos.icaos.length, nEvents: events.length, bids, forkRmse, forkN };
}

// =====================================================================================
// CROSS-VALIDATION (F-008) — does our fill model PREDICT badatmath's OWN cheap fills filled?
// =====================================================================================

/** One of badatmath's real cheap fills, joined to its bucket's post-fill book series (F-008). */
export interface CrossValFill {
  restPx: number;
  postEntry: FillSnapshot[];
}

/** The /activity crawler shape `loadCrossValFills` depends on (the real `crawlActivity` by default;
 *  injectable so the clean-degradation path is unit-testable without the network). */
export type CrossValCrawler = typeof crawlActivity;

/**
 * Build the cross-val input (F-008): crawl badatmath's BUY fills, keep the cheap (<cheapMax) ones,
 * join each to its bucket's `market_snapshots` series, and slice to the post-fill window — the book a
 * resting bid AT badatmath's own fill price would have seen. `crossValidateFillModel` then asks what
 * fraction our fill model PREDICTS filled (it should be high; low ⇒ the 30-min grid is too coarse and
 * the headline is caveated, not trusted). Read-only; degrades cleanly to [] on a crawl/rate-limit fail
 * (the non-blocking contract — a Polymarket 4xx/timeout NEVER fails the main study).
 *
 * `crawl` defaults to the real `crawlActivity`; tests inject a stub to exercise both the happy path
 * and the rate-limit-degradation path deterministically (no network).
 */
export async function loadCrossValFills(
  db: Db,
  args: { wallet: string; from: string; cheapMax: number; maxPages: number },
  log: (m: string) => void,
  crawl: CrossValCrawler = crawlActivity,
): Promise<CrossValFill[]> {
  let fills: WalletActivity[];
  try {
    const res = await crawl(args.wallet, { maxPages: args.maxPages, from: args.from });
    fills = res.fills.filter((f) => f.type === 'TRADE' && f.side === 'BUY');
    log(`  cross-val crawl: mode=${res.mode}, pages=${res.pagesFetched}, BUY fills=${fills.length}`);
  } catch (err) {
    log(`  cross-val crawl FAILED (${(err as Error)?.message ?? err}) — cross-val skipped`);
    return [];
  }

  // cheap BUY fills with a usable price + condition id
  const cheap = fills.filter(
    (f) =>
      f.conditionId !== '' &&
      Number.isFinite(f.price) &&
      f.price > 0 &&
      f.price < args.cheapMax &&
      Number.isFinite(f.timestamp),
  );
  if (cheap.length === 0) return [];

  // condition_id → bucket_id (read-only join, chunked — mirrors copytrade-feasibility's loadBucketMeta)
  const conditionIds = [...new Set(cheap.map((f) => f.conditionId))];
  const bucketByCondition = new Map<string, string>();
  const CHUNK = 500;
  for (let i = 0; i < conditionIds.length; i += CHUNK) {
    const chunk = conditionIds.slice(i, i + CHUNK);
    const rows = await db.query<{ condition_id: string; bucket_id: string }>(
      `select mb.condition_id, mb.id bucket_id
       from market_buckets mb
       where mb.condition_id = any($1)`,
      [chunk],
    );
    for (const r of rows) bucketByCondition.set(r.condition_id, r.bucket_id);
  }

  // snapshot series per bucket_id (ASC by captured_at), read-only — fork of copytrade's loadSnapshots
  const bucketIds = [...new Set([...bucketByCondition.values()])];
  const seriesByBucket = new Map<string, FillSnapshot[]>();
  const SCHUNK = 300;
  for (let i = 0; i < bucketIds.length; i += SCHUNK) {
    const chunk = bucketIds.slice(i, i + SCHUNK);
    const rows = await db.query<{
      bucket_id: string;
      captured_at: string | Date;
      best_bid: string | null;
      best_ask: string | null;
      mid: string | null;
      last_trade: string | null;
    }>(
      `select bucket_id, captured_at, best_bid, best_ask, mid, last_trade
       from market_snapshots where bucket_id = any($1) order by bucket_id, captured_at asc`,
      [chunk],
    );
    for (const r of rows) {
      const arr = seriesByBucket.get(r.bucket_id) ?? [];
      arr.push({
        capturedAt: Math.floor(new Date(r.captured_at).getTime() / 1000),
        bid: r.best_bid == null ? null : Number(r.best_bid),
        ask: r.best_ask == null ? null : Number(r.best_ask),
        mid: r.mid == null ? null : Number(r.mid),
        lastTrade: r.last_trade == null ? null : Number(r.last_trade),
      });
      seriesByBucket.set(r.bucket_id, arr);
    }
  }

  const out: CrossValFill[] = [];
  for (const f of cheap) {
    const bucketId = bucketByCondition.get(f.conditionId);
    if (!bucketId) continue;
    const series = seriesByBucket.get(bucketId);
    if (!series || series.length === 0) continue;
    // the post-fill window: the book a resting bid at badatmath's fill price would see evolve.
    const postEntry = series.filter((s) => s.capturedAt >= f.timestamp);
    if (postEntry.length === 0) continue;
    out.push({ restPx: f.price, postEntry });
  }
  return out;
}

// =====================================================================================
// RUN (load → assemble → forkEquality → simulateSpray → verdict → (opt) crossVal → report)
// =====================================================================================

/** One entry-lead's study slice — the report renders one of these per lead in a sweep. */
export interface SprayRun {
  entryLeadHours: number;
  report: MakerSprayReport;
  verdict: MakerSprayVerdict;
}

export interface MakerSprayResult {
  args: MakerSprayArgs;
  nStations: number;
  nEvents: number;
  forkRmse: number;
  forkN: number;
  forkEquality: ForkEqualityResult;
  maxTzSkewHours: number;
  /** One run per entry-lead (the headline run is `runs[0]`; len>1 ⇒ a sweep). */
  runs: SprayRun[];
  /** The spray-protocol by-product (the same pipeline yields it for free). */
  protocol: SprayProtocol;
  /** M1 — when sweeping >1 lead/fill-model, true iff the PASS/FAIL verdict is stable across them. */
  verdictStable: boolean;
  crossVal?: CrossValResult;
}

/** The reverse-engineered spray protocol (the by-product, mirrors copytrade's printProtocolSpec). */
export interface SprayProtocol {
  nCandidates: number;
  nCheapEligible: number;
  /** Median cheap-eligible buckets sprayed per (station, day). */
  bucketsPerStationDayMedian: number;
  bucketsPerStationDayP90: number;
  bucketsPerStationDayMax: number;
  /** Mean rest-vs-mid (restPx − mid at entry) across cheap-eligible bids; negative ⇒ resting passively. */
  restVsMidMean: number;
}

const quantile = (sortedAsc: number[], q: number): number =>
  sortedAsc.length === 0
    ? NaN
    : sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))]!;

/**
 * Run the maker-spray study end-to-end for the given args. Loads + assembles once per entry-lead,
 * proves the fork-equality gate vs a LIVE db1 run, runs `simulateSpray` + `makerSprayVerdict`, builds
 * the spray-protocol by-product, optionally cross-validates, and (when >1 entry-lead OR a sweep is
 * requested) asserts verdict stability across the sweep (M1). Read-only.
 */
export async function run(args: MakerSprayArgs, deps: MakerSprayDeps): Promise<MakerSprayResult> {
  const { db, log } = deps;
  const opts = sprayOptsFor(args);

  // the fork-equality gate ONCE (it does not depend on the entry-lead — R-3 / Pass-1 W2)
  const forkEquality = await forkEqualityRmse(db, {
    from: args.from,
    to: args.to,
    leads: args.leads,
    stations: args.stations,
  });

  // one study slice per entry-lead (the headline is the first; a sweep runs them all — M1)
  const leads = args.entryLeadHours.length > 0 ? args.entryLeadHours : [24];
  const runs: SprayRun[] = [];
  let headlineSpine: LoadedSpine | null = null;
  for (const lead of leads) {
    const spine = await loadAndAssemble(db, args, lead);
    if (headlineSpine === null) headlineSpine = spine;
    const report = simulateSpray(spine.bids, opts);
    const verdict = makerSprayVerdict(report, { marginThreshold: args.margin });
    runs.push({ entryLeadHours: lead, report, verdict });
  }
  const spine = headlineSpine!;

  // M1: verdict stability across the sweep — all entry-lead verdicts must agree on PASS/FAIL.
  const passes = runs.map((r) => r.verdict.pass);
  const verdictStable = passes.every((p) => p === passes[0]);

  const maxTzSkewHours = spine.bids.reduce(
    (m, b) => (Number.isFinite(b.tzOffsetHours) ? Math.max(m, Math.abs(b.tzOffsetHours)) : m),
    0,
  );

  const protocol = buildProtocolFromReport(spine.bids, runs[0]!.report, args);

  let crossVal: CrossValResult | undefined;
  if (args.crossVal) {
    log('\n── cross-validating the fill model against badatmath\'s OWN cheap fills (F-008) ──');
    const cvFills = await loadCrossValFills(
      db,
      {
        wallet: SHARP_WALLET_ADDRESS,
        from: args.from,
        cheapMax: args.cheapMax,
        maxPages: 1000,
      },
      log,
    );
    crossVal = crossValidateFillModel(cvFills, args.fillModel);
  }

  return {
    args,
    nStations: spine.nStations,
    nEvents: spine.nEvents,
    forkRmse: spine.forkRmse,
    forkN: spine.forkN,
    forkEquality,
    maxTzSkewHours,
    runs,
    protocol,
    verdictStable,
    crossVal,
  };
}

/**
 * Build the spray-protocol by-product from the headline report + its bids. The report already carries
 * `nCandidates`/`nCheapEligible`; this adds the per-(station,day) spray density + the rested-price
 * median by re-running the pure simulator per (station,day) slice (the eligibility rule stays owned by
 * `makerEntry` inside `simulateSpray` — never re-implemented here).
 */
function buildProtocolFromReport(
  bids: RestingBid[],
  report: MakerSprayReport,
  args: MakerSprayArgs,
): SprayProtocol {
  const opts = sprayOptsFor(args);
  // group bids by (station, day); a per-group spray gives that group's eligible count.
  const byKey = new Map<string, RestingBid[]>();
  for (const b of bids) {
    const k = `${b.station}|${b.targetDate}`;
    const arr = byKey.get(k);
    if (arr) arr.push(b);
    else byKey.set(k, [b]);
  }
  const perDay: number[] = [];
  for (const group of byKey.values()) {
    const r = simulateSpray(group, opts);
    if (r.nCheapEligible > 0) perDay.push(r.nCheapEligible);
  }
  perDay.sort((a, b) => a - b);

  // The rest-vs-mid character is already a pooled mean on the report (a signed restPx−mid descriptor:
  // negative ⇒ the spray rests passively below the mid, as badatmath does). Surface it directly — the
  // binding numbers (eligible count, fill rate, EV CI) are the deliverable; this is a soft descriptor.
  const restVsMidMean = report.restVsMid.n > 0 ? report.restVsMid.mean : NaN;

  return {
    nCandidates: report.nCandidates,
    nCheapEligible: report.nCheapEligible,
    bucketsPerStationDayMedian: quantile(perDay, 0.5),
    bucketsPerStationDayP90: quantile(perDay, 0.9),
    bucketsPerStationDayMax: perDay.length ? perDay[perDay.length - 1]! : 0,
    restVsMidMean,
  };
}

// =====================================================================================
// REPORT (F-009 / L2)
// =====================================================================================

/**
 * Print the full readout: fork-equality, fill rate, the BINDING filled-net-EV CI, the
 * adverse-selection diagnostic, Brier-vs-market, the zero-skill P(PASS), per-station, the
 * spray-protocol by-product, coverage + maxTzSkewHours caveat, cross-val agreement, and the WO-5
 * two-branch verdict template (OPEN vs FALSIFIED — Pass-1 L2). Mirrors db1 / copytrade's report idiom.
 */
export function report(res: MakerSprayResult, log: (m: string) => void): void {
  const { args } = res;
  const headline = res.runs[0]!;
  const r = headline.report;

  log(
    `=== maker-spray-feasibility ${args.from} → ${args.to} · leads ${args.leads.join(',')} · rest-at ${args.restRule} · fill ${args.fillModel} · select ${args.select} ===`,
  );
  log(`scope: ${res.nStations} stations · ${res.nEvents} resolved bucket events`);
  log(
    `params: entry-lead ${args.entryLeadHours.join(',')}h  cheap<${args.cheapMax}  rebate ${args.makerRebate}  rebate-rate ${args.rebateRate}${args.rebateRate > 0 ? ' (REALISTIC weather_fees: no maker fee + rebateRate×fee)' : ' (conservative §12 model)'}  margin +${(args.margin * 100).toFixed(0)}%  mc-iters ${args.mcIters}  lookback ${args.lookbackDays}d`,
  );
  log('');

  // ── fork-equality (R-3) ──────────────────────────────────────────────────────────────────────────
  log(
    `FORK-EQUALITY (R-3): db1 forkRmse ${f4(res.forkEquality.db1Rmse)}°C  vs maker fork ${f4(res.forkEquality.makerRmse)}°C  → equal=${res.forkEquality.equal}`,
  );
  if (!res.forkEquality.equal) {
    log('  ✗ FORK MISMATCH — the forked EMOS spine is NOT the live model. The result is UNTRUSTWORTHY (R-3).');
  }
  log('');

  // ── the binding headline (filled fee-net EV CI) + fill rate ──────────────────────────────────────
  log('── THE BINDING HEADLINE: FILLED maker fee-net EV per $1 (cheap <0.25, POOLED) ──');
  log(
    `  candidates ${r.nCandidates}  cheap-eligible ${r.nCheapEligible}  FILLED ${r.nFilled}  fill rate ${pctf(r.fillRate)}`,
  );
  log(
    `  ★ filled fee-net EV/$1 ${pctf(r.filledNetEv.ev)}  95% CI [${pctf(r.filledNetEv.evCiLo)}, ${pctf(r.filledNetEv.evCiHi)}]  (n=${r.filledNetEv.n})`,
  );
  log(
    `  filled maker edge (won−restPx) ${pctf(r.filledEdge.mean)}  95% CI [${pctf(r.filledEdge.ciLo)}, ${pctf(r.filledEdge.ciHi)}]  (n=${r.filledEdge.n})`,
  );
  log('');

  // ── adverse-selection gating sanity (R-1 / R-4) ──────────────────────────────────────────────────
  const as = r.adverseSelection;
  log('── ADVERSE-SELECTION diagnostic (GATING SANITY — filled-hit ≪ all-eligible-hit ⇒ AS real) ──');
  log(
    `  filled hit rate ${f3(as.filledHitRate)} (n=${as.nFilled})  vs all-eligible hit rate ${f3(as.allEligibleHitRate)} (n=${as.nEligible})  → AS confirmed: ${as.asConfirmed}`,
  );
  if (!as.asConfirmed) {
    log('  ⚠ AS did NOT appear — the fill model\'s pessimism assumption failed; the verdict is flagged SUSPECT (R-1).');
  }
  log('');

  // ── Brier vs market (F-006) ──────────────────────────────────────────────────────────────────────
  const bd = r.brierVsMarket;
  log('── BRIER (ours) vs BRIER (market-implied-at-entry) — the calibration sanity (F-006) ──');
  log(
    `  Brier ours ${f4(bd.ours)}  market ${f4(bd.market)}  delta(ours−mkt) ${f4(bd.delta)}  (n=${bd.nEvents})  ← negative ⇒ our forecast sharper at entry`,
  );
  log('');

  // ── zero-skill Monte-Carlo false-positive calibration (ADR-08 / W4) ──────────────────────────────
  log('── ZERO-SKILL MONTE-CARLO (shuffle won within station, re-verify — the false-positive guard) ──');
  log(
    `  P(PASS | zero skill) ${pctf(r.zeroSkillMc.pPass)}  over ${r.zeroSkillMc.iters} iters  ← MUST be < 5% to trust the gate`,
  );
  log('');

  // ── per-station REAL CIs (the descriptor, NOT a co-equal gate — W4) ──────────────────────────────
  log('── PER-STATION filled fee-net EV (REAL bootstrap CIs; a ROBUSTNESS DESCRIPTOR, not a gate) ──');
  const stations = [...r.perStation.keys()].sort();
  if (stations.length === 0) log('  (no station has a filled cheap maker position)');
  for (const st of stations) {
    const s = r.perStation.get(st)!;
    log(
      `  ${st.padEnd(6)} n=${String(s.nFilled).padStart(4)}  EV/$1 ${pctf(s.filledNetEv.ev).padStart(8)}  95% CI [${pctf(s.filledNetEv.evCiLo)}, ${pctf(s.filledNetEv.evCiHi)}]`,
    );
  }
  log(`  stations whose own CI clears 0: ${headline.verdict.stationsClearing.length}` +
    (headline.verdict.stationsClearing.length ? ` (${headline.verdict.stationsClearing.join(', ')})` : '') +
    `; EHAM-only: ${headline.verdict.ehamOnly}`);
  log('');

  // ── the entry-lead / fill-model SWEEP (M1) ──────────────────────────────────────────────────────
  if (res.runs.length > 1) {
    log('── ENTRY-LEAD SWEEP (M1 — the verdict must be STABLE across leads) ──');
    for (const sr of res.runs) {
      log(
        `  lead ${String(sr.entryLeadHours).padStart(3)}h:  filled n=${String(sr.report.nFilled).padStart(4)}  EV/$1 ${pctf(sr.report.filledNetEv.ev).padStart(8)}  CI [${pctf(sr.report.filledNetEv.evCiLo)}, ${pctf(sr.report.filledNetEv.evCiHi)}]  → ${sr.verdict.pass ? 'PASS' : 'FAIL'}`,
      );
    }
    log(`  VERDICT STABILITY across the sweep: ${res.verdictStable ? 'STABLE ✓' : 'UNSTABLE ✗ (lead-sensitive — do NOT trust a lone PASS)'}`);
    log('');
  }

  // ── the spray-protocol by-product ────────────────────────────────────────────────────────────────
  const p = res.protocol;
  log('── SPRAY PROTOCOL (the by-product — how the spray would rest, per station·day) ──');
  log(
    `  cheap-eligible buckets/station·day:  median ${f3(p.bucketsPerStationDayMedian)}  p90 ${f3(p.bucketsPerStationDayP90)}  max ${p.bucketsPerStationDayMax}` +
      `  (badatmath sprays ~6/city·day, max 16 — §11)`,
  );
  log(`  rest-vs-mid (mean restPx−mid): ${pctf(p.restVsMidMean)}  ← negative ⇒ resting passively below the mid`);
  log('');

  // ── coverage + the tz-skew caveat ────────────────────────────────────────────────────────────────
  const cov = r.coverage;
  log('── COVERAGE + tz-skew caveat (the honest limitation — copy-trade §11 precedent) ──');
  log(
    `  bids with a book: ${cov.nWithBook}/${r.nCandidates}   cheap-eligible with a post-entry series: ${cov.nWithPostEntrySeries}`,
  );
  log(
    `  snapshot grid median gap: ${Number.isFinite(cov.gridMedianGapSec) ? (cov.gridMedianGapSec / 60).toFixed(0) + 'min' : '—'}  (≈30-min grid — the fill model is a coarse approximation)`,
  );
  log(
    `  maxTzSkewHours CORRECTED (ADR-05): ${f4(cov.maxTzSkewHours)}h  ← this is the systematic db1 (target_date±1)::timestamptz error this model AVOIDS`,
  );
  log('');

  // ── cross-val (F-008) ────────────────────────────────────────────────────────────────────────────
  if (res.crossVal) {
    log('── FILL-MODEL CROSS-VALIDATION (F-008 — agreement on badatmath\'s OWN cheap fills) ──');
    log(
      `  our fill model predicts ${pctf(res.crossVal.agreementRate)} of badatmath's ${res.crossVal.n} cheap fills filled  ← low ⇒ the 30-min grid is too coarse; the headline is CAVEATED`,
    );
    log('');
  }

  // ── the WO-5 two-branch verdict template (OPEN vs FALSIFIED — Pass-1 L2) ─────────────────────────
  log('──────── VERDICT (pre-registered FROZEN kill-criterion — MAKER-SPRAY-SIM.md §9, do NOT move it) ────────');
  log(`  ${headline.verdict.summary}`);
  if (headline.verdict.pass) {
    log(
      '  → 4th ANGLE OPEN: a rested maker bid on OUR forecast clears zero EV. This is genuinely NEW out-of-market',
    );
    log(
      '    information. ESCALATE to adversarial second-agent re-verification (pooled CI clears 0? zero-skill P(PASS)',
    );
    log(
      `    ${pctf(r.zeroSkillMc.pPass)} < 5%? AS confirmed (${as.asConfirmed})? verdict stable across leads (${res.verdictStable})? thresholds UNMOVED?)`,
    );
    log('    BEFORE any consideration of the (still-dormant) live rail. Ship nothing to prod until that passes.');
  } else {
    log(
      '  → 4th and LAST angle FALSIFIED: maker entry on our forecast is ALSO efficient (CI straddles/below 0).',
    );
    log(
      `    Adverse selection ${as.asConfirmed ? 'CONFIRMED (filled-hit ' + f3(as.filledHitRate) + ' ≪ all-eligible ' + f3(as.allEligibleHitRate) + ')' : 'NOT confirmed — verdict flagged SUSPECT, re-examine the fill model'}.`,
    );
    log('    Publish the measurement (WALLET-RECON-HANDOFF.md §12 + memory). The live rail stays DORMANT.');
  }

  if (args.json) {
    log(
      '\nJSON ' +
        JSON.stringify({
          params: {
            from: args.from,
            to: args.to,
            leads: args.leads,
            stations: args.stations,
            restRule: args.restRule,
            fillModel: args.fillModel,
            select: args.select,
            askOffset: args.askOffset,
            entryLeadHours: args.entryLeadHours,
            lookbackDays: args.lookbackDays,
            cheapMax: args.cheapMax,
            makerRebate: args.makerRebate,
            rebateRate: args.rebateRate,
            margin: args.margin,
            mcIters: args.mcIters,
          },
          nStations: res.nStations,
          nEvents: res.nEvents,
          forkEquality: res.forkEquality,
          maxTzSkewHours: res.maxTzSkewHours,
          verdictStable: res.verdictStable,
          protocol: res.protocol,
          crossVal: res.crossVal ?? null,
          runs: res.runs.map((sr) => ({
            entryLeadHours: sr.entryLeadHours,
            report: serializeReport(sr.report),
            verdict: sr.verdict,
          })),
        }),
    );
  }
}

/** Map-free, JSON-serialisable view of a report (Maps don't survive JSON.stringify). */
function serializeReport(r: MakerSprayReport): Record<string, unknown> {
  return {
    nCandidates: r.nCandidates,
    nCheapEligible: r.nCheapEligible,
    nFilled: r.nFilled,
    fillRate: r.fillRate,
    filledNetEv: r.filledNetEv,
    filledEdge: r.filledEdge,
    adverseSelection: r.adverseSelection,
    brierVsMarket: r.brierVsMarket,
    zeroSkillMc: r.zeroSkillMc,
    perStation: [...r.perStation.entries()].map(([station, s]) => ({ station, ...s })),
    restVsMid: r.restVsMid,
    coverage: r.coverage,
  };
}

// =====================================================================================
// SELF-TEST + CLI
// =====================================================================================

/** A db1-style self-test: the CLI token parsers + the eligibility/verdict wiring on a synthetic bid. */
function sanity(): void {
  // CLI token mapping (Pass-1 L1)
  if (parseRestRule('bid+tick') !== 'bid_plus_tick') throw new Error('sanity: parseRestRule bid+tick');
  if (parseRestRule('ask-offset') !== 'ask_offset') throw new Error('sanity: parseRestRule ask-offset');
  if (parseRestRule(undefined) !== 'bid') throw new Error('sanity: parseRestRule default');
  if (parseFillModel('last-trade') !== 'last_trade') throw new Error('sanity: parseFillModel last-trade');
  if (parseFillModel(undefined) !== 'ask_touch') throw new Error('sanity: parseFillModel default');

  // a synthetic resting bid that MUST fill (ask collapses to the bid) and resolves a loser → AS shape.
  const baseTs = 1_700_000_000;
  const bid: RestingBid = {
    conditionId: 'EV',
    bucketIdx: 0,
    calibratedP: 0.1,
    marketProbAtEntry: 0.2,
    bucketWon: false,
    feeRate: 0.05,
    tickSize: 0.01,
    citySlug: 'ams',
    station: 'EHAM',
    tzOffsetHours: 2,
    targetDate: '2026-05-20',
    resolutionTs: baseTs + 3600,
    entryTs: baseTs,
    snapshots: [
      { capturedAt: baseTs, bid: 0.1, ask: 0.2, mid: 0.15, lastTrade: 0.18 },
      { capturedAt: baseTs + 600, bid: 0.08, ask: 0.1, mid: 0.09, lastTrade: 0.1 }, // ask touches 0.10 = restPx
    ],
  };
  const rep = simulateSpray([bid], {
    rule: 'bid',
    fillModel: 'ask_touch',
    cheapMax: 0.25,
    rebate: 0,
    mcIters: 50,
    bootstrapSeed: 42,
  });
  if (rep.nCheapEligible !== 1) throw new Error(`sanity: expected 1 cheap-eligible, got ${rep.nCheapEligible}`);
  if (rep.nFilled !== 1) throw new Error(`sanity: rested bid at 0.10 should fill (ask touched 0.10)`);
  const v = makerSprayVerdict(rep, { marginThreshold: 0.02 });
  // a single losing filled bet → fee-net EV is −1−fee; the CI cannot clear 0 → FAIL.
  if (v.pass) throw new Error('sanity: a single losing filled bid must FAIL the verdict');

  // determinism: two sprays are byte-identical
  const a = simulateSpray([bid], { rule: 'bid', fillModel: 'ask_touch', mcIters: 50, bootstrapSeed: 42 });
  const b = simulateSpray([bid], { rule: 'bid', fillModel: 'ask_touch', mcIters: 50, bootstrapSeed: 42 });
  if (a.filledNetEv.ev !== b.filledNetEv.ev || a.zeroSkillMc.pPass !== b.zeroSkillMc.pPass) {
    throw new Error('sanity: simulateSpray is not deterministic');
  }

  // cross-val on an empty input is total
  const cv = crossValidateFillModel([], 'ask_touch');
  if (cv.n !== 0 || Number.isFinite(cv.agreementRate)) throw new Error('sanity: empty cross-val must be {NaN,0}');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      leads: { type: 'string' },
      stations: { type: 'string' },
      'rest-at': { type: 'string' },
      select: { type: 'string' },
      'ask-offset': { type: 'string' },
      'fill-model': { type: 'string' },
      'entry-lead-h': { type: 'string' },
      'lookback-days': { type: 'string' },
      'cheap-max': { type: 'string' },
      'maker-rebate': { type: 'string' },
      'rebate-rate': { type: 'string' },
      margin: { type: 'string' },
      'mc-iters': { type: 'string' },
      'cross-val': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: MakerSprayArgs = {
      from: values.from ?? '2026-04-21',
      to: values.to ?? '2026-06-21',
      leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
      stations: splitList(values.stations),
      restRule: parseRestRule(values['rest-at']),
      fillModel: parseFillModel(values['fill-model']),
      select: parseSelect(values.select),
      askOffset: values['ask-offset'] ? Number(values['ask-offset']) : 0.07,
      entryLeadHours: (splitList(values['entry-lead-h']) ?? ['24']).map(Number),
      lookbackDays: values['lookback-days'] ? Number(values['lookback-days']) : 3,
      cheapMax: values['cheap-max'] ? Number(values['cheap-max']) : 0.25,
      makerRebate: values['maker-rebate'] ? Number(values['maker-rebate']) : 0,
      rebateRate: values['rebate-rate'] ? Number(values['rebate-rate']) : 0,
      margin: values.margin ? Number(values.margin) : 0.02,
      mcIters: values['mc-iters'] ? Number(values['mc-iters']) : 1000,
      crossVal: Boolean(values['cross-val']),
      json: Boolean(values.json),
    };
    const res = await run(args, { db, log: console.log });
    report(res, console.log);
  } finally {
    await db.end();
  }
}
