/**
 * scripts/research/db1-daybefore-efficiency — Build #3 (WALLET-RECON-HANDOFF.md §6).
 *
 * THE QUESTION: our Amsterdam sim only tested SAME-DAY entry; the badatmath sharp earns the
 * DAY BEFORE. Does our EMOS-calibrated NEXT-DAY cheap modal bucket (<0.25), entered the day
 * before, BEAT the day-before market ask?
 *   H1: day-before betting our calibrated <0.25 bucket is +EV vs the day-before ask.
 *   H0 (PRIOR, likely per WO-5): market ask >= our prob day-before too → edge straddles 0,
 *       market EFFICIENT. A clean efficiency measurement IS the deliverable.
 *
 * POSTURE: analytics study, NOT a trading green-light. Ships nothing to prod. Honors the
 * PRE-REGISTERED kill-criterion (edge CI clears 0 on <0.25, >= +1.5pp, multi-station, all
 * leads, not EHAM-only, survives fees) — do NOT move it to fit a result (WO-5 discipline).
 *
 * METHOD (read-only; forks the mos-pointskill loaders — the shared harness is NOT edited):
 *  1) WALK-FORWARD EMOS per (station, lead): per build-day, per model: correctPoint(f, EMA_bias);
 *     inverse-MSE blend (computeModelWeights over the trailing window) = the LIVE baseline blended
 *     μ (°C). σ = fitSigma over the trailing window of blended corrected-forecast residuals. Then
 *     gaussianBucketProbs(μ, σ, ladder) in the EVENT's native unit = our calibrated bucket probs.
 *  2) DAY-BEFORE MARKET ASK: per resolved bucket market, the last best_ask per bucket in the
 *     UTC [target_date−1, target_date) window from market_snapshots (the forward-capture-audit SQL;
 *     audit confirmed dense day-before coverage). Market-implied prob = day-before ask.
 *  3) EDGE per bucket = calibratedP − ask. Entries (badatmath-style): the modal bucket AND any
 *     bucket with calibratedP > ask AND ask < 0.25 (the cheap-longshot rule). placeSimBet /
 *     gradeSimBet against winning_bucket_idx.
 *  4) SCORE per arm / station / lead with armEdgeStats (mean edge ± CI = PRIMARY METRIC; EV/$1;
 *     hit rate) + Brier(ours) vs Brier(market) + pairedBootstrapPValue on per-event Brier diff.
 *     The <0.25 SUBSET is broken out specifically (the kill-criterion lives there).
 *  5) FORK-CORRECTNESS: an internal blend-μ RMSE accumulator over the same window; compare to the
 *     mos-pointskill baseline. (The FORECASTING-RD doc's 1.5657°C / 8,775-build snapshot predates
 *     subsequent backfill growth; the live equality check below is the robust correctness contract.)
 *
 * Run: pnpm tsx scripts/research/db1-daybefore-efficiency.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--leads 1,2] [--stations EHAM,EGLC] [--json] [--min-bets 5]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  computeModelWeights,
  correctPoint,
  fitSigma,
  fToC,
  gaussianBucketProbs,
  parseConfigRows,
  toNative,
  updateBias,
  type AppConfig,
  type BucketDef,
} from '../../packages/core/src/index.ts';
import {
  gradeSimBet,
  type SimLadderBucket,
  type SimPlacement,
} from '../../packages/core/src/sim/amsterdam.ts';
import { armEdgeStats, type GradedBet } from '../../packages/core/src/sim/stats.ts';
import { brierScore, pairedBootstrapPValue } from '../../packages/core/src/calibration/scores.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'db1-daybefore-efficiency';

// =====================================================================================
// PURE HELPERS (unit-tested in db1-daybefore-efficiency.test.ts)
// =====================================================================================

export const CHEAP_LONGSHOT_MAX_ASK = 0.25;

/** A bucket the study scores: our calibrated prob, the day-before ask, and whether it resolved. */
export interface BucketView {
  bucketIdx: number;
  /** Our EMOS calibrated probability for this bucket (Σ over buckets = 1). */
  calibratedP: number;
  /** Day-before market ask in (0,1], or null when no day-before quote exists. */
  ask: number | null;
  /** True iff this is the resolved winning bucket. */
  isWinner: boolean;
}

