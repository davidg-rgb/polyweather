import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchTrades,
  parseActivity,
  parseLeaderboard,
  parseMarketsMeta,
  parsePositionMarket,
  parsePositions,
  parseTrades,
  parseUserPnl,
  POLYMARKET_DATA_API,
  POLYMARKET_USER_PNL_API,
  SHARP_WALLET_ADDRESS,
  SHARP_WALLET_LABEL,
} from '../src/polymarket-wallet.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESEARCH = resolve(__dirname, '../../../research');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(RESEARCH, name), 'utf8'));

const positionsFixture = fixture('dataapi-positions-badatmath-sample.json');
const leaderboardFixture = fixture('dataapi-weather-leaderboard-sample.json');
const userPnlFixture = fixture('userpnl-badatmath.json');
const activityFixture = fixture('dataapi-activity-badatmath-sample.json');
const tradesFixture = fixture('dataapi-trades-whales-sample.json');

// Pure tests only — no network, no fetch stubbing. These pin the parsers to the LIVE fixtures and to
// the documented Deno/Node seam (supabase/functions/_shared/polymarket-wallet.ts must stay behaviourally
// identical for parsePositions/parseLeaderboard/parseUserPnl + parsePositionMarket + the drop rules).

describe('parsePositionMarket', () => {
  it('parses a highest-temperature event slug → kind/citySlug/targetDate', () => {
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-june-22-2026')).toEqual({
      kind: 'highest',
      citySlug: 'amsterdam',
      targetDate: '2026-06-22',
    });
  });

  it('parses a lowest-temperature slug and a multi-segment city', () => {
    expect(parsePositionMarket('lowest-temperature-in-new-york-city-on-december-5-2026')).toEqual({
      kind: 'lowest',
      citySlug: 'new-york-city',
      targetDate: '2026-12-05',
    });
  });

  it('returns null for a non-temperature slug', () => {
    expect(parsePositionMarket('lal-lev-sev-2026-04-23-more-markets')).toBeNull();
  });

  it('returns null for a bucket-LEG slug (trailing suffix) — pass the EVENT slug, not the leg', () => {
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-june-22-2026-25c')).toBeNull();
  });

  it('returns null on a yearless / unparseable / empty slug', () => {
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-june-22')).toBeNull();
    expect(parsePositionMarket('garbage')).toBeNull();
    expect(parsePositionMarket('')).toBeNull();
    // @ts-expect-error — defensive: tolerate a non-string at runtime
    expect(parsePositionMarket(undefined)).toBeNull();
  });

  it('rejects an out-of-range day and an unknown month', () => {
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-june-99-2026')).toBeNull();
    expect(parsePositionMarket('highest-temperature-in-amsterdam-on-smarch-12-2026')).toBeNull();
  });
});

