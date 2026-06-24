/**
 * Tests for core/polymarket/insider — the PURE insider-shape scorer (WHALE-INSIDER-SCAN.md). Covers the
 * category tagger (the sports/non-sports split that drives the whole verdict), held-to-resolution fill
 * P&L (BUY/SELL × win/lose, inventory-correct), the efficient-market implied win prob, and the
 * insider-shaped predicate (sports excluded, near-certain excluded, lead-time gate). All pure.
 */
import { describe, expect, it } from 'vitest';
import {
  categorizeMarket,
  fillHeldPnl,
  impliedWinProb,
  INSIDER_DEFAULTS,
  isInformativeBet,
} from '../src/polymarket/insider.ts';

describe('categorizeMarket', () => {
  it('tags sports (vs., spreads, "win on DATE", esports)', () => {
    expect(categorizeMarket('Knicks vs. Spurs')).toBe('sports');
    expect(categorizeMarket('Spread: Germany (-3.5)')).toBe('sports');
    expect(categorizeMarket('Will France win on 2026-06-16?')).toBe('sports');
    expect(categorizeMarket('Dota 2: Team Falcons vs PARIVISION')).toBe('sports');
  });
  it('tags weather, crypto, politics, macro', () => {
    expect(categorizeMarket('', 'highest-temperature-in-nyc-on-june-12-2026')).toBe('weather');
    expect(categorizeMarket('Bitcoin above $120k on June 30?')).toBe('crypto');
    expect(categorizeMarket('Will Trump pardon X by July?')).toBe('politics');
    expect(categorizeMarket('CPI above 3% in March?')).toBe('macro');
  });
  it('falls back to "other" for generic resolvable events (the insider habitat)', () => {
    expect(categorizeMarket('US and Iran sign an agreement by March 31?')).toBe('other');
    expect(categorizeMarket('Khamenei out as Supreme Leader by March?')).toBe('other');
  });
  it('is total on junk input', () => {
    expect(categorizeMarket('')).toBe('other');
    expect(categorizeMarket(undefined as unknown as string)).toBe('other');
  });
});

describe('fillHeldPnl', () => {
  it('BUY: profit when the bought outcome wins, loss when it loses', () => {
    // 100 shares of Yes @0.30 → win: 100×(1−0.30)=70 ; lose: 100×(0−0.30)=−30
    expect(fillHeldPnl('BUY', 'Yes', 100, 0.3, 'Yes')).toBeCloseTo(70);
    expect(fillHeldPnl('BUY', 'Yes', 100, 0.3, 'No')).toBeCloseTo(-30);
  });
  it('SELL: profit when the sold outcome loses (the §-fixing case)', () => {
    // SELL 100 Yes @0.999 → if Yes wins (the usual case) you LOSE: 100×(0.999−1)=−0.1 (a near-certain sell is not an insider win)
    expect(fillHeldPnl('SELL', 'Yes', 100, 0.999, 'Yes')).toBeCloseTo(-0.1);
    // if Yes loses you keep the 0.999: 100×(0.999−0)=99.9
    expect(fillHeldPnl('SELL', 'Yes', 100, 0.999, 'No')).toBeCloseTo(99.9);
  });
  it('returns 0 when unresolved or non-finite', () => {
    expect(fillHeldPnl('BUY', 'Yes', 100, 0.3, null)).toBe(0);
    expect(fillHeldPnl('BUY', 'Yes', Number.NaN, 0.3, 'Yes')).toBe(0);
  });
});

describe('impliedWinProb', () => {
  it('BUY → price, SELL → 1−price', () => {
    expect(impliedWinProb('BUY', 0.34)).toBeCloseTo(0.34);
    expect(impliedWinProb('SELL', 0.34)).toBeCloseTo(0.66);
  });
});

describe('isInformativeBet', () => {
  it('true for a non-sports underdog with lead time', () => {
    expect(isInformativeBet('other', 0.3, 18, INSIDER_DEFAULTS)).toBe(true);
    expect(isInformativeBet('politics', 0.4, null /* lead unknown */, INSIDER_DEFAULTS)).toBe(true);
  });
  it('excludes sports (live-trading / favorite-backing is skill, not info)', () => {
    expect(isInformativeBet('sports', 0.36, 5, INSIDER_DEFAULTS)).toBe(false);
  });
  it('excludes near-certain and near-priced-in entries', () => {
    expect(isInformativeBet('other', 0.01, 30, INSIDER_DEFAULTS)).toBe(false); // ≤ extremeLo
    expect(isInformativeBet('other', 0.95, 30, INSIDER_DEFAULTS)).toBe(false); // > infoOddsHi
  });
  it('excludes live/last-minute wins (lead ≤ liveLeadDays)', () => {
    expect(isInformativeBet('crypto', 0.47, 0 /* same-day coin flip */, INSIDER_DEFAULTS)).toBe(false);
    expect(isInformativeBet('crypto', 0.47, 1, INSIDER_DEFAULTS)).toBe(false);
    expect(isInformativeBet('crypto', 0.47, 1.1, INSIDER_DEFAULTS)).toBe(true);
  });
});