/** Which arm a graded bet belongs to. */
export type Arm = 'modal' | 'cheap_longshot';

/** A selected entry ready to grade — carries the arm + whether it falls in the <0.25 subset. */
export interface SelectedEntry {
  arm: Arm;
  bucketIdx: number;
  calibratedP: number;
  ask: number;
  isWinner: boolean;
  /** ask < CHEAP_LONGSHOT_MAX_ASK — the subset the kill-criterion is evaluated on. */
  inCheapSubset: boolean;
}

/**
 * The badatmath-style entry-selection rule for one event's bucket views:
 *   - the MODAL bucket (argmax calibratedP), if it has a usable day-before ask;
 *   - any bucket with calibratedP > ask AND ask < 0.25 (the cheap-longshot rule).
 * The modal bucket may ALSO qualify as a cheap longshot — it is emitted under BOTH arms
 * (each arm is scored independently), so a cheap modal bucket counts in both. Buckets with
 * no usable ask (null / ≤0 / >1) are never selectable. Deterministic, side-effect-free.
 */
export function selectEntries(views: BucketView[]): SelectedEntry[] {
  const out: SelectedEntry[] = [];
  const usable = (a: number | null): a is number => a != null && Number.isFinite(a) && a > 0 && a <= 1;

  // modal = argmax calibratedP (first on ties, matching argmax convention)
  let modalIdx = -1;
  let modalP = -Infinity;
  for (const v of views) {
    if (v.calibratedP > modalP) {
      modalP = v.calibratedP;
      modalIdx = v.bucketIdx;
    }
  }

  for (const v of views) {
    if (!usable(v.ask)) continue;
    const ask = v.ask;
    const inCheapSubset = ask < CHEAP_LONGSHOT_MAX_ASK;
    if (v.bucketIdx === modalIdx) {
      out.push({ arm: 'modal', bucketIdx: v.bucketIdx, calibratedP: v.calibratedP, ask, isWinner: v.isWinner, inCheapSubset });
    }
    if (v.calibratedP > ask && inCheapSubset) {
      out.push({ arm: 'cheap_longshot', bucketIdx: v.bucketIdx, calibratedP: v.calibratedP, ask, isWinner: v.isWinner, inCheapSubset });
    }
  }
  return out;
}

/** edge = calibratedP − ask (the primary metric, per bucket). */
export function bucketEdge(calibratedP: number, ask: number): number {
  return calibratedP - ask;
}

/**
 * Market-implied bucket distribution from the day-before asks: ask per bucket renormalized to Σ=1
 * over the buckets that HAVE an ask (the others are treated as absent, not zero-prob — a missing
 * quote is missing data). Used only for the market Brier; returns null when there are no asks at all OR
 * the WINNER bucket has no ask — in which case the event is dropped from the paired Brier comparison
 * (scoring it would hand the market a guaranteed P(winner)=0 → a +1 Brier penalty on the very outcome that
 * resolved, silently biasing the comparison toward "ours sharper").
 */
export function marketImpliedProbs(views: BucketView[], winnerPos: number): number[] | null {
  const asks = views.map((v) => (v.ask != null && Number.isFinite(v.ask) && v.ask > 0 ? v.ask : 0));
  const sum = asks.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  if (winnerPos < 0 || winnerPos >= asks.length || asks[winnerPos] === 0) return null; // winner unquoted → drop
  return asks.map((a) => a / sum);
}

// --- walk-forward EMOS state per (model, lead) — forked from mos-pointskill StationModel ----

interface ModelWindow {
  bias: number | null;
  fs: number[]; // trailing forecasts (°C), capped at sigmaWindowDays
  os: number[]; // trailing observations (°C), aligned
}

