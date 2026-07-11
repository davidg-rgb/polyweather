/**
 * getCityLive (0085, CITY-LIVE lane W) — the continuous winner-promotion + Live-arms loader. A crafted
 * dash_city_live payload goes in; the passthrough + null-tolerant defaults + board normalization come out.
 * Pure unit test over a stubbed WebDb (no PGlite). Mirrors trading-loader.test.ts.
 *
 * Same #22 discrimination as getTrading: ONLY the undefined-function error class (Postgres 42883 / PostgREST
 * PGRST202 / the "could not find the function … dash_city_live" spelling) maps to { kind: 'not-applied' } (the
 * true staged-dark day-one state until migration 0085 is applied); every other failure maps to { kind: 'error' }.
 */
import { describe, expect, it } from 'vitest';
import { getCityLive, isUndefinedFunctionError } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throwsMessage?: string } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throwsMessage != null) throw new Error(opts.throwsMessage);
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const PAYLOAD = {
  arms: [
    {
      cityId: 'c-kar', slug: 'karachi', displayName: 'Karachi', icao: 'OPKC', unit: 'C',
      enabled: true, stakeUsd: '5.00', entryHourOverride: 12, promotedStatus: 'PROMOTED',
      enabledAt: '2026-07-06T09:00:00Z', updatedAt: '2026-07-06T09:00:00Z',
    },
    {
      cityId: 'c-sing', slug: 'singapore', displayName: 'Singapore', icao: 'WSSS', unit: 'C',
      enabled: false, stakeUsd: '5.00', entryHourOverride: null, promotedStatus: 'WATCH',
      enabledAt: null, updatedAt: '2026-07-06T09:00:00Z',
    },
  ],
  board: {
    asOf: '2026-07-06T09:05:00Z',
    rows: [
      {
        cityId: 'c-kar', slug: 'karachi', icao: 'OPKC', nBets: 42, nDays: 15, netPnlUsd: '40.41',
        recommendedHour: 12, watchConfidence: 'sufficient', edge: 0.061, edgeCiLo: 0.012, edgeCiHi: 0.11,
        status: 'PROMOTED', reasons: ['eligible'],
      },
    ],
  },
  twin: [
    { cityId: 'c-kar', slug: 'karachi', nPlacements: 42, twinFilledFrac: 0.71, takerPnlUsd: '40.41', makerTwinPnlUsd: '52.10' },
  ],
  // 0094: the FULL cities domain (incl. non-enrolled london) — the allowlist picker's option source.
  allCities: [
    { slug: 'karachi', displayName: 'Karachi', enrolled: true },
    { slug: 'london', displayName: 'London', enrolled: false },
    { slug: 'singapore', displayName: 'Singapore', enrolled: true },
  ],
  generatedAt: '2026-07-06T09:05:00Z',
};

describe('getCityLive — dash_city_live passthrough + null-tolerant defaults', () => {
  it('passes the full { arms, board, twin } payload through as { kind: ok }', async () => {
    const load = await getCityLive(stubDb(PAYLOAD));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    const v = load.view;
    expect(v.arms).toHaveLength(2);
    expect(v.arms[0]!.enabled).toBe(true);
    expect(v.arms[1]!.promotedStatus).toBe('WATCH');
    expect(v.board.asOf).toBe('2026-07-06T09:05:00Z');
    expect(v.board.rows).toHaveLength(1);
    expect(v.board.rows[0]!.status).toBe('PROMOTED');
    expect(v.twin).toHaveLength(1);
    expect(v.twin[0]!.makerTwinPnlUsd).toBe('52.10');
    expect(v.allCities).toHaveLength(3);
    expect(v.allCities[1]).toEqual({ slug: 'london', displayName: 'London', enrolled: false });
    expect(v.generatedAt).toBe('2026-07-06T09:05:00Z');
  });

  it('normalizes a BARE board rows array (no { asOf, rows } envelope) to { asOf: null, rows }', async () => {
    const bare = { ...PAYLOAD, board: PAYLOAD.board.rows };
    const load = await getCityLive(stubDb(bare));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.board.asOf).toBeNull();
    expect(load.view.board.rows).toHaveLength(1);
  });

  it('defaults the collection fields when a lean/empty payload omits them', async () => {
    const load = await getCityLive(stubDb({ generatedAt: '2026-07-06T00:00:00Z' }));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    const v = load.view;
    expect(v.arms).toEqual([]);
    expect(v.allCities).toEqual([]); // pre-0094 payload has no allCities — the page degrades to arms
    expect(v.board).toEqual({ asOf: null, rows: [] });
    expect(v.twin).toEqual([]);
    expect(v.generatedAt).toBe('2026-07-06T00:00:00Z');
  });
});

