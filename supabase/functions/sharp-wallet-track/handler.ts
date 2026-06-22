/**
 * sharp-wallet-track — the daily sharp-wallet benchmark tick (WALLET-RECON-HANDOFF.md Build #1).
 *
 * Two idempotent phases per run (both best-effort — a Polymarket outage must never fail the job):
 *   LEADERBOARD — pull the WEATHER trader leaderboard (MONTH window) and snapshot it; the recorder also
 *                 auto-registers each wallet in tracked_wallets (source='leaderboard').
 *   POSITIONS   — for the seeded #1 sharp + the top-N leaderboard wallets, pull open positions and snapshot
 *                 every temperature-market leg (the revealed bets). The record RPC resolves event_id +
 *                 bucket_idx from our ladder via condition_id, so an Amsterdam leg lines up with our forecast.
 *
 * This is analytics, NOT trading and NOT a copy-trade (the live-trading thesis stays closed — CLAUDE.md /
 * FORECASTING-RD.md). The /amsterdam `sharps` card reads the persisted rows; we never re-hit Polymarket live.
 * Schedule 16:00 UTC daily.
 */
import {
  fetchWalletPositions,
  fetchWeatherLeaderboard,
  type FetchJsonLike,
  type LeaderboardEntry,
  SHARP_WALLET_ADDRESS,
  SHARP_WALLET_LABEL,
} from '../_shared/polymarket-wallet.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface SharpWalletTrackDeps {
  now: Date;
  /** Injected JSON fetcher (packages/io fetchJson). Omit in tests to skip the network (a no-op tick). */
  fetchJson?: FetchJsonLike;
  /** Leaderboard wallets (beyond the seeded sharp) to also ingest positions for (default 5). */
  topN?: number;
  /** Leaderboard page size (default 50). */
  leaderboardLimit?: number;
}

const POSITION_SIZE_THRESHOLD = 0.1; // drop dust
const FETCH_OPTS = { sizeThreshold: POSITION_SIZE_THRESHOLD, limit: 500, timeoutMs: 8000, retries: 1 } as const;

export async function sharpWalletTrack(ctx: JobCtx, deps: SharpWalletTrackDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const asOf = deps.now.toISOString().slice(0, 10); // UTC pull date
  const capturedAt = deps.now.toISOString();
  const topN = deps.topN ?? 5;

  if (!deps.fetchJson) {
    log('sharp-wallet-track skipped (no fetchJson injected)');
    return { asOf, leaderboardEntries: 0, leaderboardRecorded: 0, walletsIngested: 0, positionsRecorded: 0 };
  }
  const fetchJson = deps.fetchJson;

  // --- LEADERBOARD: snapshot the WEATHER board (auto-registers wallets) ---------------------------
  let leaderboard: LeaderboardEntry[] = [];
  let leaderboardRecorded = 0;
  try {
    leaderboard = await fetchWeatherLeaderboard(fetchJson, {
      timePeriod: 'MONTH',
      limit: deps.leaderboardLimit ?? 50,
      timeoutMs: 8000,
      retries: 1,
    });
    if (leaderboard.length > 0) {
      const r = await db.rpc<{ sharp_wallet_record_leaderboard: number }>('sharp_wallet_record_leaderboard', {
        p_captured_at: capturedAt,
        p_time_period: 'MONTH',
        p_rows: leaderboard,
      });
      leaderboardRecorded = Number(r[0]?.sharp_wallet_record_leaderboard ?? 0);
      log('recorded WEATHER leaderboard', { entries: leaderboard.length, leaderboardRecorded });
    }
  } catch (e) {
    log('leaderboard phase failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
  }

  // --- POSITIONS: the seeded sharp + top-N leaderboard wallets ------------------------------------
  // Dedup by lowercased address; the seeded sharp is always included even if it slipped off the board.
  const wallets = new Map<string, string>();
  wallets.set(SHARP_WALLET_ADDRESS, SHARP_WALLET_LABEL);
  for (const e of leaderboard.slice(0, topN)) wallets.set(e.address.toLowerCase(), e.label);

  let walletsIngested = 0;
  let positionsRecorded = 0;
  for (const [address, label] of wallets) {
    try {
      const positions = await fetchWalletPositions(fetchJson, address, FETCH_OPTS);
      // Keep only temperature-market legs (a parsed city); drops any non-weather noise.
      const rows = positions
        .filter((p) => p.citySlug !== null)
        .map((p) => ({
          conditionId: p.conditionId,
          citySlug: p.citySlug,
          targetDate: p.targetDate,
          outcome: p.outcome,
          sizeShares: p.sizeShares,
          avgPrice: p.avgPrice,
          curPrice: p.curPrice,
          curValueUsd: p.currentValueUsd,
          cashPnlUsd: p.cashPnlUsd,
          realizedPnlUsd: p.realizedPnlUsd,
          redeemable: p.redeemable,
          title: p.title,
        }));
      if (rows.length > 0) {
        const r = await db.rpc<{ sharp_wallet_record_positions: number }>('sharp_wallet_record_positions', {
          p_address: address,
          p_label: label,
          p_as_of: asOf,
          p_rows: rows,
        });
        positionsRecorded += Number(r[0]?.sharp_wallet_record_positions ?? 0);
      }
      walletsIngested++;
    } catch (e) {
      log('positions phase failed for wallet (non-fatal)', {
        address,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const stats = {
    asOf,
    leaderboardEntries: leaderboard.length,
    leaderboardRecorded,
    walletsIngested,
    positionsRecorded,
  };
  log('sharp-wallet-track complete', stats);
  return stats;
}