/**
 * Per-station EMOS engine: per (model, lead) trailing-window bias + residual store, producing the
 * LIVE baseline blended μ (correctPoint per model + inverse-MSE blend) and σ (fitSigma over the
 * blended corrected-forecast residual window). Mirrors the live calibration path so the fork is
 * the live model, not a re-derivation.
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
    // record blended residual BEFORE updating windows (so σ reflects info available at decision time
    // would be ideal, but the live fold updates after scoring; we fold after scoring in the walk).
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
// EXPERIMENT
// =====================================================================================

export interface Db1Args {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
  /** Skip a (station,lead) cell from the per-station readout when it has fewer than this many graded bets. */
  minBets: number;
  json: boolean;
}

interface ArmAcc {
  bets: GradedBet[]; // all graded bets for this arm
  cheap: GradedBet[]; // the ask<0.25 subset
}
const emptyArm = (): ArmAcc => ({ bets: [], cheap: [] });

interface BrierAcc {
  ours: number[]; // per-event Brier(ours)
  market: number[]; // per-event Brier(market), aligned by event
}

interface Cell {
  modal: ArmAcc;
  cheap_longshot: ArmAcc;
  brier: BrierAcc;
}
const emptyCell = (): Cell => ({ modal: emptyArm(), cheap_longshot: emptyArm(), brier: { ours: [], market: [] } });

const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

interface EventRow {
  eventId: string;
  icao: string;
  citySlug: string;
  region: string;
  targetDate: string;
  unit: 'C' | 'F';
  winnerIdx: number;
  feeRate: number;
  ladder: SimLadderBucket[];
  bucketDefs: BucketDef[];
  /** day-before ask per bucketIdx (null when no quote). */
  asks: Map<number, number | null>;
}

export interface Db1Result {
  forkRmse: number;
  forkN: number;
  overall: Map<number, Cell>; // keyed by lead
  perStation: Map<string, Map<number, Cell>>; // station → lead → cell
  perLead: Map<number, Cell>;
  /** Pooled cheap-subset modal+longshot edge across all leads/stations, for the headline kill-check. */
  pooledCheap: GradedBet[];
  nStations: number;
  nEvents: number;
  stationsWithPositiveCheapEdge: string[];
  ehamCheap: GradedBet[];
  nonEhamCheap: GradedBet[];
}

export interface Db1Deps {
  db: Db;
  log: (msg: string) => void;
}

