/**
 * functions/_shared/grading — gradeEvent, the single grading path
 * (ARCHITECTURE.md §6.12, ADR-09, ADR-16, C7, W18).
 *
 * Called from fetch-actuals on finalization AND from the grade-bets safety
 * sweep — the winner-claim CAS makes concurrent invocations produce exactly
 * one grading pass.
 */
import {
  evaluateBreakers,
  localDayWindow,
  winningBucket,
  type AppConfig,
  type BucketDef,
  type Unit,
} from '../../../packages/core/src/index.ts';
import type { DbPort } from './db.ts';
import type { Alert } from './slack.ts';

export interface GradeDeps {
  notify: (alert: Alert) => Promise<boolean>;
}

interface GradingContext {
  event: {
    id: string;
    slug: string;
    targetDate: string;
    unit: Unit;
    winningBucketIdx: number | null;
    gradingMismatch: boolean;
  };
  city: { slug: string; displayName: string; tz: string };
  icao: string | null;
  observation: { tmaxNative: number; nObs: number | null } | null;
  buckets: { idx: number; label: string; low: number | null; high: number | null; resolvedOutcome: string | null }[] | null;
}

export async function gradeEvent(
  db: DbPort,
  cfg: AppConfig,
  eventId: string,
  deps: GradeDeps,
): Promise<{ graded: boolean; winnerIdx?: number; mismatch?: boolean }> {
  const [raw] = await db.rpc<{ get_grading_context: GradingContext | null }>('get_grading_context', {
    p_event_id: eventId,
  });
  const ctx = raw?.get_grading_context;
  if (!ctx || !ctx.buckets || ctx.buckets.length === 0) return { graded: false };
  if (ctx.observation === null) return { graded: false }; // not finalized yet — recorded gap, not an error
  if (ctx.event.winningBucketIdx !== null) return { graded: false }; // already graded

  const ladder: BucketDef[] = ctx.buckets.map((b) => ({ low: b.low, high: b.high, unit: ctx.event.unit }));
  const winnerIdx = winningBucket(ladder, ctx.observation.tmaxNative); // LadderGapError → fail the run (CRITICAL)

  const [claim] = await db.rpc<{ claim_event_winner: boolean }>('claim_event_winner', {
    p_event_id: eventId,
    p_winner_idx: winnerIdx,
  });
  if (!claim?.claim_event_winner) return { graded: false }; // another grader won the CAS

  await db.rpc('settle_bets', {
    p_event_id: eventId,
    p_winner_idx: winnerIdx,
    p_resolution_native: ctx.observation.tmaxNative,
  });

  // Polymarket's own resolution cross-check (when poll/sweep stored outcomes).
  const polyWinner = ctx.buckets.find((b) => b.resolvedOutcome === 'win');
  let mismatch = false;
  if (polyWinner && polyWinner.idx !== winnerIdx) {
    mismatch = true;
    await db.rpc('flag_grading_mismatch', { p_event_id: eventId });
    await deps.notify({
      kind: 'GRADING_MISMATCH',
      severity: 'CRITICAL',
      title: `Grading mismatch on ${ctx.event.slug}`,
      body: `our winner idx ${winnerIdx} (${ctx.buckets[winnerIdx]?.label}) vs Polymarket idx ${polyWinner.idx} (${polyWinner.label}) — actual ${ctx.observation.tmaxNative}°${ctx.event.unit}`,
      dedupeKey: `grading-mismatch:${ctx.event.slug}`,
    });
  }

  // ADR-16: cutoff(event, lead) = local-midnight-of-target − lead × 24h.
  const { startUtc } = localDayWindow(ctx.city.tz, ctx.event.targetDate);
  const cutoff0 = startUtc;
  const cutoff1 = new Date(startUtc.getTime() - 24 * 3_600_000);
  const [scoreRaw] = await db.rpc<{ score_distributions: { winnerQ: Record<string, number> } }>(
    'score_distributions',
    {
      p_event_id: eventId,
      p_winner_idx: winnerIdx,
      p_cutoff_lead0: cutoff0.toISOString(),
      p_cutoff_lead1: cutoff1.toISOString(),
    },
  );
  const winnerQ = scoreRaw?.score_distributions?.winnerQ ?? {};

  const houseQ = winnerQ[cfg.championSource];
  const marketP = winnerQ['market_consensus'];
  await deps.notify({
    kind: 'RESOLUTION',
    severity: 'INFO',
    title: `${ctx.city.displayName}: ${ctx.buckets[winnerIdx]?.label} wins`,
    body:
      `actual ${ctx.observation.tmaxNative}°${ctx.event.unit} · ` +
      `our q ${houseQ !== undefined ? Number(houseQ).toFixed(3) : 'n/a'} vs market p ${marketP !== undefined ? Number(marketP).toFixed(3) : 'n/a'}` +
      (mismatch ? ' · ⚠ GRADING MISMATCH' : ''),
    dedupeKey: `resolution:${ctx.event.slug}`,
  });

  // Consecutive-loss breaker (the other rules run in calibration/health-monitor).
  const streaks = await db.rpc<{ city_slug: string; lead: string; streak: number }>('city_loss_streaks', {});
  const byCityLead = new Map<string, number>();
  for (const s of streaks) byCityLead.set(`${s.city_slug}:${s.lead}`, s.streak);
  const halts = evaluateBreakers(
    {
      consecutiveLossesByCityLead: byCityLead,
      dailyPnlPct: 0,
      drawdownPct: 0,
      rollingBrierByCity: new Map(),
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
  }

  return { graded: true, winnerIdx, mismatch };
}
