/**
 * Error-path coverage for branches the happy-path suites don't reach —
 * every guard in core must be exercised, not just declared (P1 coverage gate).
 */
import { describe, expect, it } from 'vitest';
import { parseConfigRows } from '../src/config.ts';
import { expectedCalibrationError } from '../src/calibration/scores.ts';
import { renormalize } from '../src/distributions/gaussian.ts';
import { ConfigError, ClobShapeError, DistributionError, GammaShapeError, OpenMeteoShapeError } from '../src/errors.ts';
import { applyRiskCaps } from '../src/kelly.ts';
import { normalizeBook } from '../src/polymarket/clob.ts';
import { parseGammaEvent, targetDateFromEvent, type RawGammaEvent } from '../src/polymarket/gamma.ts';
import { parseEnsembleDaily, parseEra5Daily, parsePreviousRunsHourly } from '../src/weather/openmeteo.ts';
import { parseWuObservations } from '../src/weather/wu.ts';
import type { RiskConfig } from '../src/types.ts';

describe('config edge branches', () => {
  it('null value rows are reported, JSON garbage in array keys is reported', () => {
    try {
      parseConfigRows([
        { key: 'bankrollUsd', value: null as unknown as string },
        { key: 'priorSigmaByLead', value: 'not-json' },
      ]);
      expect.unreachable();
    } catch (e) {
      const keys = (e as ConfigError).details!['invalidKeys'] as string[];
      expect(keys).toEqual(expect.arrayContaining(['bankrollUsd', 'priorSigmaByLead']));
    }
  });
});

describe('gaussian renormalize guard', () => {
  it('zero total mass throws DistributionError', () => {
    expect(() => renormalize([0, 0, 0])).toThrow(DistributionError);
  });
});

describe('scores edge branches', () => {
  it('ECE of an empty prediction set is 0', () => {
    expect(expectedCalibrationError([], 10)).toBe(0);
  });
});

describe('applyRiskCaps daily-cap branch', () => {
  const cfg: RiskConfig = {
    perTradeCapPct: 0.02, perEventCapPct: 0.05, clusterCapPct: 0.08, dailyCapPct: 0.15,
    minStakeUsd: 5, breakerConsecLosses: 8, breakerDailyLossPct: 0.05,
    breakerDrawdownPct: 0.25, breakerBrier: 0.3, staleForecastHaltH: 30, stalePriceHaltMin: 30,
  };

  it('daily headroom clamps when event/cluster have room', () => {
    const ctx = { bankrollUsd: 1000, eventOpenUsd: 0, clusterOpenUsd: 0, dayOpenUsd: 140 };
    const [plan] = applyRiskCaps([{ bucketIdx: 0, frac: 0.02, price: 0.5, orderMinSize: 5 }], ctx, cfg);
    expect(plan!.stakeUsd).toBe(10); // daily headroom 10 < per-trade 20
    expect(plan!.capAudit.some((s) => s.includes('daily cap'))).toBe(true);
  });
});

