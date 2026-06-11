/**
 * scripts/simulate-historical-edge — walk-forward replay over backfilled data
 * (§6.22, ADR-16, C2/C7).
 *
 * Day by day over [from, to]: fit stats ONLY on data observable before each
 * ADR-16 cutoff (updateBias / fitSigma / computeModelWeights in-process over
 * the 'backfill'-slot forecast_snapshots vs finalized observations) → build
 * the house distribution per event at cutoff(L) = startUtc − L·24h → score vs
 * actuals (winningBucket) and TIME-MATCH against the backfilled
 * market_consensus rows at the same cutoffs (pairs only where BOTH exist —
 * C7) → where lead-0 market history exists: computeBucketEdges over a
 * consensus-as-price proxy + joint Kelly with fee-adjusted effective prices
 * (exactly the §6.17 pipeline) → simulated P&L, equity curve, drawdown, hit
 * rate by edge decile → writes calibration_scores (window_tag 'backtest') +
 * CSV + console fidelity report.
 *
 * INFORMATION DISCIPLINE (the no-peeking contract, §15):
 * - The live system folds truth at run-calibration's daily 11:30Z cycle, so a
 *   build scored for lead L of day D carries stats folded through target
 *   D−L−2. The walk reproduces that horizon exactly: for each day D it builds
 *   lead 1 (stats ≤ D−3), THEN folds target D−2, THEN builds lead 0
 *   (stats ≤ D−2). Forecast inputs at cutoff(L) are the lead-column L+1 rows
 *   (captured T12Z notional on D−L−1, the freshest snapshot before the
 *   cutoff). Consensus rows were synthesized at pre-cutoff timestamps only
 *   (backfill-market-history, C2).
 *
 * HONEST-FIDELITY NOTE (printed on every run): the consensus-mid proxy is not
 * an executable book — no depth, no spread, no volume veto. Results are
 * indicative for GATING DIRECTION only, never a go-live justification.
 *
 * Run: pnpm tsx scripts/simulate-historical-edge.ts --from 2025-06-01 --to 2026-06-01
 *        [--source house_gaussian] [--stations RKSI,EGLL,KORD] [--out reports]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  applyKellyFraction,
  applyRiskCaps,
  brierScore,
  computeBucketEdges,
  computeModelWeights,
  correctPoint,
  ensembleStats,
  fToC,
  fitSigma,
  gaussianBucketProbs,
  jointKellyStakes,
  localDayWindow,
  takerFeePerShare,
  takerFeeTotal,
  toNative,
  updateBias,
  winningBucket,
  type AppConfig,
  type BucketDef,
  type NormalizedBook,
  type Unit,
} from '../packages/core/src/index.ts';
import { parseConfigRows } from '../packages/core/src/index.ts';
import { addDaysISO, listDatesISO, splitList, type Db } from './lib/backfill.ts';
import { makeScriptDb } from './lib/script-db.ts';

export const SCRIPT = 'simulate-historical-edge';
const SCORED_LEADS = [1, 0] as const;

export interface SimulateArgs {
  from: string;
  to: string;
  source?: string;
  stations?: string[];
  /** CSV output directory (created if missing). */
  out?: string;
}

export interface SimulateDeps {
  db: Db;
  log: (msg: string) => void;
}

export interface SimEval {
  date: string;
  lead: number;
  citySlug: string;
  eventId: string;
  muNative: number;
  sigmaNative: number;
  probs: number[];
  winnerIdx: number | null;
  brierHouse: number | null;
  brierMarket: number | null;
  consensusMadeAt: string | null;
  matched: boolean;
}

export interface SimBet {
  date: string;
  citySlug: string;
  bucketIdx: number;
  label: string;
  q: number;
  price: number;
  edge: number;
  stake: number;
  shares: number;
  fee: number;
  win: boolean;
  pnl: number;
}

