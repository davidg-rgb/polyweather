/**
 * getCityPredictions (0106) — the /cities loader. Pure unit tests over a stubbed WebDb: a crafted
 * dash_city_predictions jsonb payload goes in, the typed view comes out (passthrough + `?? []`/null
 * defaults), and an RPC error/absence degrades to null (so the page can deploy ahead of the 0106
 * migration). The render test mocks the whole loader, so without this the loader body never executes.
 */
import { describe, expect, it } from 'vitest';
import { getCityPredictions } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const FULL = {
  generatedAt: '2026-07-17T18:00:00Z',
  config: { leadMinH: 2, leadMaxH: 12, priceCap: 0.4 },
  stats: [
    { city: 'seoul', displayName: 'Seoul', unit: 'C', n: 18, hits: 11, rate: 0.6111, lastGradedDate: '2026-07-16' },
  ],
  rows: [
    {
      city: 'seoul', displayName: 'Seoul', unit: 'C', targetDate: '2026-07-18',
      resolvesAt: '2026-07-18T06:00:00Z', capturedAt: '2026-07-17T17:55:00Z',
      predIdx: 4, predLabel: '31°C', predProb: 0.44, ask: 0.38,
    },
  ],
};

describe('getCityPredictions (0106)', () => {
  it('passes a populated payload through unchanged', async () => {
    const v = (await getCityPredictions(stubDb(FULL)))!;
    expect(v).not.toBeNull();
    expect(v.generatedAt).toBe('2026-07-17T18:00:00Z');
    expect(v.config).toEqual({ leadMinH: 2, leadMaxH: 12, priceCap: 0.4 });
    expect(v.stats[0]!.city).toBe('seoul');
    expect(v.rows[0]!.predLabel).toBe('31°C');
  });

  it('coerces null/absent stats/rows/config when generatedAt is present', async () => {
    const v = (await getCityPredictions(stubDb({ generatedAt: '2026-07-17T18:00:00Z' })))!;
    expect(v).not.toBeNull();
    expect(v.config).toBeNull();
    expect(v.stats).toEqual([]);
    expect(v.rows).toEqual([]);
  });

  it('returns null on a null payload', async () => {
    expect(await getCityPredictions(stubDb(null))).toBeNull();
  });

  it('returns null when the RPC errors (degraded page — deploy-ahead-of-0106)', async () => {
    expect(await getCityPredictions(stubDb(FULL, { throws: true }))).toBeNull();
  });
});