describe('gamma error branches', () => {
  const validEvent = (): RawGammaEvent => ({
    id: '1',
    slug: 'highest-temperature-in-testville-on-june-11-2026',
    title: 'Highest temperature in Testville on June 11?',
    markets: [
      {
        id: 'm1', conditionId: '0x' + 'a'.repeat(64), groupItemTitle: '87°F or below',
        clobTokenIds: '["1111111111111111111111111111111111111111111111111111111111111111111111111111", "2222222222222222222222222222222222222222222222222222222222222222222222222222"]',
        gameStartTime: '2026-06-11 04:00:00+00',
      },
      {
        id: 'm2', conditionId: '0x' + 'b'.repeat(64), groupItemTitle: '88°F or higher',
        clobTokenIds: '["3333333333333333333333333333333333333333333333333333333333333333333333333333", "4444444444444444444444444444444444444444444444444444444444444444444444444444"]',
      },
    ],
  });

  it('unknown month in the slug', () => {
    expect(() =>
      targetDateFromEvent({ slug: 'highest-temperature-in-x-on-junio-11-2026', title: 'on June 11', gameStartTime: null }),
    ).toThrow(GammaShapeError);
  });

  it('unparseable gameStartTime', () => {
    expect(() =>
      targetDateFromEvent(
        { slug: 'highest-temperature-in-x-on-june-11-2026', title: 'on June 11', gameStartTime: 'garbage' },
        'America/New_York',
      ),
    ).toThrow(GammaShapeError);
  });

  it('non-temperature slug pattern', () => {
    const ev = { ...validEvent(), slug: 'will-it-rain-tomorrow-2026' };
    expect(() => parseGammaEvent(ev)).toThrow(GammaShapeError);
  });

  it('missing markets array', () => {
    const ev = { ...validEvent(), markets: [] };
    expect(() => parseGammaEvent(ev)).toThrow(GammaShapeError);
  });

  it('market without groupItemTitle', () => {
    const ev = validEvent();
    delete ev.markets[0]!.groupItemTitle;
    expect(() => parseGammaEvent(ev)).toThrow(GammaShapeError);
  });

  it('market without a [yes, no] token pair', () => {
    const ev = validEvent();
    ev.markets[0]!.clobTokenIds = '["only-one"]';
    expect(() => parseGammaEvent(ev)).toThrow(GammaShapeError);
    delete ev.markets[0]!.clobTokenIds;
    expect(() => parseGammaEvent(ev)).toThrow(GammaShapeError);
  });

  it('a minimal synthetic event parses (no station, no prices, lowest kind)', () => {
    const ev = validEvent();
    ev.slug = 'lowest-temperature-in-testville-on-june-11-2026';
    ev.title = 'Lowest temperature in Testville on June 11?';
    const parsed = parseGammaEvent(ev);
    expect(parsed.kind).toBe('lowest');
    expect(parsed.station).toBeNull();
    expect(parsed.buckets[0]!.outcomePricesResolved).toBeNull();
    expect(parsed.eventVolume24h).toBeNull();
  });
});

describe('clob minimal-payload fallbacks', () => {
  it('missing optional fields default sanely (arrays still required)', () => {
    const book = normalizeBook({ bids: [], asks: [{ price: '0.5', size: '10' }] });
    expect(book.market).toBe('');
    expect(book.assetId).toBe('');
    expect(book.timestamp).toBe(0);
    expect(book.hash).toBe('');
    expect(book.minOrderSize).toBe(0);
    expect(book.tickSize).toBe(0);
    expect(book.negRisk).toBe(false);
    expect(book.lastTradePrice).toBeNull();
    expect(book.asks).toEqual([{ price: 0.5, size: 10 }]);
  });

  it('non-numeric bid level throws', () => {
    expect(() => normalizeBook({ bids: [{ price: '0.5', size: 'big' }], asks: [] })).toThrow(ClobShapeError);
  });
});

describe('openmeteo schema-failure branches', () => {
  it('parsePreviousRunsHourly without hourly.time[]', () => {
    expect(() => parsePreviousRunsHourly({ daily: {} }, ['gfs_seamless'], [1], 'Asia/Seoul')).toThrow(
      OpenMeteoShapeError,
    );
  });

  it('parseEnsembleDaily without daily.time[]', () => {
    expect(() => parseEnsembleDaily({ hourly: {} })).toThrow(OpenMeteoShapeError);
  });

  it('parseEra5Daily without daily.time[] and without the series', () => {
    expect(() => parseEra5Daily({})).toThrow(OpenMeteoShapeError);
    expect(() => parseEra5Daily({ daily: { time: ['2026-05-01'] } })).toThrow(OpenMeteoShapeError);
  });
});

describe('wu missing-temp branch', () => {
  it('an observation without a temp field maps to tempInt null', () => {
    const obs = parseWuObservations({ observations: [{ valid_time_gmt: 1781000000 }] });
    expect(obs).toEqual([{ validTimeGmt: 1781000000, tempInt: null }]);
  });
});
