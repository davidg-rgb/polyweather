/**
 * city-paper-trade — the daily multi-city paper-trade tick (the analytics-pivot deliverable, generalized).
 *
 * The Amsterdam sim (amsterdam-paper-trade) for N operator-chosen cities (migration 0070): Singapore +
 * Karachi today, any city by a city_sim_config row. Two idempotent phases per run:
 *   PLACE  — for each ACTIVE city, place any DUE arm (its config arm_hours, local) not yet on the board:
 *            stake on our predicted whole-native-° bucket (round of the running-max floor known by that
 *            hour, lifted to the bias-corrected lead-1 forecast at early arms) at the in-lock-hour ask.
 *            city_sim_place_inputs reconstructs each arm; planPlacements (core) decides; city_sim_record
 *            writes (ON CONFLICT DO NOTHING — odds lock at first placement).
 *   GRADE  — any pending bet (any city) whose observation has finalized resolves win/loss + P&L (net of
 *            fee) via planSettlements (core), written by city_sim_settle.
 *
 * Schedule 10:00 UTC: every active city's last arm (14:00 local for WSSS=06:00 / OPKC=09:00 UTC) has
 * passed, so each arm is placed with its as-of-hour odds and yesterday's pending bets grade once truth
 * lands. NOT trading — see CLAUDE.md. NO KNMI floor-truth (EHAM-only); market grading drives the P&L.
 */
import {
  type GradeInputRow,
  type PlaceInputs,
  planPlacements,
  planSettlements,
} from '../../../packages/core/src/index.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface CityPaperTradeDeps {
  now: Date;
  /** Override the target day (defaults to each city's local today) — for manual backfill triggers. */
  targetDate?: string;
}

interface ActiveConfig {
  cityId: string;
  slug: string;
  icao: string;
  unit: string;
  tz: string;
  stakeUsd: number;
}

/** A place_inputs payload carries the standard PlaceInputs plus the city echo fields. */
type CityPlaceInputs = (PlaceInputs & { cityId: string; icao: string; unit: string; stakeUsd: number }) | null;

export async function cityPaperTrade(ctx: JobCtx, deps: CityPaperTradeDeps): Promise<JobStats> {
  const { db, log } = ctx;

  // --- PLACE: each active city's due arms ---------------------------------------------------------
  const cfgRows = await db.rpc<{ city_sim_active_configs: ActiveConfig[] }>('city_sim_active_configs', {});
  const configs = cfgRows[0]?.city_sim_active_configs ?? [];
  let placedTotal = 0;
  const placedByCity: Record<string, number> = {};

  for (const cfg of configs) {
    const placeRows = await db.rpc<{ city_sim_place_inputs: CityPlaceInputs }>('city_sim_place_inputs', {
      p_city_id: cfg.cityId,
      p_target: deps.targetDate ?? null,
      p_now: deps.now.toISOString(),
    });
    const input = placeRows[0]?.city_sim_place_inputs ?? null;
    if (!input || input.arms.length === 0) continue;
    const toRecord = planPlacements(input, { stakeUsd: cfg.stakeUsd });
    if (toRecord.length === 0) continue;
    const rec = await db.rpc<{ city_sim_record: number }>('city_sim_record', {
      p_city_id: cfg.cityId,
      p_icao: cfg.icao,
      p_unit: cfg.unit,
      p_rows: toRecord,
    });
    const n = Number(rec[0]?.city_sim_record ?? 0);
    placedByCity[cfg.slug] = n;
    placedTotal += n;
    if (n > 0) log('placed paper bets', { city: cfg.slug, placed: n, arms: toRecord.map((r) => r.armHour) });
  }

  // --- GRADE: pending bets (all cities) whose truth landed ----------------------------------------
  // The RPC returns { rows: GradeInputRow[] } (wrapped, the 0044 trap — supabasePort misreads a bare array
  // as a RETURNS TABLE row set). Read `.rows`.
  const gradeRows = await db.rpc<{ city_sim_grade_inputs: { rows: GradeInputRow[] } }>(
    'city_sim_grade_inputs',
    {},
  );
  const pending = gradeRows[0]?.city_sim_grade_inputs?.rows ?? [];
  let graded = 0;
  if (pending.length > 0) {
    const settlements = planSettlements(pending);
    const res = await db.rpc<{ city_sim_settle: number }>('city_sim_settle', { p_settlements: settlements });
    graded = Number(res[0]?.city_sim_settle ?? 0);
    log('graded paper bets', { graded, candidates: pending.length });
  }

  const stats = { cities: configs.length, placed: placedTotal, placedByCity, gradeCandidates: pending.length, graded };
  log('city-paper-trade complete', stats);
  return stats;
}