describe('parsePositions', () => {
  it('parses the live badatmath positions fixture (size NOT shares)', () => {
    const rows = parsePositions(positionsFixture);
    expect(rows.length).toBe(9);
    const first = rows[0]!;
    // `size` → sizeShares (the quirk: the field is `size`, never `shares`)
    expect(first.sizeShares).toBeCloseTo(543.8603, 4);
    expect(first.conditionId).toBe(
      '0x6dbec8d0c6bd7deabf280d4db89056f4c25333c6e82f0be1df6de1826006d118',
    );
    expect(first.outcome).toBe('Yes');
    expect(first.avgPrice).toBeCloseTo(0.154, 4);
    // event slug derivation
    expect(first.kind).toBe('highest');
    expect(first.citySlug).toBe('amsterdam');
    expect(first.targetDate).toBe('2026-06-22');
  });

  it('maps cash/realized PnL, current value and redeemable correctly', () => {
    const rows = parsePositions(positionsFixture);
    const first = rows[0]!;
    expect(first.cashPnlUsd).toBeCloseTo(19.3026, 4);
    expect(first.realizedPnlUsd).toBe(0);
    expect(first.currentValueUsd).toBeCloseTo(103.0615, 4);
    expect(first.curPrice).toBeCloseTo(0.1895, 4);
    expect(first.redeemable).toBe(false);
    expect(first.endDate).toBe('2026-06-22');
  });

  it('derives non-Amsterdam temperature markets (Tokyo) too', () => {
    const rows = parsePositions(positionsFixture);
    const tokyo = rows.find((r) => r.citySlug === 'tokyo');
    expect(tokyo).toBeDefined();
    expect(tokyo!.kind).toBe('highest');
    expect(tokyo!.targetDate).toBe('2026-06-22');
  });

  it('is pure + total: [] on non-array / junk', () => {
    expect(parsePositions(null)).toEqual([]);
    expect(parsePositions(undefined)).toEqual([]);
    expect(parsePositions({})).toEqual([]);
    expect(parsePositions('nope')).toEqual([]);
    expect(parsePositions(42)).toEqual([]);
  });

  it('skips malformed rows (no conditionId, no finite size) without throwing', () => {
    const rows = parsePositions([
      null,
      { foo: 'bar' }, // no conditionId
      { conditionId: '' }, // empty conditionId
      { conditionId: '0xabc' }, // no size
      { conditionId: '0xabc', size: 'not-a-number' }, // non-finite size
      { conditionId: '0xKEEP', size: 1.5, eventSlug: 'not-a-temp-market' }, // valid, non-temp
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.conditionId).toBe('0xKEEP');
    expect(rows[0]!.sizeShares).toBe(1.5);
    expect(rows[0]!.kind).toBeNull();
    expect(rows[0]!.citySlug).toBeNull();
  });

  it('coerces numeric strings (size/avgPrice arriving as strings)', () => {
    const rows = parsePositions([{ conditionId: '0xs', size: '12.5', avgPrice: '0.33' }]);
    expect(rows[0]!.sizeShares).toBe(12.5);
    expect(rows[0]!.avgPrice).toBe(0.33);
  });
});

describe('parseLeaderboard', () => {
  it('parses the live WEATHER leaderboard fixture (rank-as-string → number)', () => {
    const rows = parseLeaderboard(leaderboardFixture);
    expect(rows.length).toBe(10);
    const top = rows[0]!;
    // rank is a STRING upstream ('1') — coerced to a number
    expect(top.rank).toBe(1);
    expect(typeof top.rank).toBe('number');
    expect(top.address).toBe(SHARP_WALLET_ADDRESS);
    expect(top.label).toBe(SHARP_WALLET_LABEL);
    expect(top.pnlUsd).toBeCloseTo(22927.205870918584, 3);
    expect(top.volumeUsd).toBeCloseTo(1197314.3280089998, 1);
    // field-name discipline: proxyWallet→address, userName→label, vol→volumeUsd, pnl→pnlUsd
  });

  it('falls back label → address when userName is empty', () => {
    const rows = parseLeaderboard([
      { rank: '3', proxyWallet: '0xNOUSER', userName: '', pnl: 1, vol: 2 },
    ]);
    expect(rows[0]!.label).toBe('0xNOUSER');
  });

  it('is pure + total: [] on non-array / junk and skips rows with no wallet', () => {
    expect(parseLeaderboard(null)).toEqual([]);
    expect(parseLeaderboard({})).toEqual([]);
    expect(parseLeaderboard([null, { userName: 'x' }, { proxyWallet: '' }])).toEqual([]);
  });
});

describe('parseUserPnl', () => {
  it('parses the live user-pnl curve ([{t,p}] → {t,cumPnlUsd})', () => {
    const rows = parseUserPnl(userPnlFixture);
    expect(rows.length).toBe(164); // every fixture row is kept (faithful, no drops)
    expect(rows[0]!).toEqual({ t: 1768089600, cumPnlUsd: -26.331144 });
    // the verified lifetime realized PnL endpoint (~$25,053 final cum point)
    expect(rows.at(-1)!.cumPnlUsd).toBeCloseTo(25053.46, 2);
  });

  it('is pure + total: [] on non-array / junk; drops rows without finite t or p', () => {
    expect(parseUserPnl(null)).toEqual([]);
    expect(parseUserPnl('nope')).toEqual([]);
    expect(parseUserPnl([null, { t: 1 }, { p: 2 }, { t: 'x', p: 'y' }])).toEqual([]);
    expect(parseUserPnl([{ t: 100, p: -5 }])).toEqual([{ t: 100, cumPnlUsd: -5 }]);
  });
});

describe('parseActivity', () => {
  it('parses the live activity fixture (TRADE + REDEEM + SPLIT)', () => {
    const rows = parseActivity(activityFixture);
    expect(rows.length).toBe(4); // every row is kept (permissive drop rule)
    expect(rows.map((r) => r.type)).toEqual(['TRADE', 'TRADE', 'REDEEM', 'SPLIT']);
  });

  it('surfaces a TRADE BUY on a temperature market with size/usdcSize/price + market derivation', () => {
    const [trade] = parseActivity(activityFixture);
    expect(trade!.type).toBe('TRADE');
    expect(trade!.side).toBe('BUY');
    expect(trade!.sizeShares).toBeCloseTo(5.1, 4); // `size` field = shares
    expect(trade!.usdcSize).toBeCloseTo(3.621, 4); // `usdcSize` = notional
    expect(trade!.price).toBeCloseTo(0.71, 4); // entry price in 0..1
    expect(trade!.outcome).toBe('No');
    expect(trade!.conditionId).toBe(
      '0xd4e292039e3d6e4ac70beecc10115c379dc177578cd01302ae2efc520c30c108',
    );
    expect(trade!.kind).toBe('highest');
    expect(trade!.citySlug).toBe('lucknow');
    expect(trade!.targetDate).toBe('2026-06-22');
    expect(trade!.timestamp).toBe(1782113594);
  });

  it('KEEPS a TRADE with an empty conditionId/eventSlug (merged-leg outcomeIndex:999 row)', () => {
    const rows = parseActivity(activityFixture);
    const merged = rows[1]!;
    expect(merged.type).toBe('TRADE');
    expect(merged.conditionId).toBe('');
    expect(merged.eventSlug).toBe('');
    expect(merged.kind).toBeNull(); // no resolvable market metadata
    expect(merged.sizeShares).toBeCloseTo(5.1, 4); // but a real fill — kept for FIFO reconstruction
  });

  it('maps a REDEEM row: side → null (upstream sends ""), price 0, still derives the market', () => {
    const rows = parseActivity(activityFixture);
    const redeem = rows.find((r) => r.type === 'REDEEM')!;
    expect(redeem.side).toBeNull(); // non-trade event → null, NOT ''
    expect(redeem.price).toBe(0);
    expect(redeem.asset).toBe('');
    expect(redeem.outcome).toBe('');
    expect(redeem.sizeShares).toBeCloseTo(27.046966, 6);
    expect(redeem.usdcSize).toBeCloseTo(27.046966, 6);
    // a REDEEM still carries a parseable temperature eventSlug
    expect(redeem.kind).toBe('highest');
    expect(redeem.citySlug).toBe('seattle');
    expect(redeem.targetDate).toBe('2026-06-21');
  });

  it('handles a non-temperature event (SPLIT on a football market → null market)', () => {
    const rows = parseActivity(activityFixture);
    const split = rows.find((r) => r.type === 'SPLIT')!;
    expect(split.side).toBeNull();
    expect(split.kind).toBeNull();
    expect(split.citySlug).toBeNull();
    expect(split.targetDate).toBeNull();
  });

  it('maps SELL side correctly (synthetic — badatmath is near pure-BUY so no live SELL in window)', () => {
    const rows = parseActivity([
      { type: 'TRADE', side: 'SELL', conditionId: '0xs', asset: 'a', outcome: 'Yes', size: 3, price: 0.4, usdcSize: 1.2, timestamp: 1782000000, eventSlug: 'x', title: 't' },
    ]);
    expect(rows[0]!.side).toBe('SELL');
  });

  it('is pure + total: [] on non-array / junk', () => {
    expect(parseActivity(null)).toEqual([]);
    expect(parseActivity(undefined)).toEqual([]);
    expect(parseActivity({})).toEqual([]);
    expect(parseActivity('nope')).toEqual([]);
  });

  it('skips rows with no usable type or no finite timestamp/size/usdcSize; never throws on drift', () => {
    const rows = parseActivity([
      null,
      { side: 'BUY', size: 1, usdcSize: 1, timestamp: 1 }, // no type
      { type: '', size: 1, usdcSize: 1, timestamp: 1 }, // empty type
      { type: 'TRADE', size: 1, usdcSize: 1 }, // no timestamp
      { type: 'TRADE', usdcSize: 1, timestamp: 1 }, // no size
      { type: 'TRADE', size: 1, timestamp: 1 }, // no usdcSize
      { type: 'TRADE', size: 'x', usdcSize: 1, timestamp: 1 }, // non-finite size
      { type: 'TRADE', side: 'BUY', size: 2, usdcSize: 1, price: 0.5, timestamp: 1782000001 }, // valid (no slug)
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.sizeShares).toBe(2);
    expect(rows[0]!.kind).toBeNull();
  });
});

describe('parseMarketsMeta', () => {
  it('parses a gamma /markets payload (stringified outcomes/clobTokenIds) → Map keyed by conditionId', () => {
    const map = parseMarketsMeta([
      {
        conditionId: '0xd4e292039e3d6e4ac70beecc10115c379dc177578cd01302ae2efc520c30c108',
        outcomes: '["Yes", "No"]',
        clobTokenIds: '["40577564342703578928647355672687169281710568803203394151028115227098754098488", "6846953374172617111435361434044453186090614829023634868822253778263881761741"]',
        endDate: '2026-06-22T12:00:00Z',
        createdAt: '2026-06-20T05:02:36.139742Z',
        negRisk: true,
      },
    ]);
    expect(map.size).toBe(1);
    const meta = map.get('0xd4e292039e3d6e4ac70beecc10115c379dc177578cd01302ae2efc520c30c108')!;
    expect(meta.outcomes).toEqual(['Yes', 'No']);
    expect(meta.clobTokenIds.length).toBe(2);
    expect(meta.endDate).toBe('2026-06-22T12:00:00Z');
    expect(meta.createdAt).toBe('2026-06-20T05:02:36.139742Z');
    expect(meta.negRisk).toBe(true);
  });

  it('tolerates already-array fields and missing/junk fields', () => {
    const map = parseMarketsMeta([
      { conditionId: '0xa', outcomes: ['Yes', 'No'], clobTokenIds: 'not-json', negRisk: 'nope' },
    ]);
    const meta = map.get('0xa')!;
    expect(meta.outcomes).toEqual(['Yes', 'No']);
    expect(meta.clobTokenIds).toEqual([]); // unparseable → []
    expect(meta.endDate).toBeNull();
    expect(meta.negRisk).toBeNull(); // non-boolean → null
  });

  it('is pure + total: empty Map on non-array / junk; skips rows with no conditionId', () => {
    expect(parseMarketsMeta(null).size).toBe(0);
    expect(parseMarketsMeta({}).size).toBe(0);
    expect(parseMarketsMeta([null, {}, { conditionId: '' }]).size).toBe(0);
  });
});

describe('exported constants (the documented Deno/Node seam values)', () => {
  it('exposes the canonical hosts + sharp wallet identity', () => {
    expect(POLYMARKET_DATA_API).toBe('https://data-api.polymarket.com');
    expect(POLYMARKET_USER_PNL_API).toBe('https://user-pnl-api.polymarket.com');
    expect(SHARP_WALLET_ADDRESS).toBe('0x8fbd7cf5f806f563080864694415829f7229a959');
    expect(SHARP_WALLET_LABEL).toBe('badatmath.');
  });
});

describe('parseTrades (whale-watch — global /trades feed)', () => {
  it('parses the live whale fixture: notional = size × price, trader/side/outcome/link fields', () => {
    const rows = parseTrades(tradesFixture);
    expect(rows.length).toBe(4); // every fixture row carries a txHash → all kept
    const first = rows[0]!;
    expect(first.sizeShares).toBeCloseTo(121597.59, 2);
    expect(first.price).toBeCloseTo(0.999, 3);
    expect(first.notionalUsd).toBeCloseTo(121475.99241, 2); // derived = size × price
    expect(first.side).toBe('SELL');
    expect(first.outcome).toBe('Under'); // multi-outcome market — NOT Yes/No
    expect(first.traderName).toBe('Iconicsoundsdk'); // `name` wins
    expect(first.eventSlug).toBe('fifwc-eng-gha-2026-06-23-more-markets');
    expect(first.transactionHash).toBe(
      '0x3c4c44fb8c4e45dd6d96152a4f5729087b8437414900fed525af4f9c5dadc45f',
    );
  });

  it('traderName falls back name → pseudonym → ""', () => {
    const rows = parseTrades([
      { transactionHash: '0x1', size: 1, price: 0.5, timestamp: 1, name: '', pseudonym: 'Severe-Bootie' },
      { transactionHash: '0x2', size: 1, price: 0.5, timestamp: 1 },
    ]);
    expect(rows[0]!.traderName).toBe('Severe-Bootie');
    expect(rows[1]!.traderName).toBe('');
  });

  it('maps BUY/SELL and leaves an unknown side null', () => {
    const rows = parseTrades([
      { transactionHash: '0x1', size: 1, price: 0.5, timestamp: 1, side: 'buy' },
      { transactionHash: '0x2', size: 1, price: 0.5, timestamp: 1, side: 'weird' },
    ]);
    expect(rows[0]!.side).toBe('BUY'); // case-insensitive
    expect(rows[1]!.side).toBeNull();
  });

  it('drops rows without a txHash or with non-finite size/price/timestamp; never throws', () => {
    const rows = parseTrades([
      null,
      { size: 1, price: 0.5, timestamp: 1 }, // no txHash → cannot dedup/alert
      { transactionHash: '', size: 1, price: 0.5, timestamp: 1 }, // empty txHash
      { transactionHash: '0xa', price: 0.5, timestamp: 1 }, // no size
      { transactionHash: '0xb', size: 'x', price: 0.5, timestamp: 1 }, // non-finite size
      { transactionHash: '0xc', size: 1, price: 'x', timestamp: 1 }, // non-finite price
      { transactionHash: '0xd', size: 1, price: 0.5 }, // no timestamp
      { transactionHash: '0xKEEP', size: 2, price: 0.5, timestamp: 1782000000 }, // valid
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.transactionHash).toBe('0xKEEP');
    expect(rows[0]!.notionalUsd).toBe(1);
  });

  it('is pure + total: [] on non-array / junk', () => {
    expect(parseTrades(null)).toEqual([]);
    expect(parseTrades(undefined)).toEqual([]);
    expect(parseTrades({})).toEqual([]);
    expect(parseTrades('nope')).toEqual([]);
  });
});

describe('fetchTrades (URL building + paging)', () => {
  /** Capture every URL the fetcher builds; return a fixed-size page so paging is controllable. */
  function capture(pageLens: number[]) {
    const urls: string[] = [];
    let call = 0;
    const fetchJson = (url: string): Promise<unknown> => {
      urls.push(url);
      const len = pageLens[call] ?? 0;
      call++;
      return Promise.resolve(Array.from({ length: len }, () => ({}))); // rawLen drives paging
    };
    return { urls, fetchJson };
  }

  it('builds the GLOBAL feed URL by default (no market/user, takerOnly=true)', async () => {
    const c = capture([0]);
    await fetchTrades(c.fetchJson);
    expect(c.urls[0]).toBe(`${POLYMARKET_DATA_API}/trades?limit=100&offset=0&takerOnly=true`);
  });

  it('appends the server-side CASH filter (the whale floor) and clamps limit ≤500', async () => {
    const c = capture([0]);
    await fetchTrades(c.fetchJson, { filterType: 'CASH', filterAmount: 100000, limit: 1000 });
    expect(c.urls[0]).toContain('limit=500'); // clamped (first param: ?limit=500)
    expect(c.urls[0]).not.toContain('limit=1000');
    expect(c.urls[0]).toContain('&filterType=CASH&filterAmount=100000');
  });

  it('URL-encodes market and user when scoping is requested', async () => {
    const c = capture([0]);
    await fetchTrades(c.fetchJson, { market: 'a&b', user: 'x y' });
    expect(c.urls[0]).toContain('market=a%26b');
    expect(c.urls[0]).toContain('user=x%20y');
  });

  it('pages by offset and stops at the first short page', async () => {
    const c = capture([100, 3]); // full page then short page
    const rows = await fetchTrades(c.fetchJson, { limit: 100, maxPages: 5, pageDelayMs: 0 });
    expect(c.urls.length).toBe(2); // stopped after the short page, not all 5
    expect(c.urls[0]).toContain('offset=0');
    expect(c.urls[1]).toContain('offset=100');
    expect(rows).toEqual([]); // the {} rows have no txHash → all dropped by parseTrades
  });
});