export async function runDb1(args: Db1Args, deps: Db1Deps): Promise<Db1Result> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));

  // --- scope: stations with finalized obs (mirror mos-pointskill) ---
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

  // --- forecasts (backfill slot), exactly the mos-pointskill loader ---
  const fRows = await db.query<{ icao: string; model: string; target_date: string | Date; lead_days: number; tmax_c: string }>(
    `select icao, model, target_date, lead_days, tmax_c
     from forecast_snapshots
     where snapshot_slot = 'backfill' and icao = any($1) and lead_days = any($2) and target_date <= $3`,
    [icaos, args.leads, args.to],
  );
  // icao → targetISO → lead → model → tmaxC(°C)
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

  // --- finalized observations → °C (the mos-pointskill loader) ---
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
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

  // --- resolved bucket markets + their ladders + day-before asks ---
  const evRows = await db.query<{
    event_id: string; icao: string | null; city_slug: string; region: string; target_date: string | Date;
    unit: 'C' | 'F'; winning_bucket_idx: number; fee_rate: string | null;
  }>(
    `select me.id event_id, me.icao_at_creation icao, c.slug city_slug, c.region, me.target_date,
            me.unit, me.winning_bucket_idx, me.unit,
            (select max(mb.fee_rate) from market_buckets mb where mb.event_id = me.id) fee_rate
     from market_events me
     join cities c on c.id = me.city_id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );

  // ladders per event
  const bRows = await db.query<{ event_id: string; bucket_idx: number; low_native: number | null; high_native: number | null }>(
    `select mb.event_id, mb.bucket_idx, mb.low_native, mb.high_native
     from market_buckets mb
     join market_events me on me.id = mb.event_id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3
     order by mb.event_id, mb.bucket_idx`,
    [icaos, args.from, args.to],
  );
  const laddersByEvent = new Map<string, SimLadderBucket[]>();
  for (const r of bRows) {
    const arr = laddersByEvent.get(r.event_id) ?? [];
    arr.push({ bucketIdx: r.bucket_idx, low: r.low_native, high: r.high_native });
    laddersByEvent.set(r.event_id, arr);
  }

  // day-before ask per bucket: last best_ask in the UTC [target_date-1, target_date) window
  // (the forward-capture-audit SQL). One row per (event_id, bucket_idx).
  const askRows = await db.query<{ event_id: string; bucket_idx: number; day_before_ask: string | null }>(
    `select me.id event_id, mb.bucket_idx,
            (select ms.best_ask from market_snapshots ms
               where ms.bucket_id = mb.id
                 and ms.captured_at >= (me.target_date - 1)::timestamptz
                 and ms.captured_at <  (me.target_date)::timestamptz
                 and ms.best_ask is not null
               order by ms.captured_at desc limit 1) day_before_ask
     from market_events me
     join market_buckets mb on mb.event_id = me.id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );
  const asksByEvent = new Map<string, Map<number, number | null>>();
  for (const r of askRows) {
    const m = asksByEvent.get(r.event_id) ?? new Map<number, number | null>();
    m.set(r.bucket_idx, r.day_before_ask == null ? null : Number(r.day_before_ask));
    asksByEvent.set(r.event_id, m);
  }

  // assemble event rows
  const events: EventRow[] = [];
  for (const r of evRows) {
    if (!r.icao) continue;
    const ladder = laddersByEvent.get(r.event_id);
    if (!ladder || ladder.length < 2) continue;
    events.push({
      eventId: r.event_id,
      icao: r.icao,
      citySlug: r.city_slug,
      region: r.region,
      targetDate: dISO(r.target_date),
      unit: r.unit,
      winnerIdx: r.winning_bucket_idx,
      feeRate: r.fee_rate == null ? 0 : Number(r.fee_rate),
      ladder,
      bucketDefs: ladder.map((b) => ({ low: b.low, high: b.high, unit: r.unit })),
      asks: asksByEvent.get(r.event_id) ?? new Map(),
    });
  }
  // index events by (icao, targetDate)
  const eventByKey = new Map<string, EventRow>();
  for (const e of events) eventByKey.set(`${e.icao}|${e.targetDate}`, e);

  // --- walk-forward EMOS, scoring events on each build day ---
  const stateByIcao = new Map(icaos.map((i) => [i, new EmosStation(cfg)]));
  const leadSet = new Set(args.leads);

  const overall = new Map<number, Cell>();
  const perLead = new Map<number, Cell>();
  const perStation = new Map<string, Map<number, Cell>>();
  const cellOf = (m: Map<number, Cell>, lead: number): Cell => {
    let c = m.get(lead);
    if (!c) { c = emptyCell(); m.set(lead, c); }
    return c;
  };
  const stationCell = (icao: string, lead: number): Cell => {
    let byLead = perStation.get(icao);
    if (!byLead) { byLead = new Map(); perStation.set(icao, byLead); }
    return cellOf(byLead, lead);
  };

  // fork-correctness: blended-μ RMSE accumulator (point error °C, the mos-pointskill baseline)
  let forkSe = 0;
  let forkN = 0;

  const pooledCheap: GradedBet[] = [];
  const ehamCheap: GradedBet[] = [];
  const nonEhamCheap: GradedBet[] = [];
  const stationCheapBets = new Map<string, GradedBet[]>();
  const seenEvents = new Set<string>();

  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);

  const foldDay = (icao: string, t: string): void => {
    const o = obs.get(icao)?.get(t);
    const byLeadMap = fc.get(icao)?.get(t);
    if (o === undefined || !byLeadMap) return;
    const sm = stateByIcao.get(icao)!;
    for (const [lead, byModel] of byLeadMap) {
      if (!leadSet.has(lead)) continue;
      sm.fold([...byModel].map(([model, f]) => ({ model, f })), lead, o);
    }
  };

  // warm-up: fold everything strictly before `from`
  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldDay(icao, t);

  for (const d of listDatesISO(args.from, args.to)) {
    for (const icao of icaos) {
      const o = obs.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) continue;
      const sm = stateByIcao.get(icao)!;
      const ev = eventByKey.get(`${icao}|${d}`);
      for (const [lead, byModel] of byLeadMap) {
        if (!leadSet.has(lead)) continue;
        const points = [...byModel].map(([model, f]) => ({ model, f }));
        if (points.length === 0) continue;

        const mu = sm.blendedMu(points, lead); // °C
        if (mu == null || !Number.isFinite(mu)) continue;

        // fork-correctness: point RMSE of the blended μ vs obs (the live baseline metric)
        forkSe += (mu - o) ** 2;
        forkN++;

        if (!ev) continue; // no resolved bucket market for this (station, day) — only the RMSE uses it

        const sigmaC = sm.sigma(lead);
        if (sigmaC == null || !Number.isFinite(sigmaC)) continue;

        // convert μ/σ to the event's native unit; bucketize the calibrated distribution
        const muNative = toNative(mu, ev.unit);
        const sigmaNative = ev.unit === 'F' ? sigmaC * (9 / 5) : sigmaC;
        if (sigmaNative <= 0.2) continue; // gaussianBucketProbs would refuse
        let probs: number[];
        try {
          probs = gaussianBucketProbs(muNative, sigmaNative, ev.bucketDefs);
        } catch {
          continue;
        }

        // build the per-bucket views (calibratedP, day-before ask, winner flag)
        const views: BucketView[] = ev.ladder.map((b, i) => ({
          bucketIdx: b.bucketIdx,
          calibratedP: probs[i]!,
          ask: ev.asks.get(b.bucketIdx) ?? null,
          isWinner: b.bucketIdx === ev.winnerIdx,
        }));

        const winnerPos = ev.ladder.findIndex((b) => b.bucketIdx === ev.winnerIdx);
        if (winnerPos < 0) continue;

        // --- Brier(ours) vs Brier(market), accumulated under the SCORED lead; dedupe per (event,lead) ---
        const ekey = `${ev.eventId}|${lead}`;
        if (!seenEvents.has(ekey)) {
          seenEvents.add(ekey);
          const mImplied = marketImpliedProbs(views, winnerPos);
          if (mImplied) {
            const bo = brierScore(probs, winnerPos);
            const bm = brierScore(mImplied, winnerPos);
            for (const c of [cellOf(overall, lead), cellOf(perLead, lead), stationCell(icao, lead)]) {
              c.brier.ours.push(bo);
              c.brier.market.push(bm);
            }
          }
        }

        // --- entry selection + grading ---
        const entries = selectEntries(views);
        for (const e of entries) {
          // Build the placement directly from the selected bucket. placeSimBet derives the bucket from a
          // running-max basis (the same-day sim's input) which we don't have here — the day-before study
          // KNOWS the bucket it is pricing — so we assemble the SimPlacement on that bucket and grade it
          // with the same gradeSimBet P&L math (shares = stake/ask; win → shares·(1−ask); both net of fee).
          const stakeUsd = 10;
          const placement: SimPlacement = {
            predictedNativeC: 0, // unused by gradeSimBet — bucketIdx carries the decision
            bucketIdx: e.bucketIdx,
            ask: e.ask,
            stakeUsd,
            shares: stakeUsd / e.ask,
            feeRate: ev.feeRate,
          };
          const grade = gradeSimBet(placement, ev.winnerIdx);
          const bet: GradedBet = { won: grade.won, ask: e.ask };

          for (const c of [cellOf(overall, lead), cellOf(perLead, lead), stationCell(icao, lead)]) {
            c[e.arm].bets.push(bet);
            if (e.inCheapSubset) c[e.arm].cheap.push(bet);
          }
          if (e.inCheapSubset) {
            pooledCheap.push(bet);
            (icao === 'EHAM' ? ehamCheap : nonEhamCheap).push(bet);
            const sb = stationCheapBets.get(icao) ?? [];
            sb.push(bet);
            stationCheapBets.set(icao, sb);
          }
        }
      }
    }
    for (const icao of icaos) foldDay(icao, d);
  }

  // stations with a CI-clears-0 positive cheap edge (modal+longshot pooled per station)
  const stationsWithPositiveCheapEdge: string[] = [];
  for (const [icao, bets] of stationCheapBets) {
    const s = armEdgeStats(bets);
    if (s.nGraded >= 5 && s.edgeCiLo > 0) stationsWithPositiveCheapEdge.push(icao);
  }

  return {
    forkRmse: Math.sqrt(forkSe / Math.max(1, forkN)),
    forkN,
    overall,
    perStation,
    perLead,
    pooledCheap,
    nStations: new Set(events.map((e) => e.icao)).size,
    nEvents: events.length,
    stationsWithPositiveCheapEdge,
    ehamCheap,
    nonEhamCheap,
  };
}

