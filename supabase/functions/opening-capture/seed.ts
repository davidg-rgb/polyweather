/**
 * opening-capture/seed — the on-demand house_gaussian seed (ADR-OC-14 / C1 / C1b / §6.10c).
 *
 * THE PROBLEM (verified): a freshly-listed flat-open market usually has NO house_gaussian — not because
 * forecasts are missing (snapshot-forecasts snapshots every mapped station for leads 0–16, 2×/day) but
 * because the EVENT is not yet discovered + has no buckets in market_buckets, so build-distributions never
 * built a dist for it (`buildDistributionForEvent` short-circuits on empty market_buckets — distributions.ts:82).
 *
 * THE SEED (in TS, NOT plpgsql — the OM snapshot is an outbound fetch + buildDistributionForEvent is TS):
 *   1. resolve the scoped city's keys (cityId + the mapped icao) — the §9R cities are all known/discovered.
 *   2. upsert_event (idempotent) so the event has an event_id.
 *   3. upsert_bucket per parsed bucket — MANDATORY (F9): build-distributions reads buckets ONLY from
 *      market_buckets, so without this the dist build no-ops on a brand-new event → houseProb null → a
 *      Phase-0.5 false NO-GO. The handler holds parsed.buckets, so this is data-in-hand.
 *   4. buildDistributionForEvent(seeded:true) — builds the house_gaussian from the EXISTING production
 *      forecasts (the common path). If it writes nothing (forecasts genuinely absent for this station+date),
 *      fall back to an on-demand OM snapshot of THIS one station (reusing the snapshot-forecasts logic, with
 *      the production slot so model_stats match — get_build_inputs matches stats by slot) then rebuild.
 *   5. the SEED-QUALITY gate (F15): a fresh dist can be degenerate even when it EXISTS (sparse models / an
 *      OM outlier / an under-calibrated lead). Require ≥ seedMinModels contributing models AND model_stats
 *      coverage AND a sane mode-confidence + sigma — else houseProb null (capture the depth, do NOT enter).
 *   6. read the latest house_gaussian back, JOINED to market_buckets for per-bucket labels, → a label→prob
 *      map the handler aligns to the LIVE Gamma buckets BY LABEL IDENTITY (W6/W6b — never positional).
 *
 * The seed tags its distribution + any forecast rows it writes as `seeded=true` so they are EXCLUDED from
 * dash_data / calibration / /amsterdam / the bets reader (F16-r9/F11-r10 — a scoped-city bot snapshot must
 * never become the scored champion there). Best-effort: any failure ⇒ {seeded:false} (capture depth anyway).
 */
import {
  forecastUrl,
  parseMultiModelDaily,
  leadDays,
  seedBiasCorrect,
  type AppConfig,
  type ParsedEvent,
} from '../../../packages/core/src/index.ts';
import { buildDistributionForEvent } from '../_shared/distributions.ts';
import type { BotConfig } from '../../../packages/core/src/sim/opening-convergence.ts';
import type { DbPort } from '../_shared/db.ts';
import type { JobCtx } from '../_shared/runJob.ts';

export interface SeedStation {
  icao: string;
  lat: number | string;
  lon: number | string;
  tz: string;
}

export interface SeedDeps {
  db: DbPort;
  cfg: AppConfig;
  botCfg: BotConfig;
  fetchJson: (url: string) => Promise<unknown>;
  now: Date;
  omForecastBase: string;
  omApiKey?: string;
  /** the enabled non-ensemble model slugs (list_enabled_models — fetched once per tick). */
  models: string[];
  /** list_active_stations (fetched once per tick) — for the rare OM re-snapshot fallback's lat/lon. */
  stations: SeedStation[];
  log: JobCtx['log'];
  /** Injectable for tests; defaults to the real shared builder. */
  buildDist?: typeof buildDistributionForEvent;
}

export interface SeedResult {
  seeded: boolean;
  eventId: string | null;
  /** the per-bucket house prob keyed by the bucket LABEL (identity alignment — W6). */
  probsByLabel: Map<string, number>;
  reason?: string;
}

