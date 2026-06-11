/**
 * LiveExecutor — the real order path, DORMANT (ARCHITECTURE.md §6.20, F-032).
 *
 * Compiled + unit-tested against mocks from day one; constructible only behind
 * a passing goLiveGate (execute-bet enforces that — C1). The clob client and
 * POLY_PRIVATE_KEY live ONLY in this file (§15 grep invariant); production
 * constructs the client via dynamic npm: specifiers (Deno edge runtime),
 * tests inject a mock factory.
 *
 * Phase A semantics: GTC limit at the recommendation's executable ask
 * (taker-or-better); the maker-resting strategy is a §12 Phase-5 enhancement.
 * getOrder's response fields are mock-verified only — re-verify against the
 * live CLOB at P10 go-live (docs/GO-LIVE-CHECKLIST).
 */
import { ExecutionError, FillRejected } from '@weather-edge/core';
import type { ApprovedBet, FillResult, FillRpcResult, TradeAlert, TradeExecutor, TradingDb } from './types.ts';

/** The slice of @polymarket/clob-client this executor touches. */
export interface ClobClientish {
  getTickSize(tokenID: string): Promise<number | string>;
  createOrder(
    args: { tokenID: string; price: number; size: number; side: 'BUY' | 'SELL' },
    options: { tickSize: number; negRisk: boolean },
  ): Promise<unknown>;
  postOrder(order: unknown, orderType: 'GTC'): Promise<{ orderID?: string; success?: boolean }>;
  getOrder(orderID: string): Promise<{
    status?: string;
    price?: string | number;
    size_matched?: string | number;
  }>;
  cancelOrder(payload: { orderID: string }): Promise<unknown>;
}

export interface LiveExecutorDeps {
  db: TradingDb;
  /** Mock in tests; createClobClient (below) in the Deno edge runtime. */
  client: () => Promise<ClobClientish>;
  notify: (alert: TradeAlert) => Promise<boolean>;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Deno.env in Edge Functions, process.env elsewhere — local copy so this package depends on nothing above it. */
function envVar(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env[name];
}

/**
 * Production client factory: ClobClient(host, chainId=137, signer from
 * POLY_PRIVATE_KEY, creds via createOrDeriveApiKey). Dynamic non-literal
 * specifiers: resolved by Deno at run time, invisible to tsc/Node — nothing
 * is installed until the live phase actually deploys it.
 */
export async function createClobClient(): Promise<ClobClientish> {
  const key = envVar('POLY_PRIVATE_KEY');
  if (!key) {
    throw new ExecutionError('ERR_NO_KEY', 'POLY_PRIVATE_KEY missing from execute-bet function secrets');
  }
  const ethersSpec = 'npm:ethers@5';
  const clobSpec = 'npm:@polymarket/clob-client@4';
  const { Wallet } = (await import(ethersSpec)) as { Wallet: new (k: string) => unknown };
  const { ClobClient } = (await import(clobSpec)) as {
    ClobClient: new (host: string, chainId: number, signer: unknown, creds?: unknown, sigType?: number, funder?: string) => ClobClientish & {
      createOrDeriveApiKey(): Promise<unknown>;
    };
  };
  const signer = new Wallet(key);
  const sigType = Number(envVar('POLY_SIGNATURE_TYPE') ?? 0);
  const funder = envVar('POLY_FUNDER_ADDRESS');
  const bootstrap = new ClobClient('https://clob.polymarket.com', 137, signer, undefined, sigType, funder);
  const creds = await bootstrap.createOrDeriveApiKey();
  return new ClobClient('https://clob.polymarket.com', 137, signer, creds, sigType, funder);
}

export class LiveExecutor implements TradeExecutor {
  readonly mode = 'live' as const;

  constructor(private readonly deps: LiveExecutorDeps) {}

  async place(bet: ApprovedBet): Promise<FillResult> {
    const { db, notify } = this.deps;
    let orderId: string | undefined;
    let limit = bet.execAsk;
    try {
      const client = await this.deps.client();
      // Tick-size & min-size re-fetched per market; BUY limit rounds DOWN to
      // the grid — never pay above the recommendation's executable ask.
      const tick = Number(await client.getTickSize(bet.tokenYes));
      if (tick > 0) limit = round6(Math.floor((bet.execAsk + 1e-9) / tick) * tick);
      if (bet.recShares < bet.minOrderSize) {
        throw new ExecutionError(
          'ERR_MIN_SIZE',
          `recShares ${bet.recShares} < market min order size ${bet.minOrderSize}`,
        );
      }
      const order = await client.createOrder(
        { tokenID: bet.tokenYes, price: limit, size: bet.recShares, side: 'BUY' },
        { tickSize: tick, negRisk: true },
      );
      const posted = await client.postOrder(order, 'GTC');
      orderId = posted?.orderID;
      if (!orderId) {
        throw new ExecutionError('ERR_CLOB_POST', 'postOrder returned no orderID');
      }

      const status = await client.getOrder(orderId);
      if (status?.status === 'matched') {
        const px = round6(Number(status.price ?? limit));
        const matched = Math.floor(Number(status.size_matched ?? bet.recShares));
        const [res] = await db.rpc<{ fill_bet_with_caps: FillRpcResult }>('fill_bet_with_caps', {
          p_bet_id: bet.betId,
          p_price: px,
          p_shares: matched,
        });
        const out = res?.fill_bet_with_caps;
        if (out?.outcome !== 'filled') {
          // A real order matched but the record was refused — operational
          // anomaly (poll-markets sized within caps); surface loudly.
          throw new ExecutionError(
            'ERR_FILL_RECORD',
            `live order ${orderId} matched but fill record refused: ${out?.outcome} ${(out?.details ?? []).join('; ')}`,
          );
        }
        return { price: Number(out.price), shares: Number(out.shares), feeUsd: Number(out.feeUsd), mode: 'live' };
      }

      // Posted but unmatched: record the resting GTC so poll-markets' expiry
      // can pull it via execute-bet {action:'cancel'} (§6.20a chokepoint).
      await db.rpc('note_resting_order', { p_bet_id: bet.betId, p_order_id: orderId });
      return { price: limit, shares: 0, feeUsd: 0, mode: 'live' };
    } catch (e) {
      // NEVER retries placement automatically — no accidental doubles
      // (idempotency by client order id). Bet → 'execution_failed' + CRITICAL.
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await db.rpc('set_bet_execution_failed', { p_bet_id: bet.betId, p_error: message });
      await notify({
        kind: 'EXECUTION_FAIL',
        severity: 'CRITICAL',
        title: `Live execution failed: ${bet.eventSlug} · ${bet.label}`,
        body: `${message}${orderId ? `\norder ${orderId} may be resting — verify on Polymarket` : ''}`,
        dedupeKey: `exec-fail:${bet.betId}`,
      });
      if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
      throw new ExecutionError('ERR_CLOB', message);
    }
  }

  /** Pull a resting GTC order recorded by place() (notes 'resting:{orderID}'). */
  async cancel(betId: string): Promise<void> {
    const [row] = await this.deps.db.rpc<{ bet_for_execution: { notes?: string | null } | null }>(
      'bet_for_execution',
      { p_bet_id: betId },
    );
    const notes = row?.bet_for_execution?.notes ?? '';
    const m = /resting:(\S+)/.exec(notes);
    if (!m) return; // nothing resting — cancel is a no-op
    const client = await this.deps.client();
    await client.cancelOrder({ orderID: m[1]! });
  }
}