// =====================================================================================
// REPORT
// =====================================================================================

const f4 = (x: number): string => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
const pp = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' : 'n/a');

function edgeLine(label: string, bets: GradedBet[]): string {
  const s = armEdgeStats(bets);
  return `${label.padEnd(22)} n=${String(s.nGraded).padStart(5)}  edge ${pp(s.edge)} [${pp(s.edgeCiLo)}, ${pp(s.edgeCiHi)}]  EV/$1 ${f4(s.ev)}  hit ${f4(s.hitRate)}`;
}

/**
 * Paired-bootstrap p that OURS is reliably sharper (lower Brier) than the market. Repo-wide convention is
 * (candidate − reference) fed to pairedBootstrapPValue (fraction of resample means ≥ 0): Brier is a LOSS, so
 * ours sharper ⇒ ours − market negative ⇒ SMALL p. (The pre-fix wiring passed market − ours, inverting it —
 * p(ours sharper) read ~0 exactly when the MARKET was sharper.) Exported so the sign convention is pinned by a test.
 */
export function brierSharperP(ours: number[], market: number[]): number {
  return pairedBootstrapPValue(ours.map((x, i) => x - market[i]!));
}

function brierLine(label: string, b: BrierAcc): string {
  const n = b.ours.length;
  const mo = n ? b.ours.reduce((a, x) => a + x, 0) / n : NaN;
  const mm = n ? b.market.reduce((a, x) => a + x, 0) / n : NaN;
  const p = brierSharperP(b.ours, b.market);
  return `${label.padEnd(22)} nEv=${String(n).padStart(4)}  Brier ours ${f4(mo)} market ${f4(mm)} diff(ours−mkt) ${f4(mo - mm)}  p(ours sharper) ${f4(p)}`;
}

