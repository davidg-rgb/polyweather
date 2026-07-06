/**
 * §8.2 CITY-LIVE (lane W) mutation routes — /api/admin/trading/config → trade_config_set and
 * /api/admin/trading/city-arm → city_live_arm_set. Stub-WebDb unit tests (no PGlite): the city_live_arm_set RPC
 * ships in Lane D's migration 0085, so these tests exercise the HANDLER contract in isolation — auth (401),
 * TYPE validation (400), the exact RPC arg passthrough, and the load-bearing guarantee: a DB CHECK / RAISE
 * (the §9R $25 ceiling, the stake ≤ $5 envelope, the max-2-enabled trigger) is surfaced VERBATIM in the error
 * response. Mirrors the auth+contract shape of api.test.ts. The RLS anon client is used (no service key).
 */
import { describe, expect, it } from 'vitest';
import type { ApiDeps, WebDb } from '../src/lib/api/deps.ts';
import { adminCityArm, adminTradingConfig } from '../src/lib/api/routes.ts';

const OPERATOR = 'david.geborek@gmail.com';
const UUID = '00000000-0000-0000-0000-0000000000aa';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const makeDeps = (
  opts: {
    session?: string | null;
    rpc?: (fn: string, args: Record<string, unknown>) => Record<string, unknown>;
    calls?: RpcCall[];
  } = {},
): ApiDeps => {
  const db: WebDb = {
    rpc: (async (fn: string, args: Record<string, unknown>) => {
      opts.calls?.push({ fn, args });
      return [opts.rpc ? opts.rpc(fn, args) : { [fn]: {} }];
    }) as WebDb['rpc'],
    getConfigRows: async () => [],
  };
  return {
    db,
    getSessionEmail: async () => (opts.session === undefined ? OPERATOR : opts.session),
    operatorEmail: OPERATOR,
    proxyExecuteBet: async () => new Response('{}', { status: 200 }),
    proxyTriggerJob: async () => new Response('{}', { status: 202 }),
    notify: async () => true,
    now: () => new Date('2026-07-06T12:00:00Z'),
  };
};

const req = (body: unknown = {}): Request =>
  new Request('http://web/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('auth — both CITY-LIVE routes reject non-operator sessions (401)', () => {
  it('401 without a session and with a non-allow-listed email', async () => {
    for (const session of [null, 'intruder@example.com'] as const) {
      const d = makeDeps({ session });
      for (const res of [await adminTradingConfig(req(), d), await adminCityArm(req(), d)]) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'ERR_AUTH' });
      }
    }
  });
});

describe('/api/admin/trading/config → trade_config_set (11-arg passthrough)', () => {
  it('passes only the CHANGED fields through, omitted params as null (leave unchanged); 200 + new config', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({
      calls,
      rpc: () => ({ trade_config_set: { config: { id: 1, mode: 'dry-run', stake_per_buy_usd: '12.00' } } }),
    });
    const res = await adminTradingConfig(
      req({
        mode: 'dry-run',
        stakePerBuyUsd: 12,
        dailyLossKillFrac: 0.3,
        cityAllowlist: ['singapore', 'karachi'],
        activeUntil: '2026-07-31',
        clearActiveUntil: false,
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, config: { mode: 'dry-run' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('trade_config_set');
    expect(calls[0]!.args).toMatchObject({
      p_mode: 'dry-run',
      p_stake_per_buy_usd: 12,
      p_daily_loss_kill_frac: 0.3,
      p_city_allowlist: ['singapore', 'karachi'],
      p_active_until: '2026-07-31',
      p_clear_city_allowlist: false,
      p_clear_active_until: false,
    });
    // an omitted numeric passes as null so trade_config_set leaves the column unchanged
    expect(calls[0]!.args['p_per_market_cap_usd']).toBeNull();
  });

  it('TYPE validation — bad mode + non-number cap rejected with per-field details, no RPC call', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls });
    const res = await adminTradingConfig(req({ mode: 'sideways', stakePerBuyUsd: 'ten' }), d);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_VALIDATION');
    expect(body.details.some((s) => s.includes('mode'))).toBe(true);
    expect(body.details.some((s) => s.includes('stakePerBuyUsd'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a DB CHECK RAISE VERBATIM (the §9R $25 ceiling) — value-range enforcement is the DB, not the route', async () => {
    const raise =
      'rpc trade_config_set failed: new row for relation "trade_config" violates check constraint "trade_config_ceiling"';
    const d = makeDeps({
      rpc: () => {
        throw new Error(raise);
      },
    });
    // stakePerBuyUsd 40 passes TYPE validation (finite number) → reaches the RPC → the DB ceiling RAISES.
    const res = await adminTradingConfig(req({ stakePerBuyUsd: 40 }), d);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_DB_CHECK');
    expect(body.details[0]).toBe(raise); // verbatim, unmodified
  });
});

describe('/api/admin/trading/city-arm → city_live_arm_set', () => {
  it('passes (cityId, enabled, stake, hour) through; 200 + the row', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls, rpc: () => ({ city_live_arm_set: { row: { city_id: UUID, enabled: true } } }) });
    const res = await adminCityArm(req({ cityId: UUID, enabled: true, stakeUsd: 5, entryHour: 12 }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, row: { enabled: true } });
    expect(calls[0]!.args).toMatchObject({ p_city_id: UUID, p_enabled: true, p_stake_usd: 5, p_entry_hour: 12 });
  });

  it('entryHour omitted → p_entry_hour null (auto = the board recommendedHour)', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls, rpc: () => ({ city_live_arm_set: { row: {} } }) });
    await adminCityArm(req({ cityId: UUID, enabled: false, stakeUsd: 5 }), d);
    expect(calls[0]!.args['p_entry_hour']).toBeNull();
  });

  it('TYPE validation — bad UUID + non-boolean enabled rejected, no RPC call', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls });
    const res = await adminCityArm(req({ cityId: 'not-a-uuid', enabled: 'yes', stakeUsd: 5 }), d);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_VALIDATION');
    expect(body.details.some((s) => s.includes('cityId'))).toBe(true);
    expect(body.details.some((s) => s.includes('enabled'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the max-2-enabled trigger RAISE VERBATIM (state conflict → 409)', async () => {
    const raise = 'rpc city_live_arm_set failed: city_live_arms_max2: at most 2 cities may be enabled';
    const d = makeDeps({
      rpc: () => {
        throw new Error(raise);
      },
    });
    const res = await adminCityArm(req({ cityId: UUID, enabled: true, stakeUsd: 5 }), d);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_DB_CHECK');
    expect(body.details[0]).toBe(raise);
  });

  it('surfaces the stake ≤ $5 CHECK RAISE VERBATIM — the envelope is the DB CHECK, not re-encoded in the route', async () => {
    const raise = 'rpc city_live_arm_set failed: violates check constraint "city_live_arms_stake_usd_check"';
    const d = makeDeps({
      rpc: () => {
        throw new Error(raise);
      },
    });
    // stakeUsd 9 (> 5) passes the route's TYPE check (finite number) → the DB stake CHECK RAISES.
    const res = await adminCityArm(req({ cityId: UUID, enabled: true, stakeUsd: 9 }), d);
    expect(res.status).toBe(409);
    expect((await res.json() as { details: string[] }).details[0]).toBe(raise);
  });
});
