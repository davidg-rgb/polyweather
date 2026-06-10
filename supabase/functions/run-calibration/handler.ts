/**
 * run-calibration — the daily learning loop (ARCHITECTURE.md §6.18, W3, W19,
 * C5, C7).
 *
 * (1) RESIDUALS  new finalized observations × forecast snapshots (lead 0–7)
 * (2) STATS      bias fold / σ fit / inverse-MSE weights per (station, model,
 *                lead, slot) — 10Z/22Z never pooled (W3); backfill/gapfill
 *                rows seed BOTH slots with residuals widened ×1.15 (W19);
 *                plus the 'blend' σ row §6.16 reads
 * (3) SCORES     Brier/ECE/reliability/sharpness per (city, lead, source) over
 *                30/60/90d windows on ADR-16 scored rows; pooled zero-UUID row
 *                carries the paired-bootstrap p goLiveGate reads (C5)
 * (4) GATES      rolling-Brier city breaker; champion-vs-market drift check
 * (5) PROMOTION  challenger ≥5% better on 60d time-matched ⇒ Slack ACTION
 * (6) tail-call buildDistributions with the fresh stats
 * (7) weekly (Sundays) nowcast_lift rebuild (§7.8a)
 */
import {
  brierScore,
  computeModelWeights,
  evaluateBreakers,
  expectedCalibrationError,
  fitSigma,
  pairedBootstrapPValue,
  reliabilityBins,
  sharpness,
  updateBias,
  type Prediction,
} from '../../../packages/core/src/index.ts';
import { buildDistributions } from '../build-distributions/handler.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface CalibDeps {
  notify: (alert: Alert) => Promise<boolean>;
  now: Date;
}

/** [date_local, error_c, is_seed] triplets, date-ordered (RPC contract). */
type ErrorTriplet = [string, number, boolean];
interface PairGroup {
  model: string;
  lead: number;
  slot: string;
  errors: ErrorTriplet[];
}
interface ScoredRow {
  event: string;
  date: string;
  source: string;
  lead: number;
  probs: number[];
  brier: number | null;
  winner: number;
}
interface StatRow {
  icao: string;
  model: string;
  lead: number;
  slot: string;
  bias: number | null;
  sigma: number | null;
  n: number;
  mse: number | null;
  weight: number | null;
  window: number;
}
interface ScoreUpsert {
  city: string;
  source: string;
  lead: number;
  window: string;
  brier: number | null;
  brier_market: number | null;
  bootstrap_p: number | null;
  ece: number | null;
  sharpness: number | null;
  reliability: unknown;
  n: number;
}

