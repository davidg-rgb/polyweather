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
 * CITY-LIVE.md §2 EXTENSION (migration 0085, staged DARK): alongside PLACE/GRADE the tick maintains the
 * longitudinal MAKER-ENTRY PAPER TWIN and the promotion board — ALL best-effort and DEPLOY-ORDER-SAFE, so a
 * fn deployed before 0085 is applied still places + grades byte-identically (the city-live RPCs are wrapped;
 * an undefined-function/table error marks the extension dark and skips the rest, never breaking the tick):
 *   1. after PLACE  — rest a maker twin at the lock-hour best_bid for each new placement (city_maker_twin_place)
 *   2. each tick    — conservative fill detection: a later ask ≤ the resting bid fills it (city_maker_twin_detect_fills)
 *   3. after GRADE  — grade filled twins at $0 maker fee; unfilled-at-resolution twins → 'unfilled' (city_maker_twin_grade)
 *   4. after GRADE  — compute buildCityPromotionBoard from city_sim_bets_for_promotion() and record it (best-effort)
 *
 * Schedule 10:00 UTC: every active city's last arm (14:00 local for WSSS=06:00 / OPKC=09:00 UTC) has
 * passed, so each arm is placed with its as-of-hour odds and yesterday's pending bets grade once truth
 * lands. NOT trading — see CLAUDE.md. NO KNMI floor-truth (EHAM-only); market grading drives the P&L.
 *
 * THE 0044/0081 TOP-LEVEL-ARRAY PORT TRAP. Both city_sim input RPCs are read tolerantly: city_sim_grade_inputs
 * returns { rows: [...] } (0044), and city_sim_active_configs was fixed the same way in 0081. Before 0081 that
 * config RPC returned a TOP-LEVEL jsonb array, which supabasePort (functions/_shared/db.ts) misclassifies as a
 * RETURNS TABLE row set and passes UNWRAPPED — so `cfgRows[0].city_sim_active_configs` was undefined → configs=[]
 * → cities:0/placed:0 on EVERY cron tick (the live defect, verified in prod job_runs 2026-07-03/07-04).
 * readActiveConfigs() below reads all three shapes so the handler is deploy-order-safe: it places whether or not
 * migration 0081 has been applied yet.
 */
import {
  buildCityPromotionBoard,
  type CityPromotionCity,
  type GradeInputRow,
  type PlaceInputs,
  planPlacements,
  planSettlements,
} from '../../../packages/core/src/index.ts';
import type { DbPort } from '../_shared/db.ts';
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

/**
 * The undefined-function/table error class (mirrors apps/web loaders.ts isUndefinedFunctionError, plus 42P01
 * undefined_table): PGRST202 (PostgREST schema-cache miss) / 42883 / 42P01 (Postgres) / their prose spellings.
 * Used to detect that migration 0085 has NOT been applied yet so the CITY-LIVE extension degrades silently.
 */
export function isUndefinedObjectError(message: string): boolean {
  if (/PGRST202|42883|42P01/i.test(message)) return true;
  return /(could not find the function|does not exist|not exist in the schema cache|no function matches|undefined table)/i.test(
    message,
  );
}

/**
 * Tolerantly read the active-config list across the THREE shapes city_sim_active_configs can arrive in —
 * the 0044/0081 top-level-array port trap. db.rpc() (supabasePort / PGlite twin) yields:
 *   (a) NEW RPC (0081, `{ rows: [...] }`) via PostgREST OR the twin → [{ city_sim_active_configs: { rows: [...] } }]
 *   (b) OLD RPC (top-level jsonb array) via PostgREST → supabasePort sees an array and passes it through
 *       UNWRAPPED, so cfgRows IS the bare configs array (the live defect: cfgRows[0].city_sim_active_configs
 *       was undefined → configs=[] → cities:0/placed:0 every tick).
 *   (c) OLD RPC via the PGlite twin (`select * from fn()`) → [{ city_sim_active_configs: [...] }] (array).
 * Check the wrapped shapes (a/c) FIRST — cfgRows is always an array, so the bare-array (b) fallback must be last.
 * Deploy-order-safe: the fixed handler places whether or not migration 0081 has been applied.
 */