export interface SimReport {
  evals: SimEval[];
  bets: SimBet[];
  equity: { date: string; balance: number }[];
  finalBankroll: number;
  maxDrawdownPct: number;
  fidelity: {
    citySlug: string;
    lead: number;
    n: number;
    brierHouse: number;
    brierMarket: number;
    ratio: number;
  }[];
  deciles: { decile: number; n: number; wins: number; hitRate: number; avgEdge: number; avgQ: number; pnl: number }[];
  counters: {
    events: number;
    evalsBuilt: number;
    matchedPairs: number;
    houseOnlyEvals: number;
    skippedNoForecasts: number;
    skippedNoObs: number;
    polyWinnerMismatches: number;
    betsPlaced: number;
    betsWon: number;
    scoresWritten: number;
  };
  csvPath: string | null;
}

interface EventRow {
  id: string;
  city_id: string;
  city_slug: string;
  region: string;
  tz: string;
  unit: Unit;
  target_date: string | Date;
  poly_resolved_winner_idx: number | null;
}

interface BucketRow {
  event_id: string;
  bucket_idx: number;
  label: string;
  low_native: number | null;
  high_native: number | null;
  fee_rate: string | null;
  min_order_size: string | null;
}

interface ForecastRow {
  icao: string;
  model: string;
  target_date: string | Date;
  lead_days: number;
  tmax_c: string;
}

interface ObsRow {
  icao: string;
  date_local: string | Date;
  tmax_wu_native: number;
  unit: Unit;
}

const dateISO = (d: string | Date): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** Per-(model|leadCol) raw-error fold state; σ/MSE recompute corrected residuals on read. */
interface ModelState {
  bias: number | null;
  rawErrors: number[];
}

class StationStats {
  readonly perModelLead = new Map<string, ModelState>();
  readonly blendResiduals = new Map<number, number[]>();

  constructor(private readonly cfg: AppConfig) {}

  private key(model: string, leadCol: number): string {
    return `${model}|${leadCol}`;
  }

  state(model: string, leadCol: number): ModelState {
    let s = this.perModelLead.get(this.key(model, leadCol));
    if (!s) {
      s = { bias: null, rawErrors: [] };
      this.perModelLead.set(this.key(model, leadCol), s);
    }
    return s;
  }

  /** Corrected residuals of the current window — correctPoint is THE bias-subtraction site (§15). */
  corrected(model: string, leadCol: number): number[] {
    const s = this.perModelLead.get(this.key(model, leadCol));
    if (!s) return [];
    const bias = s.bias ?? 0;
    return s.rawErrors.map((e) => correctPoint(e, bias));
  }

  /** Inverse-MSE weights over models with n ≥ sigmaMinN (run-calibration's qualification guard). */
  weights(models: string[], leadCol: number): Map<string, number> {
    const mse = new Map<string, number>();
    for (const m of models) {
      const res = this.corrected(m, leadCol);
      if (res.length >= this.cfg.sigmaMinN) {
        mse.set(m, res.reduce((a, r) => a + r * r, 0) / res.length);
      }
    }
    return computeModelWeights(mse);
  }

  /** Blend σ in °C for a lead column: fitted else prior ladder, floored (§6.16). */
  blendSigmaC(leadCol: number): number {
    const fitted = fitSigma(this.blendResiduals.get(leadCol) ?? [], this.cfg.sigmaMinN);
    const sigma = fitted?.sigma ?? this.cfg.priorSigmaByLead[Math.min(leadCol, 7)]!;
    return Math.max(sigma, this.cfg.sigmaFloorC);
  }

  /** Fold one target day's truth into the state (chronological, §6.18). */
  fold(forecastsByModelLead: Map<string, number>, obsC: number): void {
    // blend residual uses bias/weights AS OF this moment (pre-fold) — walk-forward honest.
    const byLead = new Map<number, { model: string; tmaxC: number }[]>();
    for (const [key, tmaxC] of forecastsByModelLead) {
      const [model, leadStr] = key.split('|') as [string, string];
      const leadCol = Number(leadStr);
      const list = byLead.get(leadCol) ?? [];
      list.push({ model, tmaxC });
      byLead.set(leadCol, list);
    }
    for (const [leadCol, list] of byLead) {
      const w = this.weights(list.map((x) => x.model), leadCol);
      const haveWeights = [...w.values()].some((v) => v > 0);
      let blend = 0;
      let wSum = 0;
      for (const { model, tmaxC } of list) {
        const bias = this.state(model, leadCol).bias ?? 0;
        const weight = haveWeights ? (w.get(model) ?? 0) : 1 / list.length;
        blend += weight * correctPoint(tmaxC, bias);
        wSum += weight;
      }
      if (wSum > 0) {
        const resid = blend / wSum - obsC;
        const win = this.blendResiduals.get(leadCol) ?? [];
        win.push(resid);
        if (win.length > this.cfg.sigmaWindowDays) win.shift();
        this.blendResiduals.set(leadCol, win);
      }
      // then fold each model's raw error
      for (const { model, tmaxC } of list) {
        const s = this.state(model, leadCol);
        const err = tmaxC - obsC;
        s.bias = updateBias(s.bias, err, this.cfg.biasAlpha);
        s.rawErrors.push(err);
        if (s.rawErrors.length > this.cfg.sigmaWindowDays) s.rawErrors.shift();
      }
    }
  }
}

