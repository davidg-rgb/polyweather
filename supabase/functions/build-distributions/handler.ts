/** build-distributions — house & challenger probabilities for every buildable event (§6.16). */
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
