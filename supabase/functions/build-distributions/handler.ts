/**
 * build-distributions — house & challenger probabilities for every buildable event (§6.16).
 *
 * Loops list_buildable_events() (HD-1 / ADR-18 / migration 0028: open, ungraded, ladder-ok
 * events with a CURRENT station mapping — operator verification NOT required) and calls
 * buildDistributionForEvent per event. Pure analytics: writes bucket_probabilities, never
 * bets. The handler has no verified check of its own — the only behavioral lever is the RPC
 * body. Do not gate this loop on verified/betting_enabled (R-A9 re-coupling).
 */
import type { JobCtx, JobStats } from '../_shared/runJob.ts';
import { buildDistributionForEvent, type BuildDeps } from '../_shared/distributions.ts';

export async function buildDistributions(ctx: JobCtx, deps: BuildDeps): Promise<JobStats> {
  const events = await ctx.db.rpc<{ event_id: string }>('list_buildable_events', {});
  let written = 0;
  let skipped = 0;
  for (const ev of events) {
    const r = await buildDistributionForEvent(ctx.db, ctx.config, ev.event_id, deps);
    written += r.written;
    skipped += r.skipped;
  }
  const stats = { events: events.length, written, skipped };
  ctx.log('distributions complete', stats);
  return stats;
}