function readActiveConfigs(cfgRows: unknown[]): ActiveConfig[] {
  const inner = (cfgRows[0] as { city_sim_active_configs?: unknown } | undefined)?.city_sim_active_configs;
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && 'rows' in inner) {
    return ((inner as { rows?: ActiveConfig[] }).rows ?? []); // (a) wrapped { rows: [...] }
  }
  if (Array.isArray(inner)) return inner as ActiveConfig[]; // (c) twin over the pre-0081 top-level-array RPC
  return (Array.isArray(cfgRows) ? cfgRows : []) as ActiveConfig[]; // (b) PostgREST-unwrapped bare array
}

export async function cityPaperTrade(ctx: JobCtx, deps: CityPaperTradeDeps): Promise<JobStats> {
  const { db, log } = ctx;

  // --- CITY-LIVE (0085) best-effort wrapper: deploy-order-safe. On an undefined-function/table error the
  // extension is marked DARK (0085 unapplied) and every subsequent city-live call short-circuits; any OTHER
  // error is logged and swallowed too (the maker twin + board are measurement-only and must NEVER break the
  // core PLACE/GRADE loop — CITY-LIVE.md §2 "board write best-effort; must not break placing/grading").
  let cityLiveDark = false;
  const cityLive = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (cityLiveDark) return undefined;
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isUndefinedObjectError(msg)) {
        cityLiveDark = true;
        log('city-live extension not applied (0085 dark) — skipping maker twin + promotion board', { label });
      } else {
        log('city-live extension step failed (best-effort, ignored)', { label, error: msg });
      }
      return undefined;
    }
  };

  // --- PLACE: each active city's due arms ---------------------------------------------------------
  const cfgRows = await db.rpc<unknown>('city_sim_active_configs', {});
  const configs = readActiveConfigs(cfgRows);
  let placedTotal = 0;
  let twinPlaced = 0;
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

    // CITY-LIVE §2.1: rest a maker twin at the lock-hour best_bid for each placement (idempotent). The RPC
    // recomputes the in-lock-hour bid from the SAME window the ask was locked in; skips buckets with no bid.
    const twin = await cityLive('twin-place', () =>
      db.rpc<{ city_maker_twin_place: number }>('city_maker_twin_place', {
        p_city_id: cfg.cityId,
        p_rows: toRecord,
      }),
    );
    twinPlaced += Number(twin?.[0]?.city_maker_twin_place ?? 0);
  }

  // CITY-LIVE §2.2: conservative maker-fill detection each tick (a later ask ≤ the resting bid fills it).
  const detect = await cityLive('twin-detect', () =>
    db.rpc<{ city_maker_twin_detect_fills: number }>('city_maker_twin_detect_fills', {}),
  );
  const twinFilled = Number(detect?.[0]?.city_maker_twin_detect_fills ?? 0);

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

  // CITY-LIVE §2.3: grade filled twins at $0 maker fee; unfilled-at-resolution twins → 'unfilled'.
  const twinGradeRes = await cityLive('twin-grade', () =>
    db.rpc<{ city_maker_twin_grade: number }>('city_maker_twin_grade', {}),
  );
  const twinGraded = Number(twinGradeRes?.[0]?.city_maker_twin_grade ?? 0);

  // CITY-LIVE §2.4: compute the promotion board from the graded ledger (+ previous board for prevStatus) and
  // record it. Best-effort — a board failure must not break placing/grading.
  const boardRowId = await cityLive('board', async () => {
    const bpRows = await db.rpc<{ city_sim_bets_for_promotion: { rows: CityPromotionCity[] } }>(
      'city_sim_bets_for_promotion',
      {},
    );
    const cities = bpRows[0]?.city_sim_bets_for_promotion?.rows ?? [];
    const board = buildCityPromotionBoard({ asOf: deps.now.toISOString(), cities });
    const rec = await db.rpc<{ city_promotion_record: number }>('city_promotion_record', { p_view: board });
    const id = Number(rec[0]?.city_promotion_record ?? 0);
    log('recorded promotion board', { rows: board.rows.length, boardId: id });
    return id;
  });

  const stats = {
    cities: configs.length,
    placed: placedTotal,
    placedByCity,
    gradeCandidates: pending.length,
    graded,
    twinPlaced,
    twinFilled,
    twinGraded,
    boardRecorded: boardRowId != null,
    cityLiveDark,
  };
  log('city-paper-trade complete', stats);
  return stats;
}