/** One-level synthetic book from the consensus-as-price proxy (fidelity note applies). */
function proxyBook(price: number, probeStakeUsd: number): NormalizedBook {
  return {
    market: '', assetId: '', timestamp: 0, hash: '',
    bids: [], asks: [{ price, size: Math.ceil(probeStakeUsd / price) + 1 }],
    minOrderSize: 5, tickSize: 0.01, negRisk: true, lastTradePrice: null,
  };
}

export async function simulateHistoricalEdge(
  args: SimulateArgs,
  deps: SimulateDeps,
): Promise<SimReport> {
  const { db, log } = deps;
  const cfg = parseConfigRows(
    await db.query<{ key: string; value: string }>(`select key, value from config`),
  );
  const source = args.source ?? cfg.championSource;
  if (source !== 'house_gaussian') {
    // The previous-runs archive stores point forecasts only — there is no
    // historical ensemble-member record to replay (BUILD-STATE deviation).
    throw new Error(
      `simulate-historical-edge supports source 'house_gaussian' only (got '${source}'): ` +
        `the backfill archive has no ensemble members to replay`,
    );
  }

  // --- scope -------------------------------------------------------------------
  let stationRows = await db.query<{ icao: string; tz: string; city_id: string; city_slug: string; unit: Unit; region: string }>(
    `select s.icao, s.tz, c.id as city_id, c.slug as city_slug, c.unit, c.region
     from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null
     join cities c on c.id = cs.city_id`,
  );
  if (args.stations) {
    const wanted = new Set(args.stations.map((s) => s.toUpperCase()));
    stationRows = stationRows.filter((s) => wanted.has(s.icao.toUpperCase()));
  }
  const stationByCity = new Map(stationRows.map((s) => [s.city_id, s]));
  const icaos = stationRows.map((s) => s.icao);

  const events = (
    await db.query<EventRow>(
      `select me.id, me.city_id, c.slug as city_slug, c.region, c.tz, me.unit, me.target_date,
              me.poly_resolved_winner_idx
       from market_events me
       join cities c on c.id = me.city_id
       where me.ladder_ok and me.target_date between $1 and $2
       order by me.target_date`,
      [args.from, args.to],
    )
  ).filter((e) => stationByCity.has(e.city_id));
  const bucketRows = await db.query<BucketRow>(
    `select event_id, bucket_idx, label, low_native, high_native, fee_rate, min_order_size
     from market_buckets order by bucket_idx`,
  );
  const bucketsByEvent = new Map<string, BucketRow[]>();
  for (const b of bucketRows) {
    const list = bucketsByEvent.get(b.event_id) ?? [];
    list.push(b);
    bucketsByEvent.set(b.event_id, list);
  }

  // --- inputs ------------------------------------------------------------------
  const fRows =
    icaos.length === 0
      ? []
      : await db.query<ForecastRow>(
          `select icao, model, target_date, lead_days, tmax_c
           from forecast_snapshots
           where snapshot_slot = 'backfill' and icao = any($1) and target_date <= $2`,
          [icaos, args.to],
        );
  // byIcaoTarget: icao → targetISO → 'model|leadCol' → tmaxC
  const byIcaoTarget = new Map<string, Map<string, Map<string, number>>>();
  for (const f of fRows) {
    if (f.lead_days < 1) continue; // day-0 pseudo-truth rows are never build inputs (post-cutoff)
    const t = dateISO(f.target_date);
    const m1 = byIcaoTarget.get(f.icao) ?? new Map<string, Map<string, number>>();
    const m2 = m1.get(t) ?? new Map<string, number>();
    m2.set(`${f.model}|${f.lead_days}`, Number(f.tmax_c));
    m1.set(t, m2);
    byIcaoTarget.set(f.icao, m1);
  }

  const oRows =
    icaos.length === 0
      ? []
      : await db.query<ObsRow>(
          `select icao, date_local, tmax_wu_native, unit
           from observations
           where finalized_at is not null and icao = any($1) and date_local <= $2`,
          [icaos, args.to],
        );
  const obsByIcao = new Map<string, Map<string, { native: number; c: number }>>();
  for (const o of oRows) {
    const m = obsByIcao.get(o.icao) ?? new Map<string, { native: number; c: number }>();
    const native = Number(o.tmax_wu_native);
    m.set(dateISO(o.date_local), { native, c: o.unit === 'F' ? fToC(native) : native });
    obsByIcao.set(o.icao, m);
  }

  const eventsByDate = new Map<string, EventRow[]>();
  for (const e of events) {
    const d = dateISO(e.target_date);
    const list = eventsByDate.get(d) ?? [];
    list.push(e);
    eventsByDate.set(d, list);
  }

  // --- stats state + warm-up (everything folded through from−3) ------------------
  const stats = new Map<string, StationStats>(icaos.map((i) => [i, new StationStats(cfg)]));
  const foldTarget = (icao: string, t: string): void => {
    const fc = byIcaoTarget.get(icao)?.get(t);
    const obs = obsByIcao.get(icao)?.get(t);
    if (fc && obs) stats.get(icao)!.fold(fc, obs.c);
  };
  const allTargets = new Set<string>();
  for (const m of byIcaoTarget.values()) for (const t of m.keys()) allTargets.add(t);
  const warmupEnd = addDaysISO(args.from, -3);
  for (const t of [...allTargets].sort()) {
    if (t <= warmupEnd) for (const icao of icaos) foldTarget(icao, t);
  }

  // --- the walk -------------------------------------------------------------------
  const report: SimReport = {
    evals: [], bets: [], equity: [], finalBankroll: cfg.bankrollUsd, maxDrawdownPct: 0,
    fidelity: [], deciles: [],
    counters: {
      events: events.length, evalsBuilt: 0, matchedPairs: 0, houseOnlyEvals: 0,
      skippedNoForecasts: 0, skippedNoObs: 0, polyWinnerMismatches: 0,
      betsPlaced: 0, betsWon: 0, scoresWritten: 0,
    },
    csvPath: null,
  };
  const pairAcc = new Map<string, { cityId: string; citySlug: string; lead: number; house: number[]; market: number[] }>();
  const dayOpen = new Map<string, { day: number; byCluster: Map<string, number> }>();
  const dayPnl = new Map<string, number>();
  let bankroll = cfg.bankrollUsd;
  let peak = bankroll;

  const buildLead = async (ev: EventRow, lead: 0 | 1, d: string): Promise<void> => {
    const st = stationByCity.get(ev.city_id)!;
    const ladderRows = bucketsByEvent.get(ev.id) ?? [];
    if (ladderRows.length === 0) return;
    const unit = ev.unit;
    const ladder: BucketDef[] = ladderRows.map((b) => ({
      low: b.low_native === null ? null : Number(b.low_native),
      high: b.high_native === null ? null : Number(b.high_native),
      unit,
    }));

    const leadCol = lead + 1;
    const fc = byIcaoTarget.get(st.icao)?.get(d);
    const points: { model: string; value: number }[] = [];
    if (fc) {
      for (const [key, tmaxC] of fc) {
        const [model, leadStr] = key.split('|') as [string, string];
        if (Number(leadStr) !== leadCol) continue;
        const bias = stats.get(st.icao)!.state(model, leadCol).bias ?? 0;
        points.push({ model, value: correctPoint(tmaxC, bias) });
      }
    }
    if (points.length === 0) {
      report.counters.skippedNoForecasts++;
      return;
    }
    const w = stats.get(st.icao)!.weights(points.map((p) => p.model), leadCol);
    const haveWeights = [...w.values()].some((v) => v > 0);
    const weights = new Map(
      points.map((p) => [p.model, haveWeights ? (w.get(p.model) ?? 0) : 1 / points.length] as const),
    );
    const { mu } = ensembleStats(points, weights);
    const sigmaC = stats.get(st.icao)!.blendSigmaC(leadCol);
    const muNative = toNative(mu, unit);
    const sigmaNative = unit === 'F' ? sigmaC * (9 / 5) : sigmaC;
    const probs = gaussianBucketProbs(muNative, sigmaNative, ladder);

    // truth + time-matched consensus
    const obs = obsByIcao.get(st.icao)?.get(d);
    let winnerIdx: number | null = null;
    let brierHouse: number | null = null;
    if (obs) {
      winnerIdx = winningBucket(ladder, obs.native);
      brierHouse = brierScore(probs, winnerIdx);
      if (ev.poly_resolved_winner_idx !== null && Number(ev.poly_resolved_winner_idx) !== winnerIdx) {
        report.counters.polyWinnerMismatches++;
      }
    } else {
      report.counters.skippedNoObs++;
    }

    const cutoff = new Date(localDayWindow(ev.tz, d).startUtc.getTime() - lead * 86_400_000);
    const [cons] = await db.query<{ probs: string[]; made_at: string | Date }>(
      `select probs, made_at from bucket_probabilities
       where event_id = $1 and source = 'market_consensus' and nowcast = false and made_at <= $2
       order by made_at desc limit 1`,
      [ev.id, cutoff.toISOString()],
    );
    let brierMarket: number | null = null;
    if (cons && winnerIdx !== null) {
      brierMarket = brierScore(cons.probs.map(Number), winnerIdx);
    }
    const matched = brierHouse !== null && brierMarket !== null;
    if (matched) {
      const key = `${ev.city_id}|${lead}`;
      const acc = pairAcc.get(key) ?? { cityId: ev.city_id, citySlug: ev.city_slug, lead, house: [], market: [] };
      acc.house.push(brierHouse!);
      acc.market.push(brierMarket!);
      pairAcc.set(key, acc);
      report.counters.matchedPairs++;
    } else if (brierHouse !== null) {
      report.counters.houseOnlyEvals++;
    }

    report.evals.push({
      date: d, lead, citySlug: ev.city_slug, eventId: ev.id, muNative, sigmaNative, probs,
      winnerIdx, brierHouse, brierMarket,
      consensusMadeAt: cons ? new Date(cons.made_at).toISOString() : null, matched,
    });
    report.counters.evalsBuilt++;

    // --- lead-0 betting sim (consensus-as-price proxy; §6.17 pipeline) ------------
    if (lead === 0 && cons && winnerIdx !== null) {
      const prices = cons.probs.map(Number);
      const books = prices.map((p) => (p > 0 && p < 1 ? proxyBook(p, cfg.probeStakeUsd) : null));
      const marketRows = ladderRows.map((b) => ({
        feeRate: b.fee_rate === null ? 0.05 : Number(b.fee_rate),
        spread: null,
      }));
      const edgeCfg = {
        uncertaintyMargin: cfg.uncertaintyMargin, spreadBufferMin: cfg.spreadBufferMin,
        feeRate: 0.05, probeStakeUsd: cfg.probeStakeUsd, maxSpread: cfg.maxSpread,
        minEventVolumeUsd: cfg.minEventVolumeUsd, minHoursBeforeClose: cfg.minHoursBeforeClose,
      };
      const rows = computeBucketEdges(probs, ladder, books, marketRows, edgeCfg);
      const passing = rows.filter((r) => r.pass);
      if (passing.length > 0) {
        const effCost = passing.map(
          (r) => r.execAsk! + takerFeePerShare(r.execAsk!, marketRows[r.bucketIdx]!.feeRate) + cfg.paperSlippage,
        );
        const { fractions } = jointKellyStakes(passing.map((r) => r.q), effCost);
        const fractional = applyKellyFraction(fractions, cfg.kellyFraction);
        const open = dayOpen.get(d) ?? { day: 0, byCluster: new Map<string, number>() };
        const plans = applyRiskCaps(
          passing
            .map((r, j) => ({
              bucketIdx: r.bucketIdx,
              frac: fractional[j]!,
              price: r.execAsk!,
              orderMinSize: Number(ladderRows[r.bucketIdx]!.min_order_size ?? 5),
            }))
            .filter((p) => p.frac > 0),
          {
            bankrollUsd: bankroll,
            eventOpenUsd: 0,
            clusterOpenUsd: open.byCluster.get(ev.region) ?? 0,
            dayOpenUsd: open.day,
          },
          cfg,
        );
        for (const plan of plans) {
          if (plan.shares <= 0) continue;
          const row = rows[plan.bucketIdx]!;
          const price = row.execAsk!;
          const stake = plan.shares * price;
          const fee = takerFeeTotal(price, plan.shares, marketRows[plan.bucketIdx]!.feeRate);
          const win = plan.bucketIdx === winnerIdx;
          const pnl = (win ? plan.shares * (1 - price) : -plan.shares * price) - fee;
          report.bets.push({
            date: d, citySlug: ev.city_slug, bucketIdx: plan.bucketIdx,
            label: ladderRows[plan.bucketIdx]!.label,
            q: row.q, price, edge: row.edge!, stake, shares: plan.shares, fee, win, pnl,
          });
          report.counters.betsPlaced++;
          if (win) report.counters.betsWon++;
          open.day += stake;
          open.byCluster.set(ev.region, (open.byCluster.get(ev.region) ?? 0) + stake);
          dayOpen.set(d, open);
          dayPnl.set(d, (dayPnl.get(d) ?? 0) + pnl);
        }
      }
    }
  };

  for (const d of listDatesISO(args.from, args.to)) {
    // lead 1 first (stats ≤ D−3), then fold D−2, then lead 0 (stats ≤ D−2).
    for (const ev of eventsByDate.get(d) ?? []) await buildLead(ev, 1, d);
    for (const icao of icaos) foldTarget(icao, addDaysISO(d, -2));
    for (const ev of eventsByDate.get(d) ?? []) await buildLead(ev, 0, d);

    const pnl = dayPnl.get(d) ?? 0;
    if (pnl !== 0 || (eventsByDate.get(d) ?? []).length > 0) {
      bankroll += pnl;
      peak = Math.max(peak, bankroll);
      report.maxDrawdownPct = Math.max(report.maxDrawdownPct, peak > 0 ? (peak - bankroll) / peak : 0);
      report.equity.push({ date: d, balance: Math.round(bankroll * 100) / 100 });
    }
  }
  report.finalBankroll = Math.round(bankroll * 100) / 100;

  // --- 'backtest' calibration_scores (over time-matched pairs only — C7) ---------
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  for (const acc of pairAcc.values()) {
    await db.query(
      `insert into calibration_scores (city_id, source, lead_days, window_tag, brier, brier_market, n_events)
       values ($1, $2, $3, 'backtest', $4, $5, $6)
       on conflict (city_id, source, lead_days, window_tag) do update
         set brier = excluded.brier, brier_market = excluded.brier_market,
             n_events = excluded.n_events, updated_at = now()`,
      [acc.cityId, source, acc.lead, mean(acc.house), mean(acc.market), acc.house.length],
    );
    report.counters.scoresWritten++;
    report.fidelity.push({
      citySlug: acc.citySlug, lead: acc.lead, n: acc.house.length,
      brierHouse: mean(acc.house), brierMarket: mean(acc.market),
      ratio: mean(acc.market) > 0 ? mean(acc.house) / mean(acc.market) : NaN,
    });
  }
  report.fidelity.sort((a, b) => a.citySlug.localeCompare(b.citySlug) || a.lead - b.lead);

  // --- hit rate by edge decile (width_bucket(edge, 0, 0.5, 10) mirror) ------------
  const decileOf = (edge: number): number => Math.min(10, Math.max(1, Math.floor(edge / 0.05) + 1));
  const byDecile = new Map<number, SimBet[]>();
  for (const b of report.bets) {
    const list = byDecile.get(decileOf(b.edge)) ?? [];
    list.push(b);
    byDecile.set(decileOf(b.edge), list);
  }
  report.deciles = [...byDecile.entries()]
    .map(([decile, bets]) => ({
      decile, n: bets.length, wins: bets.filter((b) => b.win).length,
      hitRate: bets.filter((b) => b.win).length / bets.length,
      avgEdge: mean(bets.map((b) => b.edge)), avgQ: mean(bets.map((b) => b.q)),
      pnl: Math.round(bets.reduce((a, b) => a + b.pnl, 0) * 100) / 100,
    }))
    .sort((a, b) => a.decile - b.decile);

  // --- CSV + console fidelity report ----------------------------------------------
  const lines = [
    'section,city,lead,n,brier_house,brier_market,ratio',
    ...report.fidelity.map((f) =>
      `fidelity,${f.citySlug},${f.lead},${f.n},${f.brierHouse.toFixed(6)},${f.brierMarket.toFixed(6)},${f.ratio.toFixed(4)}`),
    'section,decile,n,wins,hit_rate,avg_edge,avg_q,pnl',
    ...report.deciles.map((x) =>
      `decile,${x.decile},${x.n},${x.wins},${x.hitRate.toFixed(4)},${x.avgEdge.toFixed(4)},${x.avgQ.toFixed(4)},${x.pnl.toFixed(2)}`),
    'section,date,balance',
    ...report.equity.map((e) => `equity,${e.date},${e.balance.toFixed(2)}`),
  ];
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    report.csvPath = join(args.out, `backtest-${args.from}_${args.to}.csv`);
    writeFileSync(report.csvPath, lines.join('\n'), 'utf8');
  }

  log(`=== simulate-historical-edge ${args.from} → ${args.to} · source ${source} ===`);
  log('city          lead     n   brier(house)  brier(market)  ratio');
  for (const f of report.fidelity) {
    log(
      `${f.citySlug.padEnd(13)} ${String(f.lead).padStart(4)} ${String(f.n).padStart(5)}   ` +
        `${f.brierHouse.toFixed(4).padStart(12)}  ${f.brierMarket.toFixed(4).padStart(13)}  ${f.ratio.toFixed(3).padStart(5)}`,
    );
  }
  if (report.fidelity.length === 0) log('(no time-matched pairs — backfill market history + actuals first)');
  log(
    `bets ${report.counters.betsPlaced} (won ${report.counters.betsWon}) · final bankroll ` +
      `$${report.finalBankroll.toFixed(2)} · max drawdown ${(report.maxDrawdownPct * 100).toFixed(1)}% · ` +
      `matched pairs ${report.counters.matchedPairs} · house-only ${report.counters.houseOnlyEvals} · ` +
      `poly-winner mismatches ${report.counters.polyWinnerMismatches}`,
  );
  for (const x of report.deciles) {
    log(`decile ${x.decile}: n ${x.n} hit ${(x.hitRate * 100).toFixed(0)}% avgQ ${x.avgQ.toFixed(3)} pnl $${x.pnl.toFixed(2)}`);
  }
  log(
    'HONEST-FIDELITY NOTE: the consensus-mid proxy is NOT an executable book — no depth, no spread, ' +
      'no volume veto. Backtest results are indicative for GATING DIRECTION only, never a go-live ' +
      'justification by themselves (§11.4).',
  );
  if (report.csvPath) log(`CSV: ${report.csvPath}`);
  return report;
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      source: { type: 'string' },
      stations: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.from || !values.to) {
    console.error('usage: pnpm tsx scripts/simulate-historical-edge.ts --from YYYY-MM-DD --to YYYY-MM-DD [--source house_gaussian] [--stations A,B] [--out reports]');
    process.exit(2);
  }
  const db = makeScriptDb();
  try {
    await simulateHistoricalEdge(
      {
        from: values.from,
        to: values.to,
        source: values.source,
        stations: splitList(values.stations),
        out: values.out ?? 'reports',
      },
      { db, log: console.log },
    );
  } finally {
    await db.end();
  }
}
