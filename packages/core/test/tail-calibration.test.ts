/**
 * Tests for core/sim/tail-calibration — the M1 calibration DIAGNOSIS (BADATMATH-GAP-PLAN.md Move 1).
 * Covers the frozen cheap-tail cut, the binding low-variance gap metric (won − EMOS_p), the tail Brier
 * deficit (M3), the entry-price deciles (M4), and the pre-registered branch-table verdict — including
 * the three decisive outcomes (Case A PASS, the combined KILL, the AMBIGUOUS middle) and the minN
 * guard. All pure — no network, no DB.
 */
import { describe, expect, it } from 'vitest';
import {
  TAIL_CALIB,
  type TailPick,
  m1TailCalibration,
  m3TailBrier,
  m4EntryDeciles,
  tailCalibrationVerdict,
} from '../src/sim/tail-calibration.ts';

function pick(over: Partial<TailPick> = {}): TailPick {
  return {
    entryPrice: 0.08,
    emosP: 0.05,
    marketP: 0.07,
    won: false,
    station: 'EHAM',
    citySlug: 'amsterdam',
    targetDate: '2026-06-22',
    ...over,
  };
}

/** Build n picks at a fixed emosP with `wins` of them resolving (deterministic — no RNG). */
function picks(n: number, wins: number, emosP: number, over: Partial<TailPick> = {}): TailPick[] {
  return Array.from({ length: n }, (_, i) => pick({ emosP, won: i < wins, ...over }));
}

describe('m1TailCalibration', () => {
  it('applies the frozen EMOS_p < 0.15 cheap-tail cut', () => {
    const sample = [...picks(40, 0, 0.05), ...picks(40, 40, 0.20)]; // the 0.20 picks are NOT tail
    const m1 = m1TailCalibration(sample);
    expect(m1.n).toBe(40); // only the EMOS_p<0.15 picks count
    expect(m1.empiricalFreq).toBe(0); // none of the tail picks won
  });

  it('pools (won − EMOS_p) as the binding gap: freq − meanEMOS', () => {
    const m1 = m1TailCalibration(picks(100, 12, 0.05)); // 12% hit vs 5% predicted → +7pp gap
    expect(m1.empiricalFreq).toBeCloseTo(0.12, 9);
    expect(m1.meanEmosP).toBeCloseTo(0.05, 9);
    expect(m1.gap).toBeCloseTo(0.07, 9);
    expect(m1.gapCiLo).toBeGreaterThan(0); // a clean positive band at this n
  });

  it('is total on an empty sample', () => {
    const m1 = m1TailCalibration([]);
    expect(m1.n).toBe(0);
    expect(Number.isNaN(m1.gap)).toBe(true);
  });
});

describe('m3TailBrier', () => {
  it('is negative when our EMOS is sharper than the market on the tail', () => {
    // a winner our model rated 0.10 vs the market's 0.02: ours closer to 1 → ours sharper → delta<0
    const m3 = m3TailBrier(picks(50, 50, 0.1, { marketP: 0.02 }));
    expect(m3.brierOurs).toBeLessThan(m3.brierMarket);
    expect(m3.delta).toBeLessThan(0);
  });

  it('drops picks without a market prob', () => {
    const m3 = m3TailBrier([...picks(30, 3, 0.05, { marketP: 0.06 }), ...picks(10, 0, 0.05, { marketP: null })]);
    expect(m3.n).toBe(30);
  });
});

describe('m4EntryDeciles', () => {
  it('bins by ascending entry price into equal-count bands with edge = hit − entry', () => {
    const sample = [
      ...picks(10, 8, 0.05, { entryPrice: 0.05 }), // cheap, hits a lot → +edge
      ...picks(10, 1, 0.05, { entryPrice: 0.20 }), // pricier, rarely hits → −edge
    ];
    const rows = m4EntryDeciles(sample, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.meanEntry).toBeLessThan(rows[1]!.meanEntry);
    expect(rows[0]!.edge).toBeGreaterThan(rows[1]!.edge);
    expect(rows[0]!.n + rows[1]!.n).toBe(20);
  });

  it('is total on an empty sample', () => {
    expect(m4EntryDeciles([])).toEqual([]);
  });
});

describe('tailCalibrationVerdict (frozen branch table)', () => {
  it('Case A — a clean ≥+3pp gap with lower-CI>0 routes to recalibration (Move 7)', () => {
    const m1 = m1TailCalibration(picks(400, 80, 0.05)); // 20% hit vs 5% → +15pp, tight CI
    const v = tailCalibrationVerdict(m1, { m2Failed: true });
    expect(v.case).toBe('A_FIXABLE_FORECAST');
    expect(v.m1Pass).toBe(true);
    expect(v.next).toMatch(/Move 7/);
  });

  it('combined KILL — gap < +1pp with M2 already FAIL ⇒ forecast is not the gap', () => {
    const m1 = m1TailCalibration(picks(400, 22, 0.05)); // 5.5% hit vs 5% → +0.5pp < 1pp
    const v = tailCalibrationVerdict(m1, { m2Failed: true });
    expect(v.case).toBe('KILL_NOT_THE_GAP');
    expect(v.m1Kill).toBe(true);
    expect(v.next).toMatch(/Move 10|running-max/);
  });

  it('AMBIGUOUS — a 1–3pp gap is not a clean pass', () => {
    const m1 = m1TailCalibration(picks(400, 28, 0.05)); // 7% hit vs 5% → +2pp
    const v = tailCalibrationVerdict(m1, { m2Failed: true });
    expect(v.case).toBe('AMBIGUOUS');
    expect(v.m1Pass).toBe(false);
    expect(v.m1Kill).toBe(false);
  });

  it('≥+3pp but with a CI that includes 0 is NOT a pass', () => {
    // 5 picks, 1 win at emosP 0.01 → gap ~+0.19 but tiny n → wide CI straddling 0 (and < minN anyway)
    const m1 = m1TailCalibration(picks(5, 1, 0.01));
    const v = tailCalibrationVerdict(m1, { m2Failed: true });
    expect(v.m1Pass).toBe(false);
  });

  it('INSUFFICIENT below minN', () => {
    const m1 = m1TailCalibration(picks(TAIL_CALIB.minN - 1, 10, 0.05));
    const v = tailCalibrationVerdict(m1, { m2Failed: true });
    expect(v.case).toBe('INSUFFICIENT');
  });

  it('the KILL arm is binding ONLY with M2 failed (the combined criterion)', () => {
    const m1 = m1TailCalibration(picks(400, 22, 0.05)); // +0.5pp
    const v = tailCalibrationVerdict(m1, { m2Failed: false });
    expect(v.case).not.toBe('KILL_NOT_THE_GAP'); // M2 not failed → kill does not fire
    expect(v.m1Kill).toBe(true); // the arm itself is still computed
  });
});
