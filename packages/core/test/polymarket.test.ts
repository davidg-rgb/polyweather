import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClobShapeError, GammaShapeError } from '../src/errors.ts';
import { normalizeBook, parsePricesHistory, type RawClobBook } from '../src/polymarket/clob.ts';
import {
  extractStationFromUrl,
  isZombieEvent,
  parseGammaEvent,
  parseStringArray,
  targetDateFromEvent,
  type RawGammaEvent,
} from '../src/polymarket/gamma.ts';
import {
  type RawSamplingMarket,
  fundedDailyRate,
  isFunded,
  isWeatherMarket,
  reduceBookDepth,
  scanWeatherRewards,
} from '../src/polymarket/rewards.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', '..', 'research');

function loadEvent(file: string): RawGammaEvent {
  const raw = JSON.parse(readFileSync(join(RESEARCH, file), 'utf8')) as unknown;
  return (Array.isArray(raw) ? raw[0] : raw) as RawGammaEvent;
}

function loadJinanZombie(): RawGammaEvent {
  const raw = JSON.parse(
    readFileSync(join(RESEARCH, 'gamma-events-tag103040-active.json'), 'utf8'),
  ) as RawGammaEvent[];
  const zombie = raw.find((e) => e.slug === 'highest-temperature-in-jinan-on-may-20-2026');
  expect(zombie).toBeDefined();
  return zombie!;
}

describe('parseStringArray (§6.9)', () => {
  it('decodes the double-encoded fixture fields', () => {
    const nyc = loadEvent('gamma-event-temperature-nyc-jun11.json');
    const m = nyc.markets[0]!;
    expect(parseStringArray(m.outcomes!, 'outcomes')).toEqual(['Yes', 'No']);
    const tokens = parseStringArray(m.clobTokenIds!, 'clobTokenIds');
    expect(tokens.length).toBe(2);
    expect(tokens[0]).toMatch(/^\d{60,80}$/); // 77-digit decimal token ids
    const prices = parseStringArray(m.outcomePrices!, 'outcomePrices');
    expect(prices.every((p) => Number.isFinite(Number(p)))).toBe(true);
  });

  it('GammaShapeError with the field name on malformed input', () => {
    for (const bad of ['not json', '{"a":1}', '[1,2]', '"justastring"']) {
      try {
        parseStringArray(bad, 'outcomePrices');
        expect.unreachable(`should have thrown for ${bad}`);
      } catch (e) {
        expect(e).toBeInstanceOf(GammaShapeError);
        expect((e as GammaShapeError).message).toContain('outcomePrices');
      }
    }
  });
});

describe('extractStationFromUrl (§6.9, W2)', () => {
  it('US URL with TWO middle segments (live-verified KLGA)', () => {
    expect(extractStationFromUrl('https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA')).toEqual({
      icao: 'KLGA',
      countryCode: 'US',
    });
  });

  it('intl URLs with ONE middle segment (EGLC / RKSI / LFPB fixtures)', () => {
    expect(extractStationFromUrl('https://www.wunderground.com/history/daily/gb/london/EGLC')).toEqual({
      icao: 'EGLC',
      countryCode: 'GB',
    });
    expect(extractStationFromUrl('https://www.wunderground.com/history/daily/kr/incheon/RKSI')).toEqual({
      icao: 'RKSI',
      countryCode: 'KR',
    });
    expect(extractStationFromUrl('https://www.wunderground.com/history/daily/fr/bonneuil-en-france/LFPB')).toEqual({
      icao: 'LFPB',
      countryCode: 'FR',
    });
  });

  it('null on garbage — triggers the station-unverified path, never a guess', () => {
    expect(extractStationFromUrl('https://example.com/whatever')).toBeNull();
    expect(extractStationFromUrl('https://www.wunderground.com/history/daily/us/ny/new-york-city')).toBeNull();
    expect(extractStationFromUrl('')).toBeNull();
  });
});