export function report(res: Db1Result, args: Db1Args, log: (m: string) => void): void {
  log(`=== db1-daybefore-efficiency ${args.from} → ${args.to} · leads ${args.leads.join(',')} ===`);
  log(`scope: ${res.nStations} stations · ${res.nEvents} resolved bucket events with a day-before market`);
  log('');
  log(`FORK-CORRECTNESS: blended-μ point RMSE ${f4(res.forkRmse)}°C over ${res.forkN} build-days`);
  log('  (compare to mos-pointskill baseline for the same window; the FORECASTING-RD 1.5657°C/8,775-build');
  log('   snapshot predates later backfill growth — the live equality vs mos-pointskill is the real check.)');
  log('');
  log('PRIMARY METRIC — mean edge (calibratedP − ask) ± 95% CI on the <0.25 CHEAP-LONGSHOT subset:');
  log('  ' + edgeLine('POOLED cheap (all)', res.pooledCheap));
  log('  ' + edgeLine('  EHAM-only cheap', res.ehamCheap));
  log('  ' + edgeLine('  non-EHAM cheap', res.nonEhamCheap));
  log('');
  log('PER-LEAD (cheap <0.25 subset, modal arm / cheap_longshot arm):');
  for (const lead of [...res.perLead.keys()].sort((a, b) => a - b)) {
    const c = res.perLead.get(lead)!;
    log('  ' + edgeLine(`lead ${lead} modal`, c.modal.cheap));
    log('  ' + edgeLine(`lead ${lead} longshot`, c.cheap_longshot.cheap));
    log('  ' + brierLine(`lead ${lead} Brier`, c.brier));
  }
  log('');
  log('PER-STATION (cheap <0.25 pooled modal+longshot; cells with < minBets omitted):');
  for (const icao of [...res.perStation.keys()].sort()) {
    const byLead = res.perStation.get(icao)!;
    const cheap: GradedBet[] = [];
    for (const c of byLead.values()) cheap.push(...c.modal.cheap, ...c.cheap_longshot.cheap);
    if (cheap.length < args.minBets) continue;
    log('  ' + edgeLine(icao, cheap));
  }
  log('');
  log(`stations with CI-clears-0 positive cheap edge: ${res.stationsWithPositiveCheapEdge.length}` +
    (res.stationsWithPositiveCheapEdge.length ? ` (${res.stationsWithPositiveCheapEdge.join(', ')})` : ''));

  // kill-criterion self-assessment
  const pooled = armEdgeStats(res.pooledCheap);
  const eham = armEdgeStats(res.ehamCheap);
  const nonEham = armEdgeStats(res.nonEhamCheap);
  const ehamOnly = eham.nGraded > 0 && eham.edge > 0 && (nonEham.nGraded === 0 || nonEham.edge <= 0);
  const edgePp = pooled.edge * 100;
  const ciClears = pooled.edgeCiLo > 0;
  const meets = ciClears && edgePp >= 1.5 && res.nStations >= 2 && !ehamOnly &&
    res.stationsWithPositiveCheapEdge.length >= 2;
  log('');
  log('KILL-CRITERION (pre-registered; >=+1.5pp, CI clears 0 on <0.25, multi-station, all leads, not EHAM-only):');
  log(`  pooled cheap edge ${pp(pooled.edge)} CI [${pp(pooled.edgeCiLo)}, ${pp(pooled.edgeCiHi)}]  → CI clears 0: ${ciClears}; >=1.5pp: ${edgePp >= 1.5}`);
  log(`  multi-station: ${res.nStations >= 2}; EHAM-only: ${ehamOnly}; stations w/ +edge: ${res.stationsWithPositiveCheapEdge.length}`);
  log(`  VERDICT: ${meets ? 'KILL-CRITERION MET — proceed (adversarial re-verify required)' : 'NOT MET — day-before market EFFICIENT; publish efficiency measurement, live rail stays dormant'}`);

  if (args.json) {
    const out = {
      forkRmse: res.forkRmse,
      pooledCheap: pooled,
      ehamCheap: eham,
      nonEhamCheap: nonEham,
      perLead: [...res.perLead.entries()].map(([lead, c]) => ({
        lead,
        modalCheap: armEdgeStats(c.modal.cheap),
        longshotCheap: armEdgeStats(c.cheap_longshot.cheap),
        brierOurs: c.brier.ours.length ? c.brier.ours.reduce((a, x) => a + x, 0) / c.brier.ours.length : null,
        brierMarket: c.brier.market.length ? c.brier.market.reduce((a, x) => a + x, 0) / c.brier.market.length : null,
        nEvents: c.brier.ours.length,
      })),
      perStationCheap: [...res.perStation.entries()].map(([icao, byLead]) => {
        const cheap: GradedBet[] = [];
        for (const c of byLead.values()) cheap.push(...c.modal.cheap, ...c.cheap_longshot.cheap);
        return { icao, ...armEdgeStats(cheap) };
      }),
      nStations: res.nStations,
      nEvents: res.nEvents,
      stationsWithPositiveCheapEdge: res.stationsWithPositiveCheapEdge,
      ehamOnly,
      killCriterionMet: meets,
    };
    log('JSON ' + JSON.stringify(out));
  }
}

