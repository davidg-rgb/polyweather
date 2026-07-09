/**
 * Sanity tests for the committed per-city buy-table record (core/sim/city-buy-table-results) — the archive
 * backtest of "$10 on our predicted high, bought cheap (ask ≤ 0.15), held to close", rendered by /paper-trade.
 * Mirrors city-scan-results.test.ts's discipline: guard the frozen record's structural invariants + golden
 * values so a bad regenerate/hand-edit can't silently ship a number the source (scripts/research/city-buy-table.py
 * + MARKET-PNL.md) doesn't support — including that the VERDICT it renders is genuinely a net loss, the pooled
 * totals reconcile with the per-city rows, the rows are sorted best→worst, and the sweet-spot lead really is the
 * max-lower-bound entry.
 */
import { describe, expect, it } from 'vitest';
import { CITY_BUY_TABLE } from '../src/sim/city-buy-table-results.ts';

const B = CITY_BUY_TABLE;

describe('city-buy-table-results record', () => {
  describe('params', () => {
    it('golden strategy parameters (the operator spec)', () => {
      expect(B.params.stake).toBe(10);
      expect(B.params.cheapMax).toBe(0.15);
      expect(B.params.sweetLeadH).toBe(24);
      expect(B.params.forecastLead).toBe(1);
      expect(B.params.leadsH).toEqual([48, 24, 12, 6]);
      expect(B.params.leadsH).toContain(B.params.sweetLeadH);
    });
  });

  describe('lead curve (the "peak time" axis)', () => {
    it('covers exactly the configured leads, in far→near order', () => {
      expect(B.leadCurve.map((l) => l.leadH)).toEqual(B.params.leadsH);
    });

    it('is negative at EVERY entry lead — the falsified-signal signature', () => {
      for (const l of B.leadCurve) {
        expect(l.roiPct, `roi @${l.leadH}h`).toBeLessThan(0);
        expect(l.netUsd, `net @${l.leadH}h`).toBeLessThan(0);
      }
    });

    it('gets worse the closer to close you buy (6h is the worst)', () => {
      const worst = B.leadCurve.reduce((a, b) => (b.roiPct < a.roiPct ? b : a));
      expect(worst.leadH).toBe(6);
    });

    it('the sweet-spot lead is the max day-clustered lower bound (shrinkage, not point estimate)', () => {
      const best = B.leadCurve.reduce((a, b) => (b.ciPct[0] > a.ciPct[0] ? b : a));
      expect(best.leadH).toBe(B.params.sweetLeadH);
    });

    it('every CI is ordered (lo < hi) and contains the point estimate', () => {
      for (const l of B.leadCurve) {
        expect(l.ciPct[0]).toBeLessThan(l.ciPct[1]);
        expect(l.roiPct).toBeGreaterThanOrEqual(l.ciPct[0]);
        expect(l.roiPct).toBeLessThanOrEqual(l.ciPct[1]);
        expect(l.avgAsk).toBeGreaterThan(0);
        expect(l.avgAsk).toBeLessThan(1);
      }
    });

    it('ROI equals net/(bets × stake) at display precision, every lead', () => {
      for (const l of B.leadCurve) {
        const implied = (l.netUsd / (l.bets * B.params.stake)) * 100;
        expect(Math.abs(implied - l.roiPct), `roi consistency @${l.leadH}h`).toBeLessThanOrEqual(0.2);
      }
    });
  });

  describe('per-city rows', () => {
    it('has one row per city in the universe, all with an ICAO', () => {
      expect(B.rows).toHaveLength(B.universe.nCities);
      const slugs = B.rows.map((r) => r.city);
      expect(new Set(slugs).size).toBe(slugs.length); // unique
      for (const r of B.rows) {
        expect(r.icao, `${r.city} icao`).toMatch(/^[A-Z]{4}$/);
        expect(r.display.length).toBeGreaterThan(0);
      }
    });

    it('is sorted by net P&L descending (best → worst)', () => {
      for (let i = 1; i < B.rows.length; i++) {
        expect(B.rows[i]!.netUsd).toBeLessThanOrEqual(B.rows[i - 1]!.netUsd);
      }
    });

    it('every row is internally consistent (won+lost=bets, days≤bets, staked, ROI, winPct)', () => {
      for (const r of B.rows) {
        expect(r.won + r.lost, `${r.city} won+lost`).toBe(r.bets);
        expect(r.bets).toBeGreaterThan(0);
        expect(r.daysActive).toBeGreaterThan(0);
        expect(r.daysActive, `${r.city} days≤bets`).toBeLessThanOrEqual(r.bets);
        expect(r.staked, `${r.city} staked`).toBe(r.bets * B.params.stake);
        expect(Math.abs(r.winPct - (100 * r.won) / r.bets), `${r.city} winPct`).toBeLessThanOrEqual(0.1);
        const impliedRoi = (r.netUsd / (r.bets * B.params.stake)) * 100;
        expect(Math.abs(impliedRoi - r.roiPct), `${r.city} roi`).toBeLessThanOrEqual(0.2);
        // sign coherence: a positive net ⇒ positive ROI and ≥1 win
        if (r.netUsd > 0) expect(r.won).toBeGreaterThan(0);
        // Wilson CI ordered and within [0,100]
        expect(r.winCi[0]).toBeLessThanOrEqual(r.winCi[1]);
        expect(r.winCi[1]).toBeLessThanOrEqual(100);
        expect(r.avgAsk).toBeGreaterThan(0);
        expect(r.avgAsk).toBeLessThanOrEqual(B.params.cheapMax + 0.02); // cheap gate + spread headroom
      }
    });

    it('the per-city lead sparkline keys are a subset of the configured leads', () => {
      const allowed = new Set(B.params.leadsH.map(String));
      for (const r of B.rows) {
        for (const k of Object.keys(r.leadNet)) expect(allowed.has(k), `${r.city} lead ${k}`).toBe(true);
      }
    });
  });

  describe('pooled totals reconcile with the rows', () => {
    it('pooled bets/won = the row sums', () => {
      expect(B.rows.reduce((s, r) => s + r.bets, 0)).toBe(B.pooled.bets);
      expect(B.rows.reduce((s, r) => s + r.won, 0)).toBe(B.pooled.won);
    });

    it('pooled net ≈ Σ per-city net (within display rounding)', () => {
      const sum = B.rows.reduce((s, r) => s + r.netUsd, 0);
      expect(Math.abs(sum - B.pooled.netUsd)).toBeLessThan(5);
    });

    it('nCitiesPositive matches the count of net-positive rows', () => {
      const pos = B.rows.filter((r) => r.netUsd > 0).length;
      expect(pos).toBe(B.pooled.nCitiesPositive);
    });

    it('pooled ROI = net/(bets × stake), and win% matches', () => {
      const impliedRoi = (B.pooled.netUsd / (B.pooled.bets * B.params.stake)) * 100;
      expect(Math.abs(impliedRoi - B.pooled.roiPct)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(B.pooled.winPct - (100 * B.pooled.won) / B.pooled.bets)).toBeLessThanOrEqual(0.1);
    });
  });

  describe('the verdict it renders is a net loss (efficiency signature)', () => {
    it('pooled ROI is negative and the point estimate leans well below zero', () => {
      expect(B.pooled.roiPct).toBeLessThan(0);
      expect(B.pooled.netUsd).toBeLessThan(0);
    });

    it('win rate does not clear the breakeven the entry price demands', () => {
      const breakevenPct = B.pooled.avgAsk * 100;
      expect(B.pooled.winPct).toBeLessThan(breakevenPct + 1); // ~at/under breakeven → net loss after the spread
    });

    it('golden headline figures (2026-07-09 record)', () => {
      expect(B.pooled.roiPct).toBe(-28.2);
      expect(B.pooled.netUsd).toBe(-977);
      expect(B.pooled.bets).toBe(347);
      expect(B.pooled.nCitiesPositive).toBe(16);
      expect(B.universe.nCities).toBe(43);
      expect(B.universe.nCitiesTotal).toBeGreaterThanOrEqual(B.universe.nCities);
    });
  });
});
