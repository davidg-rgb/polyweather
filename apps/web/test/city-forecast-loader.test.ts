/**
 * getCityForecast (0080) — the /paper-trade pre-placement forecast loader. A crafted dash_city_forecast
 * payload goes in; the view comes out untouched (the RPC does the arithmetic — the loader only null-guards
 * and defaults `cities`). Pure unit test over a stubbed WebDb (no PGlite). Mirrors city-sim-loader.
 */
import { describe, expect, it } from 'vitest';
import { getCityForecast } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

describe('getCityForecast — maps the payload, null-guards the RPC', () => {
  const payload = {
    generatedAt: '2026-06-15T06:00:00Z',
    cities: [
      {
        slug: 'singapore', displayName: 'Singapore', icao: 'WSSS', unit: 'C', tz: 'Asia/Singapore',
        armHours: [11, 12, 13, 14], forecastMaxHour: 12, targetDate: '2026-06-15', hasMarket: true,
        capturedAt: '2026-06-14T22:00:00Z', nModels: 1, rawForecastC: 31.6, biasC: 0, biasN: 22,
        biasCorrected: true, forecastC: 31.6, forecastNative: 31.6, predictedNative: 32, label: '32°C',
        ask: 0.68, alreadyPlacedToday: false,
      },
    ],
  };

  it('returns the view with cities carried through', async () => {
    const v = (await getCityForecast(stubDb(payload)))!;
    expect(v).not.toBeNull();
    expect(v.generatedAt).toBe('2026-06-15T06:00:00Z');
    expect(v.cities).toHaveLength(1);
    const c = v.cities[0]!;
    expect(c.slug).toBe('singapore');
    expect(Number(c.predictedNative)).toBe(32);
    expect(c.label).toBe('32°C');
    expect(c.biasCorrected).toBe(true);
    expect(c.alreadyPlacedToday).toBe(false);
  });

  it('defaults cities to [] when the payload omits it', async () => {
    const v = (await getCityForecast(stubDb({ generatedAt: 'x' })))!;
    expect(v.cities).toEqual([]);
  });

  it('returns null when the RPC is absent (degrades dark)', async () => {
    expect(await getCityForecast(stubDb(null, { throws: true }))).toBeNull();
    expect(await getCityForecast(stubDb(null))).toBeNull();
  });
});
