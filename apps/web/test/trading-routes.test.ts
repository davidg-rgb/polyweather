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
import { adminBuyTablePrice, adminCityArm, adminGateOverride, adminTradingConfig } from '../src/lib/api/routes.ts';

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

describe('auth — the /trading mutation routes reject non-operator sessions (401)', () => {
  it('401 without a session and with a non-allow-listed email', async () => {
    for (const session of [null, 'intruder@example.com'] as const) {
      const d = makeDeps({ session });
      for (const res of [
        await adminTradingConfig(req(), d),
        await adminCityArm(req(), d),
        await adminBuyTablePrice(req(), d),
      ]) {
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

describe('/api/admin/trading/buy-table-price → buy_table_price_cap_set / buy_table_city_cap_set (0109, max-only)', () => {
  it('globalMax → buy_table_price_cap_set passthrough; 200 + the new cap', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls, rpc: () => ({ buy_table_price_cap_set: { priceCap: 0.2 } }) });
    const res = await adminBuyTablePrice(req({ globalMax: 0.2 }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, priceCap: 0.2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('buy_table_price_cap_set');
    expect(calls[0]!.args).toEqual({ p_max: 0.2 });
  });

  it('city + max → buy_table_city_cap_set passthrough VERBATIM (the DB normalizes, not the route); no min anywhere', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({
      calls,
      rpc: () => ({ buy_table_city_cap_set: { cityPriceCaps: { karachi: 0.3 } } }),
    });
    const res = await adminBuyTablePrice(req({ city: ' Karachi ', max: 0.3 }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cityCaps: { karachi: 0.3 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('buy_table_city_cap_set');
    expect(calls[0]!.args).toEqual({ p_city: ' Karachi ', p_max: 0.3 });
  });

  it('a stray legacy min in the body is ignored — only max reaches the RPC', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls, rpc: () => ({ buy_table_city_cap_set: { cityPriceCaps: { karachi: 0.3 } } }) });
    const res = await adminBuyTablePrice(req({ city: 'karachi', min: 0.05, max: 0.3 }), d);
    expect(res.status).toBe(200);
    expect(calls[0]!.args).toEqual({ p_city: 'karachi', p_max: 0.3 });
  });

  it('clear: true → p_max null (the RPC clear contract); max ignored', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls, rpc: () => ({ buy_table_city_cap_set: { cityPriceCaps: {} } }) });
    const res = await adminBuyTablePrice(req({ city: 'karachi', clear: true }), d);
    expect(res.status).toBe(200);
    expect(calls[0]!.args).toEqual({ p_city: 'karachi', p_max: null });
  });

  it('TYPE validation — empty body, non-number max, non-number globalMax → 400, no RPC call', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls });
    const empty = await adminBuyTablePrice(req({}), d);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { details: string[] }).details.some((s) => s.includes('globalMax and/or city'))).toBe(true);
    const bad = await adminBuyTablePrice(req({ city: 'karachi', max: 'x', globalMax: 'y' }), d);
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_VALIDATION');
    expect(body.details.some((s) => s.includes('max must be a finite number'))).toBe(true);
    expect(body.details.some((s) => s.includes('globalMax'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a DB RAISE VERBATIM (unknown slug / invalid cap) — value enforcement is the DB', async () => {
    const raise =
      'rpc buy_table_city_cap_set failed: buy_table_city_cap_set: unknown city slug: atlantis — must match cities.slug exactly';
    const d = makeDeps({
      rpc: () => {
        throw new Error(raise);
      },
    });
    const res = await adminBuyTablePrice(req({ city: 'atlantis', max: 0.3 }), d);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_DB_CHECK');
    expect(body.details[0]).toBe(raise); // verbatim, unmodified
  });
});

describe('/api/admin/trading/gate-override → trade_gate_override_set / _clear (0082 §3)', () => {
  it('401 without an operator session', async () => {
    const res = await adminGateOverride(req({ reason: 'x', expiresAt: '2026-07-20' }), makeDeps({ session: null }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'ERR_AUTH' });
  });

  it('set/renew: passes (reason, expiresAt, note) through trimmed; 200 + the new override row', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({
      calls,
      rpc: () => ({ trade_gate_override_set: { override: { id: 2, expires_at: '2026-07-20T00:00:00+00:00' } } }),
    });
    const res = await adminGateOverride(
      req({ reason: '  remote renewal — operator away  ', expiresAt: ' 2026-07-20 ', note: 'set from /trading' }),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, override: { id: 2 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('trade_gate_override_set');
    expect(calls[0]!.args).toEqual({
      p_reason: 'remote renewal — operator away',
      p_expires_at: '2026-07-20',
      p_note: 'set from /trading',
    });
  });

  it('note omitted / blank → p_note null', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls, rpc: () => ({ trade_gate_override_set: { override: {} } }) });
    await adminGateOverride(req({ reason: 'r', expiresAt: '2026-07-20', note: '  ' }), d);
    expect(calls[0]!.args['p_note']).toBeNull();
  });

  it('clear: true → trade_gate_override_clear (no args); 200 + the cleared count', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls, rpc: () => ({ trade_gate_override_clear: { cleared: 1 } }) });
    const res = await adminGateOverride(req({ clear: true }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('trade_gate_override_clear');
    expect(calls[0]!.args).toEqual({});
  });

  it('TYPE validation — missing reason + missing expiresAt rejected with per-field details, no RPC call', async () => {
    const calls: RpcCall[] = [];
    const d = makeDeps({ calls });
    const res = await adminGateOverride(req({ reason: '   ', note: 42 }), d);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_VALIDATION');
    expect(body.details.some((s) => s.includes('reason'))).toBe(true);
    expect(body.details.some((s) => s.includes('expiresAt'))).toBe(true);
    expect(body.details.some((s) => s.includes('note'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the ≤14-day-cap RAISE VERBATIM — the expiry envelope is the DB, not the route', async () => {
    const raise =
      'rpc trade_gate_override_set failed: trade_gate_override_set: expires_at more than 14 days out — an override is short-lived by construction';
    const d = makeDeps({
      rpc: () => {
        throw new Error(raise);
      },
    });
    // a far-future date passes TYPE validation (non-empty string) → reaches the RPC → the 14-day cap RAISES.
    const res = await adminGateOverride(req({ reason: 'r', expiresAt: '2026-09-30' }), d);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('ERR_DB_CHECK');
    expect(body.details[0]).toBe(raise); // verbatim, unmodified
  });
});
