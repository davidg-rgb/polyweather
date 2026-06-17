/**
 * amsterdam-paper-trade — the daily Amsterdam paper-trade tick (the analytics-pivot deliverable).
 *
 * Two idempotent phases per run:
 *   PLACE  — for the target day's Amsterdam market, place any DUE arm (13/14/15/16 local) not yet on the
 *            board: $10 on our predicted whole-°C bucket (round of the running max known by that hour) at
 *            the live market ask. amsterdam_sim_place_inputs reconstructs each arm exactly from persisted
 *            intraday + snapshots; planPlacements (core) makes the decision; amsterdam_sim_record writes
 *            (ON CONFLICT DO NOTHING — odds lock at first placement).
 *   GRADE  — any pending bet whose EHAM observation has finalized is resolved win/loss + P&L (net of fee)
 *            by planSettlements (core) and written by amsterdam_sim_settle.
 *
 * Schedule 15:30 UTC = 17:30 local: all four arm hours have passed, so the day's bets are placed with
 * their as-of-hour odds and yesterday's pending bets grade once truth lands. NOT trading — see CLAUDE.md.
 */
import {
  type GradeInputRow,
  localDateAt,
  type PlaceInputs,
  planPlacements,
  planSettlements,
  planTruth,
  type TruthInputRow,
} from '../../../packages/core/src/index.ts';
import { fetchKnmiTx, type FetchJsonLike, KNMI_TRUTH_SOURCE } from '../_shared/knmi.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface PaperTradeDeps {
  now: Date;
  /** Override the target day (defaults to today, Amsterdam local) — for manual backfill triggers. */
  targetDate?: string;
  /**
   * Injected JSON fetcher (packages/io fetchJson) — used only to pull the recent KNMI decimal highs for
   * floor "truth accuracy". Optional: omit it (e.g. in tests) to skip the KNMI fetch; the truth fill from
   * already-stored amsterdam_truth still runs.
   */
  fetchJson?: FetchJsonLike;
}

/** How many trailing local days of KNMI to refresh each tick (catches the just-finalized day + any laggard). */
const KNMI_REFRESH_DAYS = 6;

/** The fixed Etc/GMT-2 clock the rest of the sim (intraday_advances.local_hour, the arms) uses. */
const AMS_TZ = 'Etc/GMT-2';

export async function amsterdamPaperTrade(ctx: JobCtx, deps: PaperTradeDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const target = deps.targetDate ?? localDateAt(AMS_TZ, deps.now);

  // --- PLACE: today's due arms ------------------------------------------------------------------
  const placeRows = await db.rpc<{ amsterdam_sim_place_inputs: PlaceInputs | null }>(
    'amsterdam_sim_place_inputs',
    { p_target: target, p_now: deps.now.toISOString() },
  );
  const input = placeRows[0]?.amsterdam_sim_place_inputs ?? null;
  let placed = 0;
  const armsAvailable = input?.arms.length ?? 0;
  if (input && input.arms.length > 0) {
    const toRecord = planPlacements(input);
    if (toRecord.length > 0) {
      const rec = await db.rpc<{ amsterdam_sim_record: number }>('amsterdam_sim_record', {
        p_rows: toRecord,
      });
      placed = Number(rec[0]?.amsterdam_sim_record ?? 0);
      log('placed paper bets', { target, placed, arms: toRecord.map((r) => r.armHour) });
    }
  }

  // --- GRADE: pending bets whose truth landed ----------------------------------------------------
  const gradeRows = await db.rpc<{ amsterdam_sim_grade_inputs: GradeInputRow[] }>(
    'amsterdam_sim_grade_inputs',
    {},
  );
  const pending = gradeRows[0]?.amsterdam_sim_grade_inputs ?? [];
  let graded = 0;
  if (pending.length > 0) {
    const settlements = planSettlements(pending);
    const res = await db.rpc<{ amsterdam_sim_settle: number }>('amsterdam_sim_settle', {
      p_settlements: settlements,
    });
    graded = Number(res[0]?.amsterdam_sim_settle ?? 0);
    log('graded paper bets', { graded, candidates: pending.length });
  }

  // --- TRUTH: floor "truth accuracy" vs the real decimal high (KNMI) -----------------------------
  // Independent of market grading (operator directive 2026-06-17): score our whole-°C call against
  // floor(true high) and log the decimal signed forecast error. KNMI (free, no-auth, 0.1°C) lands ~1–2
  // days after the day, same as WU finalization. The WHOLE block is best-effort: a KNMI outage — or this
  // function deployed ahead of migration 0043 — must never break the market place/grade tick above.
  let truthIngested = 0;
  let truthFilled = 0;
  try {
    if (deps.fetchJson) {
      const from = localDateAt(AMS_TZ, new Date(deps.now.getTime() - KNMI_REFRESH_DAYS * 86_400_000));
      const knmi = await fetchKnmiTx(deps.fetchJson, from, target, { timeoutMs: 8000, retries: 1 });
      if (knmi.length > 0) {
        const up = await db.rpc<{ amsterdam_truth_upsert: number }>('amsterdam_truth_upsert', {
          p_rows: knmi.map((r) => ({ dateLocal: r.dateLocal, txTenthsC: r.txTenthsC, source: KNMI_TRUTH_SOURCE })),
        });
        truthIngested = Number(up[0]?.amsterdam_truth_upsert ?? 0);
      }
    }
    // Fill floor-truth on any bet whose day now has a decimal actual (graded on the market or not).
    const truthInputs = await db.rpc<{ amsterdam_sim_truth_inputs: TruthInputRow[] }>('amsterdam_sim_truth_inputs', {});
    const truthPending = truthInputs[0]?.amsterdam_sim_truth_inputs ?? [];
    if (truthPending.length > 0) {
      const truthRows = planTruth(truthPending);
      const tr = await db.rpc<{ amsterdam_sim_truth_record: number }>('amsterdam_sim_truth_record', {
        p_rows: truthRows,
      });
      truthFilled = Number(tr[0]?.amsterdam_sim_truth_record ?? 0);
      log('filled floor-truth', { truthIngested, truthFilled, candidates: truthPending.length });
    }
  } catch (e) {
    log('truth phase failed (non-fatal — market tick unaffected)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const stats = { target, armsAvailable, placed, gradeCandidates: pending.length, graded, truthIngested, truthFilled };
  log('amsterdam-paper-trade complete', stats);
  return stats;
}
