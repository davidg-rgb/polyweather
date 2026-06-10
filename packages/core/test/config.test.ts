import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, parseConfigRows } from '../src/config.ts';
import { ConfigError } from '../src/errors.ts';

describe('ConfigSchema defaults (§6.11)', () => {
  it('match the §6.11 table exactly', () => {
    const cfg = parseConfigRows([]);
    expect(cfg).toMatchObject({
      bankrollUsd: 1000,
      kellyFraction: 0.25,
      perTradeCapPct: 0.02,
      perEventCapPct: 0.05,
      clusterCapPct: 0.08,
      dailyCapPct: 0.15,
      uncertaintyMargin: 0.05,
      spreadBufferMin: 0.01,
      minEventVolumeUsd: 2000,
      maxSpread: 0.05,
      minHoursBeforeClose: 2,
      maxLeadDays: 7,
      probeStakeUsd: 20,
      minStakeUsd: 5,
      paperSlippage: 0.01,
      paperBookMaxAgeMin: 5,
      biasAlpha: 0.15,
      sigmaWindowDays: 30,
      sigmaMinN: 8,
      sigmaFloorC: 0.45,
      priorSigmaByLead: [1.6, 1.9, 2.3, 2.7, 3.1, 3.5, 3.9, 4.3],
      breakerConsecLosses: 8,
      breakerDailyLossPct: 0.05,
      breakerDrawdownPct: 0.25,
      breakerBrier: 0.3,
      staleForecastHaltH: 30,
      stalePriceHaltMin: 30,
      championSource: 'house_gaussian',
      autoApproveMaxStakeUsd: 0,
      jobWallLimitSec: 150,
      tradingMode: 'paper',
    });
    expect(cfg.wuApiKey).toBeUndefined(); // runtime cache, no default
  });

  it('code defaults equal the 0010 migration seed VERBATIM (single source of truth)', () => {
    const sql = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'supabase', 'migrations', '0010_seed.sql'),
      'utf8',
    );
    const block = /insert into public\.config \(key, value\) values([\s\S]*?)on conflict/.exec(sql);
    expect(block).not.toBeNull();
    const seeded = new Map<string, string>();
    for (const m of block![1]!.matchAll(/\('([^']+)',\s*'([^']*)'\)/g)) {
      seeded.set(m[1]!, m[2]!);
    }
    const defaults = parseConfigRows([]);
    const schemaKeys = new Set(Object.keys(ConfigSchema.shape));

    for (const [key, value] of seeded) {
      if (!schemaKeys.has(key)) {
        // operatorEmail is RLS wiring, not a tunable — the only allowed exception.
        expect(key).toBe('operatorEmail');
        continue;
      }
      const def = defaults[key as keyof typeof defaults];
      if (Array.isArray(def)) {
        expect(JSON.parse(value), key).toEqual(def);
      } else if (typeof def === 'number') {
        expect(Number(value), key).toBe(def);
      } else {
        expect(value, key).toBe(def);
      }
    }
    // every schema tunable with a default is seeded (wuApiKey/wuKeyFetchedAt are runtime-cached)
    for (const key of schemaKeys) {
      if (key === 'wuApiKey' || key === 'wuKeyFetchedAt') continue;
      expect(seeded.has(key), `migration seed missing ${key}`).toBe(true);
    }
  });
});

describe('parseConfigRows (§6.11)', () => {
  it('DB override wins over the default', () => {
    const cfg = parseConfigRows([
      { key: 'bankrollUsd', value: '2500' },
      { key: 'tradingMode', value: 'live' },
      { key: 'priorSigmaByLead', value: '[2,2,2,2,2,2,2,2]' },
    ]);
    expect(cfg.bankrollUsd).toBe(2500);
    expect(cfg.tradingMode).toBe('live');
    expect(cfg.priorSigmaByLead).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(cfg.kellyFraction).toBe(0.25); // untouched default
  });

  it('ignores non-schema rows (halt:* and operatorEmail belong to other subsystems)', () => {
    const cfg = parseConfigRows([
      { key: 'halt:global', value: '{"reason":"test"}' },
      { key: 'operatorEmail', value: 'x@y.z' },
    ]);
    expect(cfg.bankrollUsd).toBe(1000);
  });

  it('ConfigError lists EVERY invalid key in one shot', () => {
    try {
      parseConfigRows([
        { key: 'bankrollUsd', value: 'abc' },
        { key: 'tradingMode', value: 'yolo' },
        { key: 'priorSigmaByLead', value: '[1,2]' },
        { key: 'maxSpread', value: '0.04' },
      ]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const keys = (e as ConfigError).details!['invalidKeys'] as string[];
      expect(keys).toContain('bankrollUsd');
      expect(keys).toContain('tradingMode');
      expect(keys).toContain('priorSigmaByLead');
      expect(keys).not.toContain('maxSpread');
    }
  });

  it('rejects out-of-range values via the schema', () => {
    expect(() => parseConfigRows([{ key: 'kellyFraction', value: '1.5' }])).toThrow(ConfigError);
    expect(() => parseConfigRows([{ key: 'maxLeadDays', value: '3.7' }])).toThrow(ConfigError);
  });

  it('accepts the runtime WU key cache rows', () => {
    const cfg = parseConfigRows([
      { key: 'wuApiKey', value: 'a'.repeat(32) },
      { key: 'wuKeyFetchedAt', value: '2026-06-10T12:00:00Z' },
    ]);
    expect(cfg.wuApiKey).toBe('a'.repeat(32));
    expect(cfg.wuKeyFetchedAt).toBe('2026-06-10T12:00:00Z');
  });
});
