/**
 * getDataAccuracy (0065) — the /data loader. Pure unit tests over a stubbed WebDb: a crafted dash_data jsonb
 * payload goes in, the typed view comes out (passthrough + `?? []` defaults), a missing meta degrades to null,
 * and an RPC error degrades to null (so the page can deploy ahead of the 0065 RPC). The render test mocks the
 * whole loader, so without this the loader body — incl. its load-bearing null-degrade — never executes.
 */
import { describe, expect, it } from 'vitest';
import { getDataAccuracy } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const FULL = {
  meta: { champion: 'house_gaussian', leadStation: 1, generatedAt: '2026-06-26T13:00:00Z', firstDay: '2026-06-13', lastDay: '2026-06-26', nStations: 44 },
  byLead: [{ lead: 1, n: 448, stations: 44, houseExact: 0.355, houseWithin1: 0.781, houseMiss: 0.94, marketExact: 0.395, marketWithin1: 0.839, marketMiss: 0.8 }],
  byStation: [{ city: 'madrid', region: 'europe-west', n: 8, exactPct: 0.625, within1Pct: 1.0, meanMiss: 0.375, marketWithin1Pct: 1.0, marketMeanMiss: 0.5 }],
  brierSeries: [{ date: '2026-06-15', nHouse: 44, brierHouse: 0.803, nMarket: 42, brierMarket: 0.742 }],
};

describe('getDataAccuracy (0065)', () => {
  it('passes a populated payload through unchanged', async () => {
    const v = (await getDataAccuracy(stubDb(FULL)))!;
    expect(v).not.toBeNull();
    expect(v.meta.champion).toBe('house_gaussian');
    expect(v.byLead).toHaveLength(1);
    expect(v.byStation[0]!.city).toBe('madrid');
    expect(v.brierSeries[0]!.brierHouse).toBe(0.803);
  });

  it('coerces null/absent byLead/byStation/brierSeries to [] when meta is present', async () => {
    const v = (await getDataAccuracy(stubDb({ meta: FULL.meta })))!;
    expect(v).not.toBeNull();
    expect(v.byLead).toEqual([]);
    expect(v.byStation).toEqual([]);
    expect(v.brierSeries).toEqual([]);
  });

  it('returns null when meta is missing (the `!v.meta` guard)', async () => {
    expect(await getDataAccuracy(stubDb({ byLead: [], byStation: [] }))).toBeNull();
    expect(await getDataAccuracy(stubDb(null))).toBeNull();
  });

  it('returns null when the RPC errors (degraded page — deploy-ahead-of-RPC)', async () => {
    expect(await getDataAccuracy(stubDb(FULL, { throws: true }))).toBeNull();
  });
});
