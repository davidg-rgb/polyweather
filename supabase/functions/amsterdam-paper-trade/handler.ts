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
} from '../../../packages/core/src/index.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface PaperTradeDeps {
  now: Date;
  /** Override the target day (defaults to today, Amsterdam local) — for manual backfill triggers. */
  targetDate?: string;
}

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

  const stats = { target, armsAvailable, placed, gradeCandidates: pending.length, graded };
  log('amsterdam-paper-trade complete', stats);
  return stats;
}