describe('getCityLive — #22: not-applied vs RPC-error discrimination', () => {
  it("PostgREST schema-cache miss for dash_city_live → 'not-applied'", async () => {
    const load = await getCityLive(
      stubDb(null, {
        throwsMessage:
          'rpc dash_city_live failed: Could not find the function public.dash_city_live without parameters in the schema cache',
      }),
    );
    expect(load).toEqual({ kind: 'not-applied' });
  });

  it("Postgres 42883 spelling → 'not-applied'", async () => {
    const load = await getCityLive(
      stubDb(null, { throwsMessage: 'rpc dash_city_live failed: function public.dash_city_live() does not exist' }),
    );
    expect(load).toEqual({ kind: 'not-applied' });
  });

  it("explicit error codes (PGRST202 / 42883) → 'not-applied'", async () => {
    expect(await getCityLive(stubDb(null, { throwsMessage: 'PGRST202' }))).toEqual({ kind: 'not-applied' });
    expect(await getCityLive(stubDb(null, { throwsMessage: 'error 42883' }))).toEqual({ kind: 'not-applied' });
  });

  it("a transient/DB-incident failure → 'error' with the message preserved (NEVER 'not-applied')", async () => {
    const load = await getCityLive(stubDb(null, { throwsMessage: 'rpc dash_city_live failed: upstream request timeout' }));
    expect(load.kind).toBe('error');
    if (load.kind !== 'error') throw new Error('expected error');
    expect(load.message).toContain('upstream request timeout');
  });

  it("an operator_guard rejection → 'error', not 'not-applied'", async () => {
    const load = await getCityLive(stubDb(null, { throwsMessage: 'rpc dash_city_live failed: ERR_FORBIDDEN' }));
    expect(load.kind).toBe('error');
  });

  it("an empty (null) RPC result without a throw → 'error' (an anomaly, not the staged-dark state)", async () => {
    const load = await getCityLive(stubDb(null));
    expect(load.kind).toBe('error');
  });
});

describe('isUndefinedFunctionError — the symbol-scoped #22 classifier (dash_city_live)', () => {
  it('matches the undefined-function class for the passed symbol only', () => {
    expect(isUndefinedFunctionError('PGRST202', 'dash_city_live')).toBe(true);
    expect(isUndefinedFunctionError('42883', 'dash_city_live')).toBe(true);
    expect(isUndefinedFunctionError('function public.dash_city_live() does not exist', 'dash_city_live')).toBe(true);
    expect(
      isUndefinedFunctionError('Could not find the function public.dash_city_live in the schema cache', 'dash_city_live'),
    ).toBe(true);
    expect(isUndefinedFunctionError('upstream request timeout', 'dash_city_live')).toBe(false);
    // a DIFFERENT missing function must not masquerade as the dash_city_live staged-dark state
    expect(isUndefinedFunctionError('function public.dash_trading() does not exist', 'dash_city_live')).toBe(false);
    // the default symbol stays dash_trading (backward-compatible)
    expect(isUndefinedFunctionError('function public.dash_trading() does not exist')).toBe(true);
  });
});
