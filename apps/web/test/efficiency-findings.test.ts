/**
 * efficiency-findings — the curated, FROZEN record rendered by /efficiency. These tests pin the
 * record against silent drift: the proof table must stay internally consistent and faithful to the
 * headline counts (it is a typed mirror of FINDINGS.md; a row added/removed without updating the
 * headline would break the page's "measured N ways" claim).
 */
import { describe, expect, it } from 'vitest';
import {
  EFFICIENCY_HEADLINE,
  FINDINGS_ARCS,
  HARDENING_SWEEP,
  METHODOLOGY,
  type Verdict,
} from '../src/lib/efficiency-findings.ts';

const VALID_VERDICTS: Verdict[] = ['KILL', 'FAIL', 'AMBIGUOUS'];

describe('efficiency-findings record', () => {
  it('has three arcs in narrative order', () => {
    expect(FINDINGS_ARCS.map((a) => a.key)).toEqual(['forecasting', 'sharp-wallet', 'structural']);
  });

  it('every lever is fully specified with a valid verdict', () => {
    const levers = FINDINGS_ARCS.flatMap((a) => a.levers);
    expect(levers.length).toBeGreaterThan(0);
    for (const l of levers) {
      expect(l.id, 'id').toBeTruthy();
      expect(l.lever, `lever ${l.id}`).toBeTruthy();
      expect(l.question, `question ${l.id}`).toMatch(/\?$/); // questions end in a question mark
      expect(l.evidence, `evidence ${l.id}`).toBeTruthy();
      expect(l.wall, `wall ${l.id}`).toBeTruthy();
      expect(l.doc, `doc ${l.id}`).toBeTruthy();
      expect(VALID_VERDICTS, `verdict ${l.id}`).toContain(l.verdict);
    }
  });

  it('lever ids are unique', () => {
    const ids = FINDINGS_ARCS.flatMap((a) => a.levers.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('headline counts are internally consistent with the table', () => {
    const leverCount = FINDINGS_ARCS.reduce((n, a) => n + a.levers.length, 0);
    expect(EFFICIENCY_HEADLINE.leversFalsified).toBe(leverCount);
    // 10 distinct signals + the executable-depth hardening sweep = measured eleven ways
    expect(EFFICIENCY_HEADLINE.measuredWays).toBe(EFFICIENCY_HEADLINE.signalsFalsified + 1);
    expect(EFFICIENCY_HEADLINE.leversFalsified).toBeGreaterThanOrEqual(EFFICIENCY_HEADLINE.signalsFalsified);
  });

  it('the adverse-selection tax dwarfs the spread tax (the load-bearing "why it doesn’t transfer")', () => {
    expect(EFFICIENCY_HEADLINE.adverseSelTaxPp).toBeGreaterThan(EFFICIENCY_HEADLINE.spreadTaxPp);
    expect(EFFICIENCY_HEADLINE.sharpRealizedUsd).toBeGreaterThan(0);
    expect(EFFICIENCY_HEADLINE.forecastRmseLead1C).toBeGreaterThan(0);
  });

  it('the hardening sweep names four KILLed lanes', () => {
    expect(HARDENING_SWEEP.lanes).toHaveLength(4);
    expect(HARDENING_SWEEP.lanes.map((l) => l.lane)).toEqual(['B', 'D', 'C1', 'C2']);
    for (const l of HARDENING_SWEEP.lanes) {
      expect(l.title).toBeTruthy();
      expect(l.result).toBeTruthy();
    }
  });

  it('methodology points are present and specified', () => {
    expect(METHODOLOGY.length).toBeGreaterThanOrEqual(3);
    for (const m of METHODOLOGY) {
      expect(m.title).toBeTruthy();
      expect(m.body).toBeTruthy();
    }
  });
});