// =====================================================================================
// SELF-TEST + CLI
// =====================================================================================

function sanity(): void {
  // selectEntries: modal + cheap-longshot rule
  const views: BucketView[] = [
    { bucketIdx: 0, calibratedP: 0.05, ask: 0.02, isWinner: false }, // cheap, p>ask → longshot
    { bucketIdx: 1, calibratedP: 0.60, ask: 0.55, isWinner: true }, // modal (argmax), ask>=0.25 → modal only
    { bucketIdx: 2, calibratedP: 0.10, ask: 0.30, isWinner: false }, // p<ask, ask>=0.25 → nothing
    { bucketIdx: 3, calibratedP: 0.20, ask: 0.10, isWinner: false }, // cheap, p>ask → longshot
  ];
  const sel = selectEntries(views);
  const modal = sel.filter((s) => s.arm === 'modal');
  const longs = sel.filter((s) => s.arm === 'cheap_longshot');
  if (modal.length !== 1 || modal[0]!.bucketIdx !== 1) throw new Error(`sanity: modal selection wrong: ${JSON.stringify(modal)}`);
  if (longs.length !== 2 || !longs.every((l) => l.inCheapSubset)) throw new Error(`sanity: longshot selection wrong: ${JSON.stringify(longs)}`);
  // bucketEdge
  if (Math.abs(bucketEdge(0.3, 0.2) - 0.1) > 1e-12) throw new Error('sanity: bucketEdge wrong');
  // marketImpliedProbs renormalizes (winner = idx 1, which has an ask → not dropped)
  const mip = marketImpliedProbs(views, 1)!;
  const sum = mip.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`sanity: marketImpliedProbs not normalized: ${sum}`);
  // winner bucket with no day-before ask ⇒ event dropped from the paired Brier (honor the docstring contract)
  const noWinnerAsk: BucketView[] = [
    { bucketIdx: 0, calibratedP: 0.5, ask: 0.40, isWinner: false },
    { bucketIdx: 1, calibratedP: 0.5, ask: null, isWinner: true }, // winner unquoted
  ];
  if (marketImpliedProbs(noWinnerAsk, 1) !== null) throw new Error('sanity: winner-no-ask event must be dropped');
  // a cheap modal bucket appears under BOTH arms
  const both: BucketView[] = [
    { bucketIdx: 0, calibratedP: 0.5, ask: 0.10, isWinner: true }, // modal AND cheap (p>ask, ask<0.25)
    { bucketIdx: 1, calibratedP: 0.5, ask: 0.90, isWinner: false }, // tie on p but higher idx; modal is idx 0
  ];
  const sel2 = selectEntries(both);
  if (!sel2.some((s) => s.arm === 'modal' && s.bucketIdx === 0) || !sel2.some((s) => s.arm === 'cheap_longshot' && s.bucketIdx === 0)) {
    throw new Error('sanity: cheap modal bucket must appear under both arms');
  }
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
      'min-bets': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: Db1Args = {
      from: values.from ?? '2026-04-21', // bucket markets launched ~2026-04-21
      to: values.to ?? '2026-06-21',
      leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
      stations: splitList(values.stations),
      minBets: values['min-bets'] ? Number(values['min-bets']) : 5,
      json: Boolean(values.json),
    };
    const res = await runDb1(args, { db, log: console.log });
    report(res, args, console.log);
  } finally {
    await db.end();
  }
}
