/**
 * functions/_shared/distributions — buildDistributionForEvent, the shared
 * house-probability builder (ARCHITECTURE.md §6.16, W3, W19, ADR-15/16).
 * Imported in-process by build-distributions, discover-markets (C7 seed) and
 * metar-nowcast (nowcast rebuild) — never over HTTP.
 *
 * This is PURE ANALYTICS: it writes bucket_probabilities and NEVER places a bet.
 * The buildable set comes from list_buildable_events() (HD-1 / ADR-18 / migration
 * 0028), which does NOT require operator verification — `city_stations.verified`
 * and `cities.betting_enabled` gate only the bet/candidate path. Do not re-introduce
 * a verified/betting_enabled check here or in the caller (R-A9): it re-zeroes the
 * house build, exactly the bug 0028 fixed.
 */
import {
  DistributionError,
  applyRunningMaxConstraint,
  correctPoint,
  dressedEnsembleProbs,
  ensembleStats,
  gaussianBucketProbs,
  leadDays,
  localHour,
  toNative,
  validateLadder,
  type AppConfig,
  type BucketDef,
  type Unit,
} from '../../../packages/core/src/index.ts';
import type { DbPort } from './db.ts';
import type { Alert } from './slack.ts';

export interface BuildDeps {
  notify: (alert: Alert) => Promise<boolean>;
  now: Date;
}

interface BuildInputs {
  event: { id: string; slug: string; targetDate: string; unit: Unit; ladderOk: boolean };
  city: { slug: string; tz: string };
  icao: string | null;
  buckets: { idx: number; low: number | null; high: number | null }[] | null;
  forecasts: { id: string; model: string; tmaxC: number; slot: string; capturedAt: string }[];
  stats: { model: string; lead: number; slot: string; bias: number | null; sigma: number | null; weight: number | null; version: number | null }[];
  ensembles: { id: string; model: string; members: number[]; n: number }[];
  intraday: { maxTenthsC: number; maxNative: number } | null;
  lift: { hour: number; p50: number | null; p90: number | null }[];
}

const sha256Hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** 'gapfill' rows map to the nearest live slot by captured_at (§6.16). */
const slotOf = (slot: string, capturedAt: string): '10Z' | '22Z' =>
  slot === '10Z' || slot === '22Z' ? slot : new Date(capturedAt).getUTCHours() < 16 ? '10Z' : '22Z';

