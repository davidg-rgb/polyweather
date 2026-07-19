/**
 * Sanity tests for the committed per-city buy-table record (core/sim/city-buy-table-results) — the archive
 * backtest of "$10 on our predicted high, bought cheap (ask ≤ 0.15), held to close", rendered by /paper-trade.
 * Mirrors city-scan-results.test.ts's discipline: guard the frozen record's structural invariants + golden
 * values so a bad regenerate/hand-edit can't silently ship a number the source (scripts/research/city-buy-table.py
 * + MARKET-PNL.md) doesn't support — including that the VERDICT it renders genuinely demonstrates NO edge
 * (an underpowered wash: every day-clustered lower bound deep below zero), the pooled totals reconcile with
 * the per-city rows, the rows are sorted best→worst, and the sweet-spot lead really is the max-lower-bound entry.
 */
import { describe, expect, it } from 'vitest';
import { CITY_BUY_TABLE } from '../src/sim/city-buy-table-results.ts';

const B = CITY_BUY_TABLE;

describe('city-buy-table-results record', () => {
  describe('params', () => {
    it('golden strategy parameters (the operator spec + the canonical cost basis)', () => {
      expect(B.params.stake).toBe(10);
      expect(B.params.cheapMax).toBe(0.15);
      expect(B.params.book).toBe('calibrated'); // the CANONICAL CALIBRATED_BOOK cost basis (cost_model.py)
      expect(B.params.sweetLeadH).toBe(48);
      expect(B.params.forecastLead).toBe(1);
      expect(B.params.leadsH).toEqual([48, 24, 12, 6]);
      expect(B.params.leadsH).toContain(B.params.sweetLeadH);
    });
  });

  describe('lead curve (the "peak time" axis)', () => {
    it('covers exactly the configured leads, in far→near order', () => {
      expect(B.leadCurve.map((l) => l.leadH)).toEqual(B.params.leadsH);
    });

    it('NO lead demonstrates an edge: every day-clustered lower bound sits (deep) below zero', () => {
      for (const l of B.leadCurve) {
        expect(l.ciPct[0], `day-CI lower bound @${l.leadH}h`).toBeLessThan(0);
      }
    });

    it('every well-populated lead (bets ≥ 10) is an underpowered WASH: lower bound tens of points below zero', () => {
      // 2026-07-19 °F-band parser fix: ~27 previously mis-mapped °F picks joined the population and the
      // 48h point estimate drifted (just) positive — the invariant that matters is unchanged: no lead's
      // day-clustered lower bound comes anywhere NEAR zero, so nothing here demonstrates an edge.
      const populated = B.leadCurve.filter((l) => l.bets >= 10);
      expect(populated.length).toBeGreaterThanOrEqual(3); // the record must carry real leads, not only flukes
      for (const l of populated) {
        expect(l.ciPct[0], `day-CI lower bound @${l.leadH}h`).toBeLessThan(-20);
        expect(Math.abs(l.roiPct), `wash-sized point estimate @${l.leadH}h`).toBeLessThan(25);
      }
    });

    it('the fillable-and-cheap population COLLAPSES near close (the calibrated-book efficiency signature)', () => {
      // by resolution the winner has converged above the cheap gate and what is left is too thin to fill:
      // the nearest lead must carry a small fraction of the farthest lead's bets.
      const near = B.leadCurve.find((l) => l.leadH === 6)!;
      const far = B.leadCurve.find((l) => l.leadH === 48)!;
      expect(near.bets).toBeLessThan(far.bets * 0.2);
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
        // netUsd is rounded to whole dollars in the record, so the ROI tolerance scales with 1/bets
        // (at n=3 a $0.50 rounding is ±1.7pp of ROI; at n≥50 it is negligible).
        const tol = Math.max(0.2, (0.5 / (l.bets * B.params.stake)) * 100 + 0.15);
        expect(Math.abs(implied - l.roiPct), `roi consistency @${l.leadH}h`).toBeLessThanOrEqual(tol);
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

  describe('the verdict it renders demonstrates NO edge (efficiency signature)', () => {
    it('the pooled sweet-spot read is a wash whose day-clustered lower bound sits deep below zero', () => {
      const sweet = B.leadCurve.find((l) => l.leadH === B.params.sweetLeadH)!;
      expect(sweet.ciPct[0]).toBeLessThan(-20); // nothing NEAR a demonstrated edge
      expect(Math.abs(B.pooled.roiPct)).toBeLessThan(25); // wash-sized point estimate, not a real return
    });

    it('win rate does not clear the breakeven the entry price demands', () => {
      const breakevenPct = B.pooled.avgAsk * 100;
      expect(B.pooled.winPct).toBeLessThan(breakevenPct + 1); // ~at/under breakeven → a wash after the spread
    });

    it('golden headline figures (2026-07-19 record: calibrated book + taker fee + the °F band-parse fix)', () => {
      // The legacy mid+1c record read −28.2%/−$977 on 347 bets; the calibrated book (2026-07-09) collapsed
      // that to a 55-bet negative-leaning wash (−9.2%). The 2026-07-19 °F 2-degree-band parser fix restored
      // ~27 mis-mapped °F picks → 82 bets and a +2.4% point estimate with day-CI [−52.3, +60.5] — STILL an
      // underpowered wash, still no demonstrated edge: signal #12 stays dead in every version of the record.
      expect(B.pooled.roiPct).toBe(2.4);
      expect(B.pooled.netUsd).toBe(20);
      expect(B.pooled.bets).toBe(82);
      expect(B.pooled.nCitiesPositive).toBe(10);
      expect(B.universe.nCities).toBe(36);
      expect(B.universe.nCitiesTotal).toBeGreaterThanOrEqual(B.universe.nCities);
    });
  });
});
