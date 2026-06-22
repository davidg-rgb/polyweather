/**
 * _shared/polymarket-wallet — pure unit test (no DB, no network): the three parsers against the real
 * payload shapes (incl. the live research fixtures) + edge cases (empty/malformed/non-array), and each
 * fetch wrapper against a stubbed fetchJson (asserting the URL it builds).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fetchUserPnl,
  fetchWalletPositions,
  fetchWeatherLeaderboard,
  parseLeaderboard,
  parsePositionMarket,
  parsePositions,
  parseUserPnl,
  POLYMARKET_DATA_API,
  POLYMARKET_USER_PNL_API,
  SHARP_WALLET_ADDRESS,
} from '../functions/_shared/polymarket-wallet.ts';

const RESEARCH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'research');
const loadFixture = (file: string): unknown => JSON.parse(readFileSync(join(RESEARCH, file), 'utf8'));

describe('parsePositionMarket — event slug → {kind, citySlug, targetDate}', () => {
  it('parses a highest-temperature event slug (slug date = station-local target)', () => {
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-june-22-2026')).toEqual({
      kind: 'highest',
      citySlug: 'amsterdam',
      targetDate: '2026-06-22',
    });
  });

  it('parses a multi-segment city slug and a lowest-temperature kind', () => {
    expect(parsePositionMarket('lowest-temperature-in-kuala-lumpur-on-december-6-2025')).toEqual({
      kind: 'lowest',
      citySlug: 'kuala-lumpur',
      targetDate: '2025-12-06',
    });
  });

  it('returns null on a non-temperature / yearless / unparseable slug (total, never throws)', () => {
    expect(parsePositionMarket('will-trump-win-2024')).toBeNull();
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-june-22')).toBeNull(); // yearless trap
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-smarch-22-2026')).toBeNull(); // bad month
    expect(parsePositionMarket('')).toBeNull();
  });
});

describe('parsePositions — /positions payload → WalletPosition[]', () => {
  it('normalizes fields (size→sizeShares, currentValue→currentValueUsd) and derives the market', () => {
    const payload = [
      {
        proxyWallet: SHARP_WALLET_ADDRESS,
        asset: '7441',
        conditionId: '0xabc',
        size: 543.8603,
        avgPrice: 0.154,
        currentValue: 103.0615,
        cashPnl: 12.34,
        realizedPnl: -2.15,
        curPrice: 0.19,
        redeemable: false,
        title: 'Will the highest temperature in Amsterdam be 25°C or below on June 22?',
        slug: 'highest-temperature-in-amsterdam-on-june-22-2026-25corbelow',
        eventSlug: 'highest-temperature-in-amsterdam-on-june-22-2026',
        outcome: 'Yes',
        endDate: '2026-06-22',
      },
    ];
    expect(parsePositions(payload)).toEqual([
      {
        conditionId: '0xabc',
        asset: '7441',
        outcome: 'Yes',
        sizeShares: 543.8603,
        avgPrice: 0.154,
        curPrice: 0.19,
        currentValueUsd: 103.0615,
        cashPnlUsd: 12.34,
        realizedPnlUsd: -2.15,
        redeemable: false,
        title: 'Will the highest temperature in Amsterdam be 25°C or below on June 22?',
        slug: 'highest-temperature-in-amsterdam-on-june-22-2026-25corbelow',
        eventSlug: 'highest-temperature-in-amsterdam-on-june-22-2026',
        endDate: '2026-06-22',
        kind: 'highest',
        citySlug: 'amsterdam',
        targetDate: '2026-06-22',
      },
    ]);
  });

  it('keeps a non-temperature position with a null market rather than dropping it', () => {
    const [p] = parsePositions([
      { conditionId: '0xdef', size: 10, avgPrice: 0.5, outcome: 'No', eventSlug: 'some-sports-market' },
    ]);
    expect(p?.conditionId).toBe('0xdef');
    expect(p?.citySlug).toBeNull();
    expect(p?.targetDate).toBeNull();
    expect(p?.kind).toBeNull();
  });

  it('drops rows without a conditionId or a finite size; total on a non-array', () => {
    const payload = [
      { size: 10, eventSlug: 'highest-temperature-in-amsterdam-on-june-22-2026' }, // no conditionId
      { conditionId: '0x1', size: 'NaN', eventSlug: 'x' }, // unparseable size
      { conditionId: '0x2', eventSlug: 'x' }, // absent size
      { conditionId: '0x3', size: 5, avgPrice: 0.2, outcome: 'Yes', eventSlug: 'highest-temperature-in-paris-on-june-8-2026' },
    ];
    const out = parsePositions(payload);
    expect(out.map((p) => p.conditionId)).toEqual(['0x3']);
    expect(parsePositions(null)).toEqual([]);
    expect(parsePositions({})).toEqual([]);
    expect(parsePositions('nope')).toEqual([]);
  });

  it('parses the live fixture: 6 of 9 positions are Amsterdam, fields finite', () => {
    const out = parsePositions(loadFixture('dataapi-positions-badatmath-sample.json'));
    expect(out.length).toBe(9);
    const ams = out.filter((p) => p.citySlug === 'amsterdam');
    expect(ams.length).toBe(6);
    // the documented cheap-longshot edge: a sub-0.25 YES on the low tail
    const cheapYes = ams.find((p) => p.outcome === 'Yes' && p.avgPrice < 0.25);
    expect(cheapYes).toBeDefined();
    expect(out.every((p) => Number.isFinite(p.sizeShares) && Number.isFinite(p.avgPrice))).toBe(true);
    expect(out.every((p) => p.conditionId.startsWith('0x'))).toBe(true);
  });
});

describe('parseLeaderboard — /v1/leaderboard payload → LeaderboardEntry[]', () => {
  it('coerces the string rank, maps proxyWallet/userName/pnl/vol, falls back label→address', () => {
    const payload = [
      { rank: '1', proxyWallet: '0xaaa', userName: 'badatmath.', pnl: 22927.5, vol: 1196849.5 },
      { rank: '2', proxyWallet: '0xbbb', userName: '', pnl: -10, vol: 5 }, // empty name → address
    ];
    expect(parseLeaderboard(payload)).toEqual([
      { rank: 1, address: '0xaaa', label: 'badatmath.', pnlUsd: 22927.5, volumeUsd: 1196849.5 },
      { rank: 2, address: '0xbbb', label: '0xbbb', pnlUsd: -10, volumeUsd: 5 },
    ]);
  });

  it('drops rows without a wallet; total on a non-array', () => {
    expect(parseLeaderboard([{ rank: '1', userName: 'x' }])).toEqual([]);
    expect(parseLeaderboard(null)).toEqual([]);
  });

  it('parses the live fixture: badatmath. is rank 1', () => {
    const out = parseLeaderboard(loadFixture('dataapi-weather-leaderboard-sample.json'));
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(out[0]!.rank).toBe(1);
    expect(out[0]!.label).toBe('badatmath.');
    expect(out[0]!.address.toLowerCase()).toBe(SHARP_WALLET_ADDRESS);
  });
});

describe('parseUserPnl — user-pnl payload → UserPnlPoint[]', () => {
  it('maps {t,p} → {t, cumPnlUsd}, truncates t, drops non-finite', () => {
    expect(
      parseUserPnl([
        { t: 1768089600, p: -26.331144 },
        { t: 1782111600.9, p: 25053.46 },
        { t: 'x', p: 1 },
        { t: 1, p: null },
      ]),
    ).toEqual([
      { t: 1768089600, cumPnlUsd: -26.331144 },
      { t: 1782111600, cumPnlUsd: 25053.46 },
    ]);
    expect(parseUserPnl(null)).toEqual([]);
  });

  it('parses the live fixture: monotone time axis, ends near +$25k (the verified curve)', () => {
    const out = parseUserPnl(loadFixture('userpnl-badatmath.json'));
    expect(out.length).toBeGreaterThan(100);
    expect(out[0]!.cumPnlUsd).toBeLessThan(0); // flat/losing start
    expect(out[out.length - 1]!.cumPnlUsd).toBeGreaterThan(20000); // the regime change paid off
    for (let i = 1; i < out.length; i++) expect(out[i]!.t).toBeGreaterThan(out[i - 1]!.t);
  });
});

describe('fetch wrappers — the URL each builds (stubbed fetchJson)', () => {
  it('fetchWalletPositions builds the /positions query with sizeThreshold + limit + offset', async () => {
    let seen = '';
    await fetchWalletPositions(
      async (url) => {
        seen = url;
        return [];
      },
      SHARP_WALLET_ADDRESS,
      { sizeThreshold: 0.1, limit: 500, offset: 0 },
    );
    expect(seen).toBe(
      `${POLYMARKET_DATA_API}/positions?user=${SHARP_WALLET_ADDRESS}` +
        `&sizeThreshold=0.1&limit=500&offset=0&sortBy=CURRENT`,
    );
  });

  it('fetchWeatherLeaderboard targets category=WEATHER orderBy=PNL', async () => {
    let seen = '';
    await fetchWeatherLeaderboard(async (url) => {
      seen = url;
      return [];
    }, { timePeriod: 'MONTH', limit: 50 });
    expect(seen).toBe(`${POLYMARKET_DATA_API}/v1/leaderboard?category=WEATHER&timePeriod=MONTH&orderBy=PNL&limit=50`);
  });

  it('fetchUserPnl targets the user-pnl host with interval=all fidelity=1d', async () => {
    let seen = '';
    await fetchUserPnl(async (url) => {
      seen = url;
      return [];
    }, SHARP_WALLET_ADDRESS);
    expect(seen).toBe(
      `${POLYMARKET_USER_PNL_API}/user-pnl?user_address=${SHARP_WALLET_ADDRESS}&interval=all&fidelity=1d`,
    );
  });
});
