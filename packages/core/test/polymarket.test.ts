import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClobShapeError, GammaShapeError } from '../src/errors.ts';
import { normalizeBook, type RawClobBook } from '../src/polymarket/clob.ts';
import {
  extractStationFromUrl,
  isZombieEvent,
  parseGammaEvent,
  parseStringArray,
  targetDateFromEvent,
  type RawGammaEvent,
} from '../src/polymarket/gamma.ts';

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