export async function buildDistributionForEvent(
  db: DbPort,
  cfg: AppConfig,
  eventId: string,
  deps: BuildDeps,
): Promise<{ written: number; skipped: number }> {
  const [raw] = await db.rpc<{ get_build_inputs: BuildInputs | null }>('get_build_inputs', {
    p_event_id: eventId,
  });
  const inp = raw?.get_build_inputs;
  const out = { written: 0, skipped: 0 };
  if (!inp || !inp.buckets || inp.buckets.length === 0 || !inp.icao || !inp.event.ladderOk) return out;

  const unit = inp.event.unit;
  const ladder: BucketDef[] = inp.buckets.map((b) => ({ low: b.low, high: b.high, unit }));
  if (!validateLadder(ladder).ok) return out; // flagged at discovery; never build on a broken ladder

  const targetDate =
    typeof inp.event.targetDate === 'string'
      ? inp.event.targetDate.slice(0, 10)
      : new Date(inp.event.targetDate).toISOString().slice(0, 10);
  const lead = leadDays(deps.now, targetDate, inp.city.tz);
  if (lead < 0 || lead > cfg.maxLeadDays) return out;

  const statFor = (model: string, slot: string) =>
    inp.stats.find((s) => s.model === model && s.lead === lead && s.slot === slot);
  const statsVersion = Math.max(0, ...inp.stats.map((s) => s.version ?? 0));

  const warnSkip = async (source: string, reason: string) => {
    await deps.notify({
      kind: 'DIST_SKIP',
      severity: 'WARN',
      title: `${source} skipped for ${inp.event.slug}`,
      body: reason,
      dedupeKey: `dist-skip:${inp.event.slug}:${source}`,
    });
  };

  const write = async (
    source: string,
    probs: number[],
    mu: number,
    sigma: number,
    hashParts: string[],
    nowcast: boolean,
  ) => {
    const hash = await sha256Hex(hashParts.join('|'));
    const [r] = await db.rpc<{ upsert_distribution: boolean }>('upsert_distribution', {
      p_event_id: eventId,
      p_source: source,
      p_lead: lead,
      p_nowcast: nowcast,
      p_inputs_hash: hash,
      p_probs: probs,
      p_mu: mu,
      p_sigma: sigma,
      p_stats_version: statsVersion,
    });
    if (r?.upsert_distribution) out.written++;
    else out.skipped++;
  };

  // σ in °C: the 'blend' model_stats row for (station, lead, slot) else the prior ladder (§6.16).
  const blendSigmaC = (slot: string): number => {
    const blend = statFor('blend', slot);
    const sigma = blend?.sigma ?? cfg.priorSigmaByLead[Math.min(lead, 7)]!;
    return Math.max(sigma, cfg.sigmaFloorC);
  };
  const toNativeSigma = (sigmaC: number): number => (unit === 'F' ? sigmaC * (9 / 5) : sigmaC);

  // Nowcast context (ADR-15): native running max + native lift quantiles for the current local hour.
  const nowcastCtx = (() => {
    if (lead !== 0 || !inp.intraday) return null;
    const hour = localHour(inp.city.tz, deps.now);
    const liftRow = inp.lift.find((l) => l.hour === hour);
    const scale = unit === 'F' ? 9 / 5 : 1;
    return {
      runningMax: inp.intraday.maxNative,
      lift:
        liftRow && liftRow.p50 !== null && liftRow.p90 !== null
          ? { p50: Number(liftRow.p50) * scale, p90: Number(liftRow.p90) * scale }
          : undefined,
    };
  })();

  // --- house_gaussian -------------------------------------------------------
  if (inp.forecasts.length > 0) {
    try {
      const slots = inp.forecasts.map((f) => slotOf(f.slot, f.capturedAt));
      const dominantSlot = slots.filter((s) => s === '10Z').length >= slots.length / 2 ? '10Z' : '22Z';
      const points = inp.forecasts.map((f) => {
        const st = statFor(f.model, slotOf(f.slot, f.capturedAt));
        return { model: f.model, value: correctPoint(Number(f.tmaxC), Number(st?.bias ?? 0)) };
      });
      const haveWeights = inp.forecasts.some((f) => statFor(f.model, slotOf(f.slot, f.capturedAt))?.weight != null);
      const weights = new Map(
        inp.forecasts.map((f) => {
          const st = statFor(f.model, slotOf(f.slot, f.capturedAt));
          return [f.model, haveWeights ? Number(st?.weight ?? 0) : 1 / inp.forecasts.length] as const;
        }),
      );
      const { mu } = ensembleStats(points, weights);
      if (Number.isNaN(mu)) throw new DistributionError('no weighted forecast points');
      const sigmaC = blendSigmaC(dominantSlot);
      const muNative = toNative(mu, unit);
      const sigmaNative = toNativeSigma(sigmaC);
      const probs = gaussianBucketProbs(muNative, sigmaNative, ladder);
      const hashBase = [
        'house_gaussian', String(lead), String(statsVersion),
        ...inp.forecasts.map((f) => f.id).sort(),
      ];
      await write('house_gaussian', probs, muNative, sigmaNative, hashBase, false);
      if (nowcastCtx) {
        const constrained = applyRunningMaxConstraint(probs, ladder, nowcastCtx.runningMax, nowcastCtx.lift);
        await write('house_gaussian', constrained, muNative, sigmaNative,
          [...hashBase, `ncast:${nowcastCtx.runningMax}:${nowcastCtx.lift?.p50 ?? ''}`], true);
      }
    } catch (e) {
      if (e instanceof DistributionError) await warnSkip('house_gaussian', e.message);
      else throw e;
    }
  }

  // --- house_ensemble -------------------------------------------------------
  const pool: number[] = [];
  const ensembleIds: string[] = [];
  for (const ens of inp.ensembles) {
    const bias = Number(inp.stats.find((s) => s.model === ens.model && s.lead === lead)?.bias ?? 0);
    for (const m of ens.members) pool.push(toNative(correctPoint(Number(m), bias), unit));
    ensembleIds.push(ens.id);
  }
  if (ensembleIds.length > 0) {
    try {
      const sigmaNative = toNativeSigma(blendSigmaC('10Z'));
      const probs = dressedEnsembleProbs(pool, sigmaNative, ladder); // throws under 20 members
      const muNative = pool.reduce((a, b) => a + b, 0) / pool.length;
      const hashBase = ['house_ensemble', String(lead), String(statsVersion), ...ensembleIds.sort()];
      await write('house_ensemble', probs, muNative, sigmaNative, hashBase, false);
      if (nowcastCtx) {
        const constrained = applyRunningMaxConstraint(probs, ladder, nowcastCtx.runningMax, nowcastCtx.lift);
        await write('house_ensemble', constrained, muNative, sigmaNative,
          [...hashBase, `ncast:${nowcastCtx.runningMax}:${nowcastCtx.lift?.p50 ?? ''}`], true);
      }
    } catch (e) {
      if (e instanceof DistributionError) await warnSkip('house_ensemble', e.message);
      else throw e;
    }
  }

  return out;
}