describe('targetDateFromEvent (§6.9, C6)', () => {
  it('parses the slug-with-year and cross-checks the title', () => {
    expect(
      targetDateFromEvent({
        slug: 'highest-temperature-in-nyc-on-june-11-2026',
        title: 'Highest temperature in NYC on June 11?',
        gameStartTime: null,
      }),
    ).toBe('2026-06-11');
  });

  it('rejects the 2025-stale-slug trap (yearless slug)', () => {
    expect(() =>
      targetDateFromEvent({
        slug: 'highest-temperature-in-london-on-june-11',
        title: 'Highest temperature in London on June 11?',
        gameStartTime: null,
      }),
    ).toThrow(GammaShapeError);
  });

  it('historical-backfill opt-in: a yearless slug parses when referenceYear is supplied (year from endDate)', () => {
    expect(
      targetDateFromEvent(
        {
          slug: 'highest-temperature-in-london-on-january-22',
          title: 'Will the highest temperature in London be between 36-37°F on January 22?',
          gameStartTime: null,
        },
        undefined,
        { referenceYear: 2025 },
      ),
    ).toBe('2025-01-22');
  });

  it('opt-in still enforces the title month/day cross-check (only the YEAR is taken on trust)', () => {
    expect(() =>
      targetDateFromEvent(
        {
          slug: 'highest-temperature-in-london-on-january-22',
          title: 'Will the highest temperature in London be between 36-37°F on January 23?',
          gameStartTime: null,
        },
        undefined,
        { referenceYear: 2025 },
      ),
    ).toThrow(GammaShapeError);
  });

  it('rejects slug/title date mismatches', () => {
    expect(() =>
      targetDateFromEvent({
        slug: 'highest-temperature-in-nyc-on-june-11-2026',
        title: 'Highest temperature in NYC on June 12?',
        gameStartTime: null,
      }),
    ).toThrow(GammaShapeError);
  });

  it('C6: Seoul fixture passes the strict check — slug june-11 ↔ gameStartTime 2026-06-10T15:00Z with tz Asia/Seoul', () => {
    const seoul = loadEvent('gamma-event-temperature-seoul-jun11.json');
    const gst = seoul.markets.find((m) => m.gameStartTime)!.gameStartTime!;
    expect(gst).toBe('2026-06-10 15:00:00+00');
    expect(
      targetDateFromEvent({ slug: seoul.slug, title: seoul.title, gameStartTime: gst }, 'Asia/Seoul'),
    ).toBe('2026-06-11');
  });

  it('mismatched known tz → GammaShapeError (never bet a misdated event)', () => {
    const seoul = loadEvent('gamma-event-temperature-seoul-jun11.json');
    const gst = seoul.markets.find((m) => m.gameStartTime)!.gameStartTime!;
    expect(() =>
      targetDateFromEvent({ slug: seoul.slug, title: seoul.title, gameStartTime: gst }, 'America/Chicago'),
    ).toThrow(GammaShapeError);
  });

  it('strict check is skipped when tz is unknown', () => {
    const seoul = loadEvent('gamma-event-temperature-seoul-jun11.json');
    const gst = seoul.markets.find((m) => m.gameStartTime)!.gameStartTime!;
    expect(targetDateFromEvent({ slug: seoul.slug, title: seoul.title, gameStartTime: gst })).toBe('2026-06-11');
  });
});

