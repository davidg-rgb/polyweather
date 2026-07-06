/**
 * LiveExecutor (§6.20, F-032 — DORMANT) against a clob-client mock: order
 * params verbatim (tokenID, price = tick-rounded exec_ask, GTC, negRisk:true),
 * matched/resting/error paths, NO auto-retry on placement error, cancel pulls
 * the resting order recorded in notes.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionError } from '@weather-edge/core';
import { LiveExecutor, createClobClient, redactConsoleClient, suppressConsoleDuring, withRedactedConsole, type ApprovedBet, type ClobClientish, type TradeAlert } from '../src/index.ts';

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

describe('suppressConsoleDuring (C51 bootstrap-hygiene follow-up)', () => {
  it('drops console output emitted inside the call, restores every method after, passes the value through', async () => {
    const before = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
    const spy = vi.fn();
    const savedError = console.error;
    console.error = spy; // stand-in for the daemon's real sink — must NOT be hit from inside
    try {
      const out = await suppressConsoleDuring(async () => {
        // synthetic bootstrap noise — the old v4 client console.error'd its derive→create 400; v2 no
        // longer logs (C75), so this is a stand-in and suppress drops it either way
        console.error('axios error with POLY_ADDRESS/POLY_SIGNATURE headers');
        console.log('request config dump');
        return 'creds';
      });
      expect(out).toBe('creds');
      expect(spy).not.toHaveBeenCalled();
      expect(console.error).toBe(spy); // our pre-call override restored, not clobbered
    } finally {
      console.error = savedError;
    }
    // and with no override in play, everything is back to the originals
    expect(console.warn).toBe(before.warn);
    expect(console.log).toBe(before.log);
    expect(console.info).toBe(before.info);
    expect(console.debug).toBe(before.debug);
  });

  it('restores the console and rethrows when the wrapped call throws (failures stay loud)', async () => {
    const original = console.error;
    await expect(
      suppressConsoleDuring(async () => {
        throw new ExecutionError('ERR_CLOB', 'bootstrap failed');
      }),
    ).rejects.toMatchObject({ code: 'ERR_CLOB' });
    expect(console.error).toBe(original);
  });
});

describe('withRedactedConsole + redactConsoleClient (C74 credential-leak hardening)', () => {
  const apiKey = '3f2a1b7c-9d4e-4a6b-8c1d-2e3f4a5b6c7d';
  const passphrase = 'a1b2c3d4-e5f6-4788-9a0b-1c2d3e4f5a6b';
  const signature = 'q7r8s9t0u1v2_w3x4-y5z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0=';
  // the kind of object a LEAKY client would console.error on a venue 400 (headers INCLUDED) — the old v4
  // clob-client did exactly this; the wrapper must mask it regardless of source (v2 no longer logs — C75)
  const credLine = (): string =>
    JSON.stringify({ status: 400, config: { headers: { POLY_API_KEY: apiKey, POLY_PASSPHRASE: passphrase, POLY_SIGNATURE: signature } } });
  const noSecrets = (printed: string): void => {
    for (const s of [apiKey, passphrase, signature]) expect(printed).not.toContain(s);
    expect(printed).toContain('REDACTED');
  };

  it('forwards console output but REDACTED, restores the pre-call sink after, passes the value through', async () => {
    const saved = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      const out = await withRedactedConsole(async () => {
        console.error('[CLOB Client] request error', credLine());
        return 'result';
      });
      expect(out).toBe('result');
      expect(spy).toHaveBeenCalledTimes(1);
      noSecrets(spy.mock.calls[0]!.map(String).join(' '));
      expect(console.error).toBe(spy); // restored to our sink, not clobbered
    } finally {
      console.error = saved;
    }
  });

  it('depth-counted install survives nesting; restores only when the LAST call exits', async () => {
    const saved = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      await withRedactedConsole(async () => {
        const mid = console.error; // the redacting wrapper is now installed
        expect(mid).not.toBe(spy);
        await withRedactedConsole(async () => {
          console.error(credLine());
          expect(console.error).toBe(mid); // nested call reuses the install, no second layer
        });
        expect(console.error).toBe(mid); // inner exit must NOT restore while the outer is active
      });
      expect(console.error).toBe(spy); // outer exit restores
      noSecrets(spy.mock.calls.map((c) => c.map(String).join(' ')).join(' '));
    } finally {
      console.error = saved;
    }
  });

  it('restores the console and rethrows on throw (failures stay loud, depth never leaks)', async () => {
    const saved = console.error;
    try {
      await expect(
        withRedactedConsole(async () => {
          throw new ExecutionError('ERR_CLOB', 'boom');
        }),
      ).rejects.toMatchObject({ code: 'ERR_CLOB' });
      expect(console.error).toBe(saved);
    } finally {
      console.error = saved;
    }
  });

  it('redactConsoleClient: venue-method cred logging is redacted; return value, `this`, and plain props survive', async () => {
    const rawClient = {
      creds: { marker: '0xORDERID' },
      plain: 'kept',
      async postOrder(): Promise<{ orderID: string }> {
        // stand-in for a leaky client that console.errors creds on a 400 — bypasses OUR catch paths
        console.error('[CLOB Client] request error', credLine());
        return { orderID: this.creds.marker }; // reads `this` → proves target binding survives the proxy
      },
    };
    const client = redactConsoleClient(rawClient);
    const saved = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      const res = await client.postOrder();
      expect(res).toEqual({ orderID: '0xORDERID' }); // return value + this-binding intact through the proxy
      expect(client.plain).toBe('kept'); // non-function prop passes through unproxied
      expect(spy).toHaveBeenCalledTimes(1);
      noSecrets(spy.mock.calls[0]!.map(String).join(' '));
      expect(console.error).toBe(spy); // restored
    } finally {
      console.error = saved;
    }
  });
});