/** The reserved all-cities row §7.14 defines for the POOLED gate statistics. */
export const POOLED_CITY_ID = '00000000-0000-0000-0000-000000000000';
/** lead_days sentinel on the pooled row: pooled across leads {0,1} (the PK needs a value). */
export const POOLED_LEAD = -1;
/** W19: backfill/gapfill residuals enter the σ/MSE window widened ×1.15. */
const SEED_WIDEN = 1.15;
/** DoS guard, not a routine page size — the cursor cuts at a finalized_at boundary. */
const MAX_OBS_PER_RUN = 20_000;
/** Lift quantiles need this many completed days per (station, hour) before overwriting. */
const MIN_LIFT_DAYS = 10;
/** No promotion suggestion on thin evidence (C5 spirit — mirrors the bootstrap's n<30 rule). */
const PROMOTION_MIN_N = 30;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const isoDaysAgo = (todayISO: string, days: number): string => {
  const d = new Date(`${todayISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
const jsonDate = (v: unknown): string =>
  typeof v === 'string' ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10);

export async function runCalibration(ctx: JobCtx, deps: CalibDeps): Promise<JobStats> {
  const { db, config: cfg, log } = ctx;
  const today = deps.now.toISOString().slice(0, 10);
  const stats: {
    residualsAdded: number;
    statsUpserted: number;
    scoresUpserted: number;
    halts: number;
    promotionCandidates: number;
    liftRowsRebuilt?: number;
  } = { residualsAdded: 0, statsUpserted: 0, scoresUpserted: 0, halts: 0, promotionCandidates: 0 };

  // --- (1) + (2) RESIDUALS → STATS -----------------------------------------
  const cursor = (await db.getConfigRows()).find((r) => r.key === 'calibCursor')?.value ?? null;
  const [boundRow] = await db.rpc<{ calib_cursor_bound: string | Date | null }>('calib_cursor_bound', {
    p_since: cursor,
    p_max_obs: MAX_OBS_PER_RUN,
  });
  const rawBound = boundRow?.calib_cursor_bound ?? null;
  const until = rawBound === null ? null : rawBound instanceof Date ? rawBound.toISOString() : String(rawBound);

  if (until !== null) {
    const newPairs = await db.rpc<{ icao: string; groups: PairGroup[] }>('calib_new_pairs', {
      p_since: cursor,
      p_until: until,
    });
    const icaos = newPairs.map((r) => r.icao);

    if (icaos.length > 0) {
      // Fold starting points: the stored bias per (station, model, lead, slot).
      const bias = new Map<string, number>();
      const biasRows = await db.rpc<{
        icao: string;
        biases: { model: string; lead: number; slot: string; bias: number }[];
      }>('calib_current_bias', { p_icaos: icaos });
      for (const r of biasRows) {
        for (const b of r.biases) bias.set(`${r.icao}|${b.model}|${b.lead}|${b.slot}`, Number(b.bias));
      }

      // Chronological decaying-average fold over the NEW errors (raw, unwidened —
      // bias is a location estimate; W19's ×1.15 widens dispersion only).
      const touched = new Set<string>();
      for (const r of newPairs) {
        for (const g of r.groups) {
          const k = `${r.icao}|${g.model}|${g.lead}|${g.slot}`;
          touched.add(k);
          let b: number | null = bias.has(k) ? bias.get(k)! : null;
          for (const [, error] of g.errors) {
            b = updateBias(b, Number(error), cfg.biasAlpha);
            stats.residualsAdded++;
          }
          if (b !== null) bias.set(k, b);
        }
      }

      // σ/MSE over the rolling window with the NEW bias: residual = error − bias
      // (= correctPoint(raw, bias) − observed); seed-row residuals ×1.15 (W19).
      const windowRows = await db.rpc<{ icao: string; groups: PairGroup[] }>('calib_window_errors', {
        p_window_days: cfg.sigmaWindowDays,
        p_icaos: icaos,
        p_today: today,
      });
      const residualsByKey = new Map<string, { date: string; residual: number }[]>();
      const groupMeta = new Map<string, { icao: string; model: string; lead: number; slot: string }>();
      for (const r of windowRows) {
        for (const g of r.groups) {
          const k = `${r.icao}|${g.model}|${g.lead}|${g.slot}`;
          groupMeta.set(k, { icao: r.icao, model: g.model, lead: g.lead, slot: g.slot });
          const b = bias.get(k) ?? 0;
          residualsByKey.set(
            k,
            g.errors.map(([date, e, seed]) => ({
              date: jsonDate(date),
              residual: (Number(e) - b) * (seed ? SEED_WIDEN : 1),
            })),
          );
        }
      }
      for (const r of newPairs) {
        for (const g of r.groups) {
          const k = `${r.icao}|${g.model}|${g.lead}|${g.slot}`;
          if (!groupMeta.has(k)) groupMeta.set(k, { icao: r.icao, model: g.model, lead: g.lead, slot: g.slot });
        }
      }

      const statRows = new Map<string, StatRow>();
      for (const [k, meta] of groupMeta) {
        const res = residualsByKey.get(k) ?? [];
        const values = res.map((x) => x.residual);
        const fitted = fitSigma(values, cfg.sigmaMinN);
        statRows.set(k, {
          icao: meta.icao,
          model: meta.model,
          lead: meta.lead,
          slot: meta.slot,
          bias: bias.get(k) ?? null,
          sigma: fitted?.sigma ?? null,
          n: values.length,
          mse: values.length > 0 ? mean(values.map((v) => v * v)) : null,
          weight: 0,
          window: cfg.sigmaWindowDays,
        });
      }

      // Inverse-MSE weights per (station, lead, slot) over models with enough
      // window data (n ≥ sigmaMinN — thin evidence gets weight 0); then the
      // 'blend' σ row §6.16 reads: per-date weighted residual of the blend.
      const bySlotLead = new Map<string, StatRow[]>();
      for (const row of statRows.values()) {
        const k = `${row.icao}|${row.lead}|${row.slot}`;
        const list = bySlotLead.get(k) ?? [];
        if (list.length === 0) bySlotLead.set(k, list);
        list.push(row);
      }
      const blendRows: StatRow[] = [];
      for (const [, group] of bySlotLead) {
        const mseMap = new Map<string, number>();
        for (const row of group) {
          if (row.n >= cfg.sigmaMinN && row.mse !== null) mseMap.set(row.model, row.mse);
        }
        const weights = computeModelWeights(mseMap);
        for (const row of group) row.weight = weights.get(row.model) ?? 0;

        const perDate = new Map<string, { w: number; res: number }[]>();
        for (const row of group) {
          const res = residualsByKey.get(`${row.icao}|${row.model}|${row.lead}|${row.slot}`) ?? [];
          for (const { date, residual } of res) {
            const list = perDate.get(date) ?? [];
            if (list.length === 0) perDate.set(date, list);
            list.push({ w: row.weight ?? 0, res: residual });
          }
        }
        const blendRes: number[] = [];
        for (const entries of perDate.values()) {
          const total = entries.reduce((a, e) => a + e.w, 0);
          blendRes.push(
            total > 0
              ? entries.reduce((a, e) => a + (e.w / total) * e.res, 0)
              : mean(entries.map((e) => e.res)), // no weighted model yet → equal-weight blend (§6.16 fallback)
          );
        }
        if (blendRes.length > 0) {
          const fitted = fitSigma(blendRes, cfg.sigmaMinN);
          blendRows.push({
            icao: group[0]!.icao,
            model: 'blend',
            lead: group[0]!.lead,
            slot: group[0]!.slot,
            bias: null,
            sigma: fitted?.sigma ?? null,
            n: blendRes.length,
            mse: mean(blendRes.map((v) => v * v)),
            weight: null,
            window: cfg.sigmaWindowDays,
          });
        }
      }

      const allRows = [...statRows.values(), ...blendRows];
      if (allRows.length > 0) {
        const [v] = await db.rpc<{ upsert_model_stats: number }>('upsert_model_stats', { p_rows: allRows });
        stats.statsUpserted = allRows.length;
        log('stats upserted', { statsVersion: v?.upsert_model_stats, rows: allRows.length });
      }
    }

    await db.rpc('set_config_value', { p_key: 'calibCursor', p_value: until });
  }

  // --- (3) SCORES ------------------------------------------------------------
  const scoredCities = await db.rpc<{ city_id: string; city_slug: string; scored: ScoredRow[] }>(
    'calib_scored_rows',
    { p_days: 90, p_today: today },
  );
  const all: (ScoredRow & { cityId: string; citySlug: string })[] = [];
  for (const c of scoredCities) {
    for (const r of c.scored) all.push({ ...r, date: jsonDate(r.date), cityId: c.city_id, citySlug: c.city_slug });
  }
  const rowBrier = (r: ScoredRow): number =>
    r.brier !== null && r.brier !== undefined ? Number(r.brier) : brierScore(r.probs.map(Number), r.winner);

  const scoreUpserts: ScoreUpsert[] = [];
  const pooled = new Map<number, { diffs: number[]; champ: number[]; market: number[] }>();
  for (const w of [30, 60, 90]) {
    const from = isoDaysAgo(today, w);
    const inWin = all.filter((r) => r.date > from);
    if (inWin.length === 0) continue; // nothing scored in this window — write no placeholder rows

    const marketByEventLead = new Map<string, number>();
    for (const r of inWin) {
      if (r.source === 'market_consensus') marketByEventLead.set(`${r.event}|${r.lead}`, rowBrier(r));
    }

    const groups = new Map<string, typeof all>();
    for (const r of inWin) {
      const k = `${r.cityId}|${r.source}|${r.lead}`;
      const list = groups.get(k) ?? [];
      if (list.length === 0) groups.set(k, list);
      list.push(r);
    }
    for (const [k, rowsIn] of groups) {
      const [cityId, source, leadStr] = k.split('|') as [string, string, string];
      const preds: Prediction[] = rowsIn.flatMap((r) =>
        r.probs.map((q, i) => ({ q: Number(q), hit: i === r.winner })),
      );
      const matchedMarket =
        source === 'market_consensus'
          ? []
          : rowsIn
              .map((r) => marketByEventLead.get(`${r.event}|${r.lead}`))
              .filter((x): x is number => x !== undefined);
      scoreUpserts.push({
        city: cityId,
        source,
        lead: Number(leadStr),
        window: `${w}d`,
        brier: mean(rowsIn.map(rowBrier)),
        brier_market: matchedMarket.length > 0 ? mean(matchedMarket) : null,
        bootstrap_p: null,
        ece: expectedCalibrationError(preds, 10),
        sharpness: sharpness(rowsIn.map((r) => r.probs.map(Number))),
        reliability: reliabilityBins(preds, 10),
        n: rowsIn.length,
      });
    }

    // Pooled champion-vs-market on time-matched (event, lead) pairs ONLY (C7) —
    // the zero-UUID row goLiveGate reads (60d), plus the 30d drift-gate twin.
    if (w === 30 || w === 60) {
      const champByEventLead = new Map<string, number>();
      for (const r of inWin) {
        if (r.source === cfg.championSource) champByEventLead.set(`${r.event}|${r.lead}`, rowBrier(r));
      }
      const diffs: number[] = [];
      const champ: number[] = [];
      const market: number[] = [];
      for (const [el, cb] of champByEventLead) {
        const mb = marketByEventLead.get(el);
        if (mb === undefined) continue;
        diffs.push(cb - mb);
        champ.push(cb);
        market.push(mb);
      }
      pooled.set(w, { diffs, champ, market });
      scoreUpserts.push({
        city: POOLED_CITY_ID,
        source: cfg.championSource,
        lead: POOLED_LEAD,
        window: `${w}d`,
        brier: champ.length > 0 ? mean(champ) : null,
        brier_market: market.length > 0 ? mean(market) : null,
        bootstrap_p: pairedBootstrapPValue(diffs),
        ece: null,
        sharpness: null,
        reliability: null,
        n: diffs.length,
      });
    }
  }
  if (scoreUpserts.length > 0) {
    const [n] = await db.rpc<{ upsert_calibration_scores: number }>('upsert_calibration_scores', {
      p_rows: scoreUpserts,
    });
    stats.scoresUpserted = n?.upsert_calibration_scores ?? scoreUpserts.length;
  }

  // --- (4) GATES ---------------------------------------------------------------
  const from30 = isoDaysAgo(today, 30);
  const briers30ByCity = new Map<string, number[]>();
  for (const r of all) {
    if (r.source !== cfg.championSource || r.date <= from30) continue;
    const list = briers30ByCity.get(r.citySlug) ?? [];
    if (list.length === 0) briers30ByCity.set(r.citySlug, list);
    list.push(rowBrier(r));
  }
  const rollingBrierByCity = new Map([...briers30ByCity].map(([slug, bs]) => [slug, mean(bs)] as const));
  const halts = evaluateBreakers(
    {
      consecutiveLossesByCityLead: new Map(),
      dailyPnlPct: 0,
      drawdownPct: 0,
      rollingBrierByCity,
      freshestForecastAgeH: 0,
      freshestPriceAgeMin: 0,
    },
    cfg,
  );
  for (const halt of halts) {
    await db.rpc('apply_halt', { p_scope: halt.scope, p_reason: halt.reason });
    await deps.notify({
      kind: 'BREAKER',
      severity: 'WARN',
      title: `Circuit breaker: ${halt.scope}`,
      body: halt.reason,
      dedupeKey: `breaker:${halt.scope}`,
    });
    stats.halts++;
  }

  const driftFails = (w: number): boolean => {
    const p = pooled.get(w);
    return p !== undefined && p.diffs.length > 0 && mean(p.champ) >= mean(p.market);
  };
  if (driftFails(30)) {
    const p30 = pooled.get(30)!;
    const bothFail = driftFails(60);
    await deps.notify({
      kind: 'CALIB_DRIFT',
      severity: 'WARN',
      title: 'Champion no longer beats market consensus (30d pooled)',
      body:
        `house ${mean(p30.champ).toFixed(4)} ≥ market ${mean(p30.market).toFixed(4)} over ${p30.diffs.length} time-matched samples` +
        (bothFail ? ' — 60d ALSO fails: auto-halting all betting' : ' — betting continues on the still-passing 60d window'),
      dedupeKey: 'calib-drift',
    });
    if (bothFail) {
      await db.rpc('apply_halt', {
        p_scope: 'global',
        p_reason: 'calibration drift: champion ≥ market_consensus on both 30d and 60d pooled windows',
      });
      await deps.notify({
        kind: 'CALIB_DRIFT',
        severity: 'CRITICAL',
        title: 'Auto-halt: calibration drift on 30d AND 60d',
        body: 'Champion Brier ≥ market on both pooled windows — halt:global applied (§6.18 step 4).',
        dedupeKey: 'calib-drift-halt',
      });
      stats.halts++;
    }
  }

  // --- (5) PROMOTION REPORT ------------------------------------------------
  const from60 = isoDaysAgo(today, 60);
  const in60 = all.filter((r) => r.date > from60);
  const champ60 = new Map<string, number>();
  for (const r of in60) {
    if (r.source === cfg.championSource) champ60.set(`${r.event}|${r.lead}`, rowBrier(r));
  }
  for (const challenger of ['house_gaussian', 'house_ensemble'].filter((s) => s !== cfg.championSource)) {
    const pairs: [number, number][] = [];
    for (const r of in60) {
      if (r.source !== challenger) continue;
      const cb = champ60.get(`${r.event}|${r.lead}`);
      if (cb !== undefined) pairs.push([rowBrier(r), cb]);
    }
    if (pairs.length < PROMOTION_MIN_N) continue;
    const challengerMean = mean(pairs.map((p) => p[0]));
    const championMean = mean(pairs.map((p) => p[1]));
    if (challengerMean <= 0.95 * championMean) {
      await deps.notify({
        kind: 'PROMOTION',
        severity: 'ACTION',
        title: `Challenger ${challenger} beats champion by ≥5% (60d time-matched)`,
        body: `${challenger} Brier ${challengerMean.toFixed(4)} vs ${cfg.championSource} ${championMean.toFixed(4)} over ${pairs.length} samples — consider promotion via /admin`,
        dedupeKey: `promotion:${challenger}`,
      });
      stats.promotionCandidates++;
    }
  }

  // --- (6) refresh distributions with the new stats ---------------------------
  await buildDistributions(ctx, { notify: deps.notify, now: deps.now });

  // --- (7) weekly nowcast_lift rebuild (Sundays, §7.8a) ------------------------
  if (deps.now.getUTCDay() === 0) {
    const [r] = await db.rpc<{ rebuild_nowcast_lift: number }>('rebuild_nowcast_lift', {
      p_min_n: MIN_LIFT_DAYS,
      p_today: today,
    });
    stats.liftRowsRebuilt = r?.rebuild_nowcast_lift ?? 0;
  }

  log('calibration complete', stats);
  return stats;
}