interface LatestHouseDist {
  probs: number[] | null;
  sigma: number | null;
  /** ISO timestamp of the dist's made_at — drives the seedFreshnessMin reuse throttle (EDGE2-1). */
  madeAt: string | null;
  buckets: { idx: number; label: string; prob: number | null }[] | null;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const NO_NOTIFY = async (): Promise<boolean> => false; // the seed's skips are EXPECTED — the deadman is the alarm

/** First element of a supabasePort rpc result (table fns → the row; scalar/jsonb fns → {[fn]: value}). */
function one<T>(rows: T[]): T | undefined {
  return rows[0];
}

/** The scoped-city keys the handler resolved once (via bot_resolve_event_keys) + passes in. */
export interface SeedKeys {
  cityId: string;
  icao: string | null;
  /** the DST-aware IANA tz (the handler already fail-closed on a missing/Etc tz) — for the lead computation. */
  tz: string;
}

export async function seedHouseDist(
  ev: ParsedEvent,
  polyEventId: string,
  keys: SeedKeys,
  deps: SeedDeps,
): Promise<SeedResult> {
  const empty: SeedResult = { seeded: false, eventId: null, probsByLabel: new Map() };
  try {
    // ── 1. keys (resolved by the handler) ────────────────────────────────────────────────────────────────
    if (!keys.cityId) return { ...empty, reason: 'unknown_city' };
    const icao = keys.icao;
    if (!icao) return { ...empty, reason: 'unmapped_station' };

    // ── 2. discover/upsert the event (idempotent) → event_id ─────────────────────────────────────────────
    const evRow = one(
      await deps.db.rpc<{ event_id: string; is_new: boolean }>('upsert_event', {
        p_poly_event_id: polyEventId,
        p_slug: ev.slug,
        p_kind: ev.kind,
        p_city_id: keys.cityId,
        p_icao: icao,
        p_target_date: ev.targetDate,
        p_unit: ev.unit,
        p_neg_risk_market_id: ev.negRiskMarketId,
        p_accepting: ev.acceptingOrders,
        p_volume24h: ev.eventVolume24h,
        p_liquidity: ev.liquidity,
        p_ladder_ok: ev.ladderProblems.length === 0,
        p_ladder_problems: ev.ladderProblems,
      }),
    );
    const eventId = evRow?.event_id ?? null;
    if (!eventId) return { ...empty, reason: 'upsert_event_failed' };

    // THE CONVERGENCE/ACCURACY SPLIT (2026-06-29): the convergence seed centers on the RAW cross-model
    // consensus (the crowd's Schelling point), NOT our bias-corrected accuracy forecast — see ConsensusSource.
    const buildDist = deps.buildDist ?? buildDistributionForEvent;
    const biasCorrect = seedBiasCorrect(deps.botCfg.consensusSource);
    if (deps.botCfg.consensusSource === 'wunderground') {
      deps.log('consensusSource=wunderground not yet wired — using the ensemble_raw consensus proxy', { city: ev.citySlug });
    }

    // helpers for the read-then-build flow below.
    const readDist = async (): Promise<LatestHouseDist | null> => {
      const r = one(await deps.db.rpc<{ latest_house_dist: LatestHouseDist | null }>('latest_house_dist', { p_event_id: eventId }));
      return r?.latest_house_dist ?? null;
    };
    const usable = (d: LatestHouseDist | null): boolean =>
      !!d && Array.isArray(d.buckets) && d.buckets.length > 0 && Array.isArray(d.probs) && d.probs.length > 0;

    // ── 3. seedFreshnessMin throttle — reuse a FRESH existing house_gaussian, skipping the rebuild + OM entirely.
    // The OM re-snapshot must fire ONLY when the dist is genuinely ABSENT, not merely when buildDistributionForEvent
    // wrote 0 rows: upsert_distribution is on-conflict-do-nothing, so an UNCHANGED dist (identical inputs_hash) also
    // returns written=0 — the old `built.written === 0` trigger therefore re-ran the OM fetch on EVERY 2-min tick for
    // every flat-open event (OM quota/rate-limit risk shared with production snapshot-forecasts) — EDGE2-1.
    let dist = await readDist();
    const freshMs = Math.max(0, deps.botCfg.seedFreshnessMin) * 60_000;
    const madeMs = dist?.madeAt ? Date.parse(dist.madeAt) : NaN;
    const isFresh = usable(dist) && Number.isFinite(madeMs) && deps.now.getTime() - madeMs < freshMs;

    if (!isFresh) {
      // upsert the walked ladder into market_buckets (F9 — build-distributions reads buckets ONLY from there).
      // The 12-arg upsert_bucket (0012): the 6 fee/reward args (0054) are omitted — they default where present and
      // prod carries the 12-arg sig, so 12 args resolves against BOTH signatures (PostgREST matches the named set).
      for (let i = 0; i < ev.buckets.length; i++) {
        const b = ev.buckets[i]!;
        await deps.db.rpc('upsert_bucket', {
          p_event_id: eventId,
          p_bucket_idx: i,
          p_label: b.label,
          p_low: b.def.low,
          p_high: b.def.high,
          p_poly_market_id: b.marketId,
          p_condition_id: b.conditionId,
          p_token_yes: b.tokenYes,
          p_token_no: b.tokenNo,
          p_tick: b.tickSize,
          p_min_order: b.minOrderSize,
          p_fee_rate: b.feeRate,
        });
      }

      // build the house_gaussian (seeded) from existing production forecasts.
      await buildDist(deps.db, deps.cfg, eventId, { notify: NO_NOTIFY, now: deps.now, seeded: true, biasCorrect });
      dist = await readDist();

      if (!usable(dist)) {
        // genuinely no dist — forecasts absent for this station+date. Snapshot THIS one station now (rare fallback).
        const st = deps.stations.find((s) => s.icao === icao);
        if (st && deps.models.length > 0) {
          try {
            const json = await deps.fetchJson(
              forecastUrl(deps.omForecastBase, { lat: Number(st.lat), lon: Number(st.lon) }, deps.models, 16, deps.omApiKey),
            );
            const parsed = parseMultiModelDaily(json, deps.models);
            const slot = deps.now.getUTCHours() < 16 ? '10Z' : '22Z'; // production slot → model_stats match
            const rows = parsed
              .filter((r) => r.targetDate === ev.targetDate)
              .map((r) => ({
                icao,
                model: r.model,
                target_date: r.targetDate,
                lead_days: leadDays(deps.now, r.targetDate, st.tz),
                tmax_c: r.tmaxC,
                snapshot_slot: slot,
                source: 'forecast_api',
                captured_at: deps.now.toISOString(),
                seeded: true,
              }))
              .filter((r) => r.lead_days >= 0 && r.lead_days <= 16);
            if (rows.length > 0) {
              await deps.db.rpc('upsert_forecast_rows', { p_rows: rows });
              await buildDist(deps.db, deps.cfg, eventId, { notify: NO_NOTIFY, now: deps.now, seeded: true, biasCorrect });
              dist = await readDist();
            }
          } catch (e) {
            deps.log('seed OM snapshot fallback failed (non-fatal)', { icao, error: msg(e) });
          }
        }
      }
    }

    // ── 4. the F15 quality gate ──────────────────────────────────────────────────────────────────────────
    if (!dist || !Array.isArray(dist.buckets) || dist.buckets.length === 0) {
      return { ...empty, eventId, reason: 'no_dist' };
    }

    // gate calibration coverage on the EVENT'S lead (model_stats is keyed by lead_days) — a station calibrated
    // at other leads but not this one is not usable signal here (F15 / §17; station-wide would over-count).
    const lead = leadDays(deps.now, ev.targetDate, keys.tz);
    const qRow = one(await deps.db.rpc<{ bot_seed_quality: { nModels: number; hasStats: boolean } }>('bot_seed_quality', {
      p_icao: icao,
      p_target_date: ev.targetDate,
      p_lead: Number.isFinite(lead) ? lead : null,
    }));
    const q = qRow?.bot_seed_quality ?? { nModels: 0, hasStats: false };
    const probs = (dist.probs ?? []).filter((p) => Number.isFinite(p));
    const modeProb = probs.length > 0 ? Math.max(...probs) : 0;
    const sigma = dist.sigma;
    const qualityOk =
      q.nModels >= deps.botCfg.seedMinModels &&
      q.hasStats === true &&
      modeProb >= 0.12 && // not a ~uniform (uninformative) dist
      modeProb <= 0.97 && // not an implausibly-spiked dist
      sigma != null && Number.isFinite(sigma) && sigma > 0 && sigma < 12;
    if (!qualityOk) {
      return { ...empty, eventId, reason: `quality_gate(models=${q.nModels},stats=${q.hasStats},mode=${modeProb.toFixed(2)},sigma=${sigma ?? 'null'})` };
    }

    // ── 6. label→prob map (the handler aligns to the LIVE Gamma buckets BY LABEL IDENTITY — W6) ───────────
    const probsByLabel = new Map<string, number>();
    for (const b of dist.buckets) {
      if (b.label != null && Number.isFinite(b.prob)) probsByLabel.set(b.label, b.prob as number);
    }
    return { seeded: true, eventId, probsByLabel };
  } catch (e) {
    deps.log('seedHouseDist failed (non-fatal — capture depth, houseProb null)', { city: ev.citySlug, slug: ev.slug, error: msg(e) });
    return { ...empty, reason: `threw:${msg(e)}` };
  }
}