describe('parseGammaEvent (§6.9) — full city fixtures', () => {
  const cases: Array<[string, string, 'C' | 'F', string, string, string]> = [
    ['gamma-event-temperature-nyc-jun11.json', 'nyc', 'F', 'KLGA', 'US', '2026-06-11'],
    ['gamma-event-temperature-london-jun11.json', 'london', 'C', 'EGLC', 'GB', '2026-06-11'],
    ['gamma-event-temperature-seoul-jun11.json', 'seoul', 'C', 'RKSI', 'KR', '2026-06-11'],
    ['gamma-event-temperature-paris-jun11.json', 'paris', 'C', 'LFPB', 'FR', '2026-06-11'],
  ];

  it.each(cases)('%s parses fully', (file, citySlug, unit, icao, cc, targetDate) => {
    const parsed = parseGammaEvent(loadEvent(file));
    expect(parsed.citySlug).toBe(citySlug);
    expect(parsed.unit).toBe(unit);
    expect(parsed.station).toEqual({ icao, countryCode: cc });
    expect(parsed.targetDate).toBe(targetDate);
    expect(parsed.kind).toBe('highest');
    expect(parsed.buckets.length).toBe(11);
    expect(parsed.ladderProblems).toEqual([]);
    expect(parsed.acceptingOrders).toBe(true);
    expect(parsed.negRiskMarketId).toMatch(/^0x[0-9a-f]{64}$/);

    // sorted by ladder order: low tail first, high tail last
    expect(parsed.buckets[0]!.def.low).toBeNull();
    expect(parsed.buckets[10]!.def.high).toBeNull();

    for (const b of parsed.buckets) {
      expect(b.tokenYes).toMatch(/^\d{60,80}$/);
      expect(b.tokenNo).toMatch(/^\d{60,80}$/);
      expect(b.conditionId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(b.feeRate).toBe(0.05);
    }
  });

  // REC-3: the full per-market fee + reward config the Gamma event carries (migration 0054).
  it.each(cases)('%s captures the REC-3 fee + reward config (weather_fees)', (file) => {
    const parsed = parseGammaEvent(loadEvent(file));
    for (const b of parsed.buckets) {
      expect(b.feeTakerOnly).toBe(true); // makers pay no fee on weather_fees
      expect(b.feeRebateRate).toBe(0.25); // 25% maker rebate share — the live config
      expect(b.feeType).toBe('weather_fees');
      expect(b.rewardMaxSpread).toBe(4.5);
      expect(b.rewardMinSize).toBe(50);
      expect(b.holdingRewardsEnabled).toBe(false);
    }
  });

  it('REC-3 fields default to null when feeSchedule carries only rate (back-compat)', () => {
    const ev = loadEvent('gamma-event-temperature-london-jun11.json') as unknown as {
      markets: Array<Record<string, unknown>>;
    };
    // strip the extended fields from one market → the parser must degrade to null, not throw
    ev.markets[0]!.feeSchedule = { rate: 0.05 };
    delete ev.markets[0]!.feeType;
    delete ev.markets[0]!.rewardsMaxSpread;
    delete ev.markets[0]!.rewardsMinSize;
    delete ev.markets[0]!.holdingRewardsEnabled;
    const parsed = parseGammaEvent(ev as never);
    const b0 = parsed.buckets.find((b) => b.feeRate === 0.05 && b.feeRebateRate === null);
    expect(b0).toBeDefined();
    expect(b0!.feeTakerOnly).toBeNull();
    expect(b0!.feeType).toBeNull();
    expect(b0!.rewardMaxSpread).toBeNull();
  });

  it('both tick sizes (0.01 AND 0.001) are present across fixture buckets', () => {
    const all = cases.flatMap(([file]) => parseGammaEvent(loadEvent(file)).buckets);
    const ticks = new Set(all.map((b) => b.tickSize));
    expect(ticks.has(0.01)).toBe(true);
    expect(ticks.has(0.001)).toBe(true);
  });

  it('derives the tz offset for brand-new cities (Seoul +9, NYC −4)', () => {
    expect(parseGammaEvent(loadEvent('gamma-event-temperature-seoul-jun11.json')).derivedTzOffset).toBe(9);
    expect(parseGammaEvent(loadEvent('gamma-event-temperature-nyc-jun11.json')).derivedTzOffset).toBe(-4);
    // strict mode with the right tz: no derived offset, no throw
    const strict = parseGammaEvent(loadEvent('gamma-event-temperature-seoul-jun11.json'), 'Asia/Seoul');
    expect(strict.derivedTzOffset).toBeUndefined();
  });

  it('parses the resolved NYC event and exposes outcomePricesResolved', () => {
    const resolved = parseGammaEvent(loadEvent('gamma-event-nyc-jun9-resolved.json'));
    const winner = resolved.buckets.find((b) => b.outcomePricesResolved?.[0] === 1);
    expect(winner?.label).toBe('80-81°F');
    const losers = resolved.buckets.filter((b) => b.outcomePricesResolved?.[1] === 1);
    expect(losers.length).toBe(10);
  });

  it('attaches ladder problems instead of throwing on a broken ladder', () => {
    const ev = loadEvent('gamma-event-temperature-london-jun11.json');
    const broken: RawGammaEvent = { ...ev, markets: ev.markets.filter((m) => m.groupItemTitle !== '14°C') };
    const parsed = parseGammaEvent(broken);
    expect(parsed.buckets.length).toBe(10);
    expect(parsed.ladderProblems.length).toBeGreaterThan(0);
  });

  it('historical-backfill opt-in: a yearless archived event is rejected by default but parses with referenceYear', () => {
    const ev = loadEvent('gamma-event-temperature-london-jun11.json');
    const yearless: RawGammaEvent = { ...ev, slug: ev.slug.replace(/-\d{4}$/, '') };
    expect(yearless.slug).not.toMatch(/-\d{4}$/); // sanity: the year really is gone

    // default (live path) still refuses the yearless slug — the stale-event guard is intact
    expect(() => parseGammaEvent(yearless)).toThrow(GammaShapeError);

    // with referenceYear (the deep-history --series-scan path) it parses identically to the dated original
    const parsed = parseGammaEvent(yearless, undefined, { referenceYear: 2026 });
    expect(parsed.citySlug).toBe('london');
    expect(parsed.targetDate).toBe('2026-06-11');
    expect(parsed.buckets.length).toBe(11);
    expect(parsed.kind).toBe('highest');
  });
});

describe('isZombieEvent (§6.9)', () => {
  it('flags the live-captured Jinan zombie (no orders accepted, 0/1 quotes)', () => {
    const jinan = loadJinanZombie();
    // even on its own target day the degenerate-quote rule catches it
    expect(isZombieEvent(jinan, '2026-05-20')).toBe(true);
    // and later it is also simply expired
    expect(isZombieEvent(jinan, '2026-06-10')).toBe(true);
  });

  it('live events pass', () => {
    for (const file of [
      'gamma-event-temperature-nyc-jun11.json',
      'gamma-event-temperature-london-jun11.json',
      'gamma-event-temperature-seoul-jun11.json',
      'gamma-event-temperature-paris-jun11.json',
    ]) {
      expect(isZombieEvent(loadEvent(file), '2026-06-10')).toBe(false);
    }
  });

  it('an expired endDate alone is enough', () => {
    const nyc = loadEvent('gamma-event-nyc-jun9-resolved.json');
    expect(isZombieEvent(nyc, '2026-06-10')).toBe(true);
  });
});

describe('normalizeBook (§6.9)', () => {
  const raw = JSON.parse(
    readFileSync(join(RESEARCH, 'clob-book-nyc-94-95f.json'), 'utf8'),
  ) as RawClobBook;

  it('reorders to best-first (raw last = best) with numeric levels', () => {
    const book = normalizeBook(raw);
    // fixture: raw asks descend 0.99…0.36, raw bids ascend 0.01…0.33
    expect(book.asks[0]).toEqual({ price: 0.36, size: 13.4 });
    expect(book.bids[0]).toEqual({ price: 0.33, size: 8 });
    for (let i = 0; i < book.asks.length - 1; i++) {
      expect(book.asks[i]!.price).toBeLessThanOrEqual(book.asks[i + 1]!.price);
    }
    for (let i = 0; i < book.bids.length - 1; i++) {
      expect(book.bids[i]!.price).toBeGreaterThanOrEqual(book.bids[i + 1]!.price);
    }
  });

  it('carries hash, tick, min order size, neg risk, and last trade', () => {
    const book = normalizeBook(raw);
    expect(book.hash).toBe('5798f5c31bd81b621d7121d442f18e1e2d06ec7a');
    expect(book.tickSize).toBe(0.01);
    expect(book.minOrderSize).toBe(5);
    expect(book.negRisk).toBe(true);
    expect(book.lastTradePrice).toBe(0.33);
    expect(book.timestamp).toBe(1781082142615);
    expect(book.market).toMatch(/^0x/);
  });

  it('ClobShapeError on missing arrays', () => {
    expect(() => normalizeBook({ ...raw, bids: undefined })).toThrow(ClobShapeError);
    expect(() => normalizeBook({ ...raw, asks: undefined })).toThrow(ClobShapeError);
    expect(() => normalizeBook({})).toThrow(ClobShapeError);
  });

  it('ClobShapeError on non-numeric levels', () => {
    expect(() =>
      normalizeBook({ ...raw, asks: [{ price: 'abc', size: '1' }] }),
    ).toThrow(ClobShapeError);
  });
});

describe('parsePricesHistory (§6.22 market-history backfill input)', () => {
  const load = (file: string): unknown =>
    JSON.parse(readFileSync(join(RESEARCH, file), 'utf8')) as unknown;

  it('parses the original interval=1d capture: 41 ascending points', () => {
    const pts = parsePricesHistory(load('clob-prices-history.json'));
    expect(pts.length).toBe(41);
    expect(pts[0]).toEqual({ t: 1781057404, p: 0.185 });
    expect(pts.at(-1)).toEqual({ t: 1781082363, p: 0.335 });
    for (let i = 0; i < pts.length - 1; i++) {
      expect(pts[i]!.t).toBeLessThanOrEqual(pts[i + 1]!.t);
    }
  });

  it('parses the interval=max resolved-winner capture: 305 points converging to 0.9995', () => {
    const pts = parsePricesHistory(load('clob-prices-history-max-nyc-jun9-winner-80-81f.json'));
    expect(pts.length).toBe(305);
    expect(pts[0]).toEqual({ t: 1780885203, p: 0.245 });
    expect(pts.at(-1)).toEqual({ t: 1781068806, p: 0.9995 });
  });

  it('parses the interval=max resolved-loser capture: converging to 0.0005', () => {
    const pts = parsePricesHistory(load('clob-prices-history-max-nyc-jun9-loser-78-79f.json'));
    expect(pts.at(-1)!.p).toBe(0.0005);
  });

  it('ClobShapeError on missing history array and non-numeric points', () => {
    expect(() => parsePricesHistory(null)).toThrow(ClobShapeError);
    expect(() => parsePricesHistory({})).toThrow(ClobShapeError);
    expect(() => parsePricesHistory({ history: 'nope' })).toThrow(ClobShapeError);
    expect(() => parsePricesHistory({ history: [{ t: 'x', p: 0.5 }] })).toThrow(ClobShapeError);
    expect(() => parsePricesHistory({ history: [{ t: 1, p: null }] })).toThrow(ClobShapeError);
  });
});

describe('rewards — REC-4 liquidity-rewards monitor detector', () => {
  // Shapes mirror the live 2026-06 CLOB /sampling-markets response.
  const worldCup: RawSamplingMarket = {
    condition_id: '0xabc',
    question: 'Will Uruguay win Group H in the 2026 FIFA World Cup?',
    market_slug: 'will-uruguay-win-group-h',
    tags: ['Sports', 'FIFA World Cup'],
    rewards: { rates: [{ asset_address: '0x2791', rewards_daily_rate: 19 }], min_size: 100, max_spread: 4.5 },
  };
  const tempFunded: RawSamplingMarket = {
    condition_id: '0xhot',
    question: 'Highest temperature in NYC on June 30?',
    market_slug: 'highest-temperature-in-nyc-on-june-30-2026',
    tags: ['Weather'],
    rewards: { rates: [{ asset_address: '0x2791', rewards_daily_rate: 12 }], min_size: 50, max_spread: 4.5 },
  };
  const tempUnfunded: RawSamplingMarket = {
    condition_id: '0xcold',
    question: 'Lowest temperature in London on July 1?',
    market_slug: 'lowest-temperature-in-london-on-july-1-2026',
    rewards: { rates: null, min_size: 50, max_spread: 4.5 },
  };

  it('isWeatherMarket: slug prefix, question fallback, and non-weather false', () => {
    expect(isWeatherMarket(tempFunded)).toBe(true);
    expect(isWeatherMarket(tempUnfunded)).toBe(true);
    expect(isWeatherMarket(worldCup)).toBe(false);
    // question fallback when the slug is opaque
    expect(isWeatherMarket({ market_slug: 'opaque-id-123', question: 'Highest temperature in Paris?' })).toBe(true);
    expect(isWeatherMarket({})).toBe(false); // total on junk
  });

  it('isFunded: non-empty rates funded, null/empty not', () => {
    expect(isFunded(tempFunded)).toBe(true);
    expect(isFunded(tempUnfunded)).toBe(false);
    expect(isFunded({ rewards: { rates: [] } })).toBe(false);
    expect(isFunded({})).toBe(false);
  });

  it('scanWeatherRewards separates weather from funded-weather (the REC-4 trigger)', () => {
    const r = scanWeatherRewards([worldCup, tempFunded, tempUnfunded]);
    expect(r.nScanned).toBe(3);
    expect(r.weather.map((h) => h.conditionId).sort()).toEqual(['0xcold', '0xhot']);
    expect(r.fundedWeather.map((h) => h.conditionId)).toEqual(['0xhot']);
    expect(r.fundedWeather[0]!.dailyRateTotal).toBe(12);
  });

  it("today's reality: a pool of only non-weather funded markets ⇒ no weather trigger", () => {
    const r = scanWeatherRewards([worldCup, worldCup]);
    expect(r.weather).toEqual([]);
    expect(r.fundedWeather).toEqual([]);
  });

  it('is total on empty / junk input', () => {
    expect(scanWeatherRewards([]).nScanned).toBe(0);
    expect(scanWeatherRewards(null as never).fundedWeather).toEqual([]);
  });

  it('fundedDailyRate sums the rates (0 when unfunded/junk)', () => {
    expect(fundedDailyRate(tempFunded)).toBe(12);
    expect(fundedDailyRate({ rewards: { rates: [{ rewards_daily_rate: 5 }, { rewards_daily_rate: 7 }] } })).toBe(12);
    expect(fundedDailyRate(tempUnfunded)).toBe(0);
    expect(fundedDailyRate({})).toBe(0);
  });
});

describe('reduceBookDepth — REC-8/9 Phase A near-mid depth (the competition denominator)', () => {
  it('computes mid/best + in-band depth, excluding orders beyond max_spread', () => {
    const d = reduceBookDepth(
      [
        { price: 0.1, size: 100 }, // 1.5c from mid 0.115 → in band
        { price: 0.05, size: 999 }, // 6.5c away → out
      ],
      [{ price: 0.13, size: 200 }], // 1.5c from mid → in band
      4.5,
    );
    expect(d.bestBid).toBe(0.1);
    expect(d.bestAsk).toBe(0.13);
    expect(d.mid).toBeCloseTo(0.115, 9);
    expect(d.bidDepthShares).toBe(100);
    expect(d.askDepthShares).toBe(200);
    expect(d.bidDepthUsd).toBeCloseTo(100 * 0.1, 9);
    expect(d.askDepthUsd).toBeCloseTo(200 * (1 - 0.13), 9);
  });

  it('accepts string price/size (raw CLOB shape) and ignores junk levels', () => {
    const d = reduceBookDepth(
      [{ price: '0.20', size: '50' }, { price: '0', size: '10' }] as never,
      [{ price: '0.22', size: '40' }] as never,
      4.5,
    );
    expect(d.bidDepthShares).toBe(50);
    expect(d.askDepthShares).toBe(40);
  });

  it('one-sided / empty book → null mid + zero depth (never throws)', () => {
    const oneSided = reduceBookDepth([{ price: 0.1, size: 100 }], [], 4.5);
    expect(oneSided.mid).toBeNull();
    expect(oneSided.bidDepthShares).toBe(0);
    expect(reduceBookDepth(undefined, undefined, 4.5).mid).toBeNull();
  });
});
