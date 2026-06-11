/**
 * LiveExecutor (§6.20, F-032 — DORMANT) against a clob-client mock: order
 * params verbatim (tokenID, price = tick-rounded exec_ask, GTC, negRisk:true),
 * matched/resting/error paths, NO auto-retry on placement error, cancel pulls
 * the resting order recorded in notes.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionError } from '@weather-edge/core';
import { LiveExecutor, createClobClient, type ApprovedBet, type ClobClientish, type TradeAlert } from '../src/index.ts';

const bet: ApprovedBet = {
  betId: 'b-1',
  status: 'recommended',
  mode: 'live',
  eventId: 'e-1',
  eventSlug: 'highest-temperature-in-seoul-on-june-11',
  citySlug: 'seoul',
  label: '22°C',
  tokenYes: 'tok-yes-77digit',
  feeRate: 0.05,
  minOrderSize: 5,
  tickSize: 0.01,
  execAsk: 0.275,
  recShares: 74,
  recStakeUsd: 19.98,
  recommendedAt: '2026-06-11T12:00:00Z',
  notes: null,
};

function mockClient(overrides: Partial<ClobClientish> = {}): ClobClientish {
  return {
    getTickSize: vi.fn(async () => '0.01'),
    createOrder: vi.fn(
      async (
        args: { tokenID: string; price: number; size: number; side: 'BUY' | 'SELL' },
        opts: { tickSize: number; negRisk: boolean },
      ) => ({ signed: true, args, opts }),
    ),
    postOrder: vi.fn(async () => ({ orderID: '0xORDER', success: true })),
    getOrder: vi.fn(async () => ({ status: 'matched', price: '0.27', size_matched: '74' })),
    cancelOrder: vi.fn(async () => ({ canceled: true })),
    ...overrides,
  };
}

function mockDb(fillResult: Record<string, unknown> = { outcome: 'filled', price: 0.27, shares: 74, feeUsd: 0.7293 }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    db: {
      async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
        calls.push({ fn, args });
        if (fn === 'fill_bet_with_caps') return [{ fill_bet_with_caps: fillResult }] as T[];
        if (fn === 'set_bet_execution_failed') return [{ set_bet_execution_failed: true }] as T[];
        if (fn === 'bet_for_execution') return [{ bet_for_execution: { notes: 'resting:0xABC' } }] as T[];
        return [] as T[];
      },
      async getConfigRows() {
        return [];
      },
    },
  };
}

describe('LiveExecutor (§6.20 — mock-tested, dormant)', () => {
  it('matched: order params verbatim — tick-rounded limit, BUY, GTC, negRisk:true — then the fill RPC records it', async () => {
    const client = mockClient();
    const { db, calls } = mockDb();
    const alerts: TradeAlert[] = [];
    const exec = new LiveExecutor({ db, client: async () => client, notify: async (a) => (alerts.push(a), true) });

    const fill = await exec.place(bet);

    // 0.275 rounds DOWN to the 0.01 grid → 0.27 (never pay above the rec's executable ask)
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.createOrder).toHaveBeenCalledWith(
      { tokenID: 'tok-yes-77digit', price: 0.27, size: 74, side: 'BUY' },
      { tickSize: 0.01, negRisk: true },
    );
    expect(client.postOrder).toHaveBeenCalledTimes(1);
    expect(client.postOrder).toHaveBeenCalledWith(expect.anything(), 'GTC');
    const rpc = calls.find((c) => c.fn === 'fill_bet_with_caps');
    expect(rpc?.args).toEqual({ p_bet_id: 'b-1', p_price: 0.27, p_shares: 74 });
    expect(fill).toEqual({ price: 0.27, shares: 74, feeUsd: 0.7293, mode: 'live' });
    expect(alerts).toEqual([]);
  });

  it('resting: posted but unmatched → note_resting_order, shares 0 (poll-markets expiry cancels via the chokepoint)', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => ({ status: 'live' })) });
    const { db, calls } = mockDb();
    const exec = new LiveExecutor({ db, client: async () => client, notify: async () => true });

    const fill = await exec.place(bet);

    expect(calls.find((c) => c.fn === 'note_resting_order')?.args).toEqual({
      p_bet_id: 'b-1',
      p_order_id: '0xORDER',
    });
    expect(fill).toEqual({ price: 0.27, shares: 0, feeUsd: 0, mode: 'live' });
  });

  it('placement error: execution_failed + CRITICAL, NEVER retried (one createOrder, one postOrder)', async () => {
    const client = mockClient({ postOrder: vi.fn(async () => Promise.reject(new Error('clob 503'))) });
    const { db, calls } = mockDb();
    const alerts: TradeAlert[] = [];
    const exec = new LiveExecutor({ db, client: async () => client, notify: async (a) => (alerts.push(a), true) });

    await expect(exec.place(bet)).rejects.toThrow(ExecutionError);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.postOrder).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.fn === 'set_bet_execution_failed')?.args['p_bet_id']).toBe('b-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'EXECUTION_FAIL', severity: 'CRITICAL' });
  });

  it('matched but fill record refused: ERR_FILL_RECORD anomaly — execution_failed + CRITICAL', async () => {
    const client = mockClient();
    const { db, calls } = mockDb({ outcome: 'caps', details: ['daily cap: 19.98 > headroom 4.00'] });
    const alerts: TradeAlert[] = [];
    const exec = new LiveExecutor({ db, client: async () => client, notify: async (a) => (alerts.push(a), true) });

    await expect(exec.place(bet)).rejects.toMatchObject({ code: 'ERR_FILL_RECORD' });
    expect(calls.some((c) => c.fn === 'set_bet_execution_failed')).toBe(true);
    expect(alerts[0]).toMatchObject({ severity: 'CRITICAL' });
  });

  it('rejects below market min order size before any order call', async () => {
    const client = mockClient();
    const { db } = mockDb();
    const exec = new LiveExecutor({ db, client: async () => client, notify: async () => true });

    await expect(exec.place({ ...bet, recShares: 3 })).rejects.toMatchObject({ code: 'ERR_MIN_SIZE' });
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it('cancel pulls the resting order recorded in notes; no-op when nothing rests', async () => {
    const client = mockClient();
    const { db } = mockDb();
    const exec = new LiveExecutor({ db, client: async () => client, notify: async () => true });

    await exec.cancel('b-1'); // mock db notes: 'resting:0xABC'
    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: '0xABC' });

    const noNote = {
      ...db,
      rpc: async <T,>(fn: string): Promise<T[]> =>
        (fn === 'bet_for_execution' ? [{ bet_for_execution: { notes: null } }] : []) as T[],
    };
    const exec2 = new LiveExecutor({ db: noNote, client: async () => client, notify: async () => true });
    await exec2.cancel('b-1');
    expect(client.cancelOrder).toHaveBeenCalledTimes(1); // unchanged
  });

  it('createClobClient fails closed without the wallet key in env', async () => {
    const KEY = 'POLY_' + 'PRIVATE_KEY';
    const saved = process.env[KEY];
    delete process.env[KEY];
    try {
      await expect(createClobClient()).rejects.toMatchObject({ code: 'ERR_NO_KEY' });
    } finally {
      if (saved !== undefined) process.env[KEY] = saved;
    }
  });
});
