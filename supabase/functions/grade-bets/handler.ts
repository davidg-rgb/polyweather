/**
 * grade-bets — the grading safety sweep (ARCHITECTURE.md §6.19). Schedule: 0 6 * * *.
 *
 * (1) Events past local midnight +3h with finalized observations but no
 *     winner ⇒ gradeEvent each (missed in-line grading — the winner-claim CAS
 *     makes a concurrent fetch-actuals grader harmless).
 * (2) Events the MARKET already resolved but for which we have no finalized
 *     observation ⇒ CRITICAL — the truth pipeline is behind the market.
 * (3) F-033 live reconciliation (no-op in paper mode): data-api /positions
 *     for the operator wallet diffed against open live fills — any
 *     size/avgPrice/redeemable drift ⇒ CRITICAL POSITION_DRIFT.
 */
import { localDayWindow } from '../../../packages/core/src/index.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface GradeBetsDeps {
  notify: (alert: Alert) => Promise<boolean>;
  /** The single grading path (§6.12) — injected so tests drive the real orchestrator. */
  gradeEvent: (eventId: string) => Promise<{ graded: boolean }>;
  /**
   * data-api positions for the operator wallet (live mode only; absent when
   * POLY_FUNDER_ADDRESS is unset — the sweep then WARNs instead of guessing).
   */
  fetchPositions?: () => Promise<unknown>;
  now: Date;
}

interface SweepCtx {
  slug: string;
  targetDate: string;
  tz: string;
  hasTruth: boolean;
  marketResolved: boolean;
}

/** The §6.10-fixture-verified slice of a data-api position row. */
interface RawPosition {
  asset: string;
  size: number;
  avgPrice: number;
  redeemable: boolean;
  slug?: string;
}

interface LiveBet {
  betId: string;
  status: string;
  tokenYes: string;
  executedShares: string | number;
  executedPrice: string | number;
  eventSlug: string;
  label: string;
}

const GRACE_MS = 3 * 3_600_000; // local midnight + 3h
const dateISO = (v: unknown): string =>
  typeof v === 'string' ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10);

export async function gradeBetsSweep(ctx: JobCtx, deps: GradeBetsDeps): Promise<JobStats> {
  const { db, config: cfg, log } = ctx;
  const stats = { candidates: 0, graded: 0, truthBehindMarket: 0, reconciledBets: 0, drifts: 0 };

  // --- (1) + (2): the sweep ---------------------------------------------------
  const targets = await db.rpc<{ event_id: string; ctx: SweepCtx }>('sweep_grading_targets', {});
  for (const t of targets) {
    const { endUtc } = localDayWindow(t.ctx.tz, dateISO(t.ctx.targetDate));
    if (deps.now.getTime() < endUtc.getTime() + GRACE_MS) continue; // day not over + grace
    stats.candidates++;

    if (t.ctx.hasTruth) {
      const res = await deps.gradeEvent(t.event_id);
      if (res.graded) {
        stats.graded++;
        log('sweep graded missed event', { slug: t.ctx.slug });
      }
    } else if (t.ctx.marketResolved) {
      stats.truthBehindMarket++;
      await deps.notify({
        kind: 'TRUTH_BEHIND_MARKET',
        severity: 'CRITICAL',
        title: `Market resolved but no finalized observation: ${t.ctx.slug}`,
        body:
          `Polymarket shows a resolved outcome for ${t.ctx.targetDate} but the truth pipeline has no ` +
          `finalized observation — check WU/IEM fetch-actuals for this station.`,
        dedupeKey: `truth-behind:${t.ctx.slug}`,
      });
    }
    // No truth AND market unresolved: normal pending state — recorded gap, not an error.
  }

  // --- (3) F-033 live reconciliation -------------------------------------------
  if (cfg.tradingMode === 'live') {
    if (!deps.fetchPositions) {
      await deps.notify({
        kind: 'RECONCILIATION_SKIPPED',
        severity: 'WARN',
        title: 'Live reconciliation skipped',
        body: 'POLY_FUNDER_ADDRESS unset — data-api positions cannot be fetched (F-033).',
        dedupeKey: 'reconciliation-skipped',
      });
      return stats;
    }
    const raw = (await deps.fetchPositions()) as unknown;
    const positions: RawPosition[] = (Array.isArray(raw) ? raw : []).filter(
      (p): p is RawPosition =>
        typeof p === 'object' && p !== null &&
        typeof (p as RawPosition).asset === 'string' &&
        typeof (p as RawPosition).size === 'number' &&
        typeof (p as RawPosition).avgPrice === 'number' &&
        typeof (p as RawPosition).redeemable === 'boolean',
    );
    const byAsset = new Map(positions.map((p) => [p.asset, p]));

    const liveBets = (await db.rpc<{ bet: LiveBet }>('live_bets_for_reconciliation', {})).map((r) => r.bet);
    const driftLines: string[] = [];
    const matchedAssets = new Set<string>();

    for (const bet of liveBets) {
      stats.reconciledBets++;
      const pos = byAsset.get(bet.tokenYes);
      const ref = `${bet.eventSlug} · ${bet.label}`;
      if (!pos) {
        driftLines.push(`${ref}: filled bet has NO on-chain position (token …${bet.tokenYes.slice(-8)})`);
        continue;
      }
      matchedAssets.add(pos.asset);
      const shares = Number(bet.executedShares);
      const price = Number(bet.executedPrice);
      if (Math.abs(pos.size - shares) > 0.01) {
        driftLines.push(`${ref}: size ${pos.size} vs recorded ${shares}`);
      }
      if (Math.abs(pos.avgPrice - price) > 0.005) {
        driftLines.push(`${ref}: avgPrice ${pos.avgPrice} vs recorded ${price}`);
      }
      if (pos.redeemable) {
        driftLines.push(`${ref}: position redeemable but bet still 'filled' — grading is behind`);
      }
    }
    for (const pos of positions) {
      if (!matchedAssets.has(pos.asset)) {
        driftLines.push(`unknown position ${pos.slug ?? pos.asset.slice(-8)}: size ${pos.size} matches no live bet`);
      }
    }

    stats.drifts = driftLines.length;
    if (driftLines.length > 0) {
      await deps.notify({
        kind: 'POSITION_DRIFT',
        severity: 'CRITICAL',
        title: `Live position drift: ${driftLines.length} discrepancy(ies) (F-033)`,
        body: driftLines.join('\n'),
        dedupeKey: 'position-drift',
      });
    }
  }

  log('sweep complete', stats);
  return stats;
}
