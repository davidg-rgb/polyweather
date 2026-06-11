/**
 * PaperExecutor — deterministic pessimistic fill (ARCHITECTURE.md §6.20, W5/W9/W17).
 *
 * Fill price = WORSE of (walked stored ask, walked live ask) + cfg.paperSlippage —
 * pessimism must survive fast repricing (W9: a 29-min-old price in a market
 * that just moved on a METAR would be optimistic). The caps re-check AND the
 * conditional CAS fill execute inside ONE Postgres RPC (fill_bet_with_caps,
 * 0019) under pg_advisory_xact_lock — a TS-side check outside that lock would
 * re-open the W17 TOCTOU, so this class only PREPARES the fill terms.
 */
import {
  FillRejected,
  executableAsk,
  normalizeBook,
  takerFeeTotal,
  type RawClobBook,
} from '@weather-edge/core';
import type { ApprovedBet, FillResult, FillRpcResult, TradeExecutor, TradingDb } from './types.ts';

export interface PaperExecutorDeps {
  db: TradingDb;
  /** Live CLOB book for the YES token (re-fetched at fill time). */
  fetchBook: (tokenId: string) => Promise<unknown>;
  cfg: { paperSlippage: number; paperBookMaxAgeMin: number };
  now: () => Date;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export class PaperExecutor implements TradeExecutor {
  readonly mode = 'paper' as const;

  constructor(private readonly deps: PaperExecutorDeps) {}

  async place(bet: ApprovedBet): Promise<FillResult> {
    const { db, fetchBook, cfg } = this.deps;

    // Walked live ask at the recommended size; null when the book is
    // unreachable or empty — the stored book's freshness then decides.
    let liveWalked: number | null = null;
    try {
      const book = normalizeBook((await fetchBook(bet.tokenYes)) as RawClobBook);
      const walk = executableAsk(book, bet.recShares);
      if (walk.fillableShares > 0 && Number.isFinite(walk.avgPrice)) liveWalked = walk.avgPrice;
    } catch {
      liveWalked = null;
    }
    if (liveWalked === null) {
      const ageMin =
        (this.deps.now().getTime() - new Date(bet.recommendedAt).getTime()) / 60_000;
      if (ageMin > cfg.paperBookMaxAgeMin) {
        throw new FillRejected(
          'stale_book',
          `stored book ${ageMin.toFixed(1)} min old > ${cfg.paperBookMaxAgeMin} min and live book unavailable`,
          { details: [`stored book ${ageMin.toFixed(1)} min old`, 'live book unavailable'] },
        );
      }
    }

    const price = round6(Math.max(bet.execAsk, liveWalked ?? bet.execAsk) + cfg.paperSlippage);

    // Re-floor shares to the per-trade cap at the PESSIMISTIC price: a rec
    // clamped exactly at 2% would otherwise be unfillable by construction at
    // any worse-than-rec price (fewer shares at a worse price = strictly more
    // pessimism, never less). Bankroll here is advisory — the RPC re-derives
    // everything under the lock and stays strict (deviation logged in
    // BUILD-STATE.md); event/cluster/day headrooms are NOT pre-read (W17).
    let shares = bet.recShares;
    const [bk] = await db.rpc<{ current_bankroll: string }>('current_bankroll', {
      p_mode: bet.mode,
    });
    const perTradePct = Number(
      (await db.getConfigRows()).find((r) => r.key === 'perTradeCapPct')?.value ?? 0.02,
    );
    const perTradeCap = perTradePct * Number(bk?.current_bankroll ?? 0);
    if (shares * price > perTradeCap) shares = Math.floor(perTradeCap / price);

    const [res] = await db.rpc<{ fill_bet_with_caps: FillRpcResult }>('fill_bet_with_caps', {
      p_bet_id: bet.betId,
      p_price: price,
      p_shares: shares,
    });
    const out = res?.fill_bet_with_caps;
    switch (out?.outcome) {
      case 'filled':
        return {
          price: Number(out.price),
          shares: Number(out.shares),
          // RPC value is authoritative (same takerFeeTotal formula, §6.4) — the
          // row and the response can never disagree.
          feeUsd: Number(out.feeUsd ?? takerFeeTotal(price, shares, bet.feeRate)),
          mode: 'paper',
        };
      case 'caps':
        throw new FillRejected('caps', `caps breached at fill time: ${(out.details ?? []).join('; ')}`, {
          details: out.details ?? [],
          caps: out.caps,
        });
      case 'bad_status':
        throw new FillRejected('bad_status', `bet is '${out.status}', not 'recommended'`, {
          status: out.status,
        });
      default:
        throw new FillRejected('bad_status', 'bet not found at fill time', { status: 'not_found' });
    }
  }

  // Paper: no resting orders exist — §6.20 cancel is a no-op.
  async cancel(_betId: string): Promise<void> {}
}
