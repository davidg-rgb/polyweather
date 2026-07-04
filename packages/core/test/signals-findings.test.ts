/**
 * Golden-value tests for the committed signals-findings record (core/sim/signals-findings) — the FINDINGS.md
 * mirror that the /signals flagship renders. Mirrors city-scan-results.test.ts's discipline: guard the frozen
 * record's structural invariants AND the load-bearing figures verbatim, so a bad hand-edit can't silently ship
 * a number FINDINGS.md doesn't support. Every asserted figure below is copied from FINDINGS.md, never
 * recomputed — if FINDINGS.md changes, these must be updated in lockstep.
 */
import { describe, expect, it } from 'vitest';
import {
  BADATMATH_REPLICA,
  HARDENING_SWEEP,
  MECHANISM_CLASS_META,
  type MechanismClass,
  OPENING_CONVERGENCE_SIGNAL,
  SIGNAL_ARCS,
  SIGNAL_BACKLOG_KILLS,
  SIGNAL_HERO,
  type SignalRow,
  type SignalVerdict,
  TWELVE_WAYS,
} from '../src/sim/signals-findings.ts';

const VALID_VERDICTS: SignalVerdict[] = ['KILL', 'FAIL', 'AMBIGUOUS', 'NO-GO', 'INSUFFICIENT_DATA', 'UNDER_TEST'];
const VALID_CLASSES: MechanismClass[] = [
  'point-skill-ceiling',
  'market-sharper',
  'latency',
  'adverse-selection',
  'fee-fill-wall',
  'survivorship',
  'structural',
];

const allArcRows = (): SignalRow[] => SIGNAL_ARCS.flatMap((a) => a.rows);
const allRows = (): SignalRow[] => [...allArcRows(), OPENING_CONVERGENCE_SIGNAL];
const rowById = (id: string): SignalRow => allRows().find((r) => r.id === id)!;

describe('signals-findings record', () => {
  describe('SIGNAL_ARCS structure', () => {
    it('has the three FINDINGS.md arcs in order', () => {
      expect(SIGNAL_ARCS.map((a) => a.key)).toEqual(['forecasting', 'sharp-wallet', 'structural']);
    });

    it('every row is well-formed: unique id, non-empty lever/question/keyNumber/wall/doc', () => {
      const rows = allRows();
      const ids = rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of rows) {
        expect(r.id.length, `${r.id} id`).toBeGreaterThan(0);
        expect(r.lever.length, `${r.id} lever`).toBeGreaterThan(0);
        expect(r.question.length, `${r.id} question`).toBeGreaterThan(0);
        expect(r.keyNumber.length, `${r.id} keyNumber`).toBeGreaterThan(10);
        expect(r.wall.length, `${r.id} wall`).toBeGreaterThan(0);
        expect(r.doc.length, `${r.id} doc`).toBeGreaterThan(0);
      }
    });

    it('every verdict and mechanism class is a valid taxonomy member', () => {
      for (const r of allRows()) {
        expect(VALID_VERDICTS, `${r.id} verdict`).toContain(r.verdict);
        expect(VALID_CLASSES, `${r.id} mechClass`).toContain(r.mechClass);
      }
    });

    it('exactly one row is flagged live — the 12th signal (opening convergence)', () => {
      const live = allRows().filter((r) => r.live);
      expect(live).toHaveLength(1);
      expect(live[0]!.id).toBe('opening-convergence');
      expect(live[0]!.id).toBe(SIGNAL_HERO.liveSignalId);
      expect(live[0]!.verdict).toBe('UNDER_TEST');
    });

    it('every mechanism class has display metadata with a valid tone', () => {
      for (const c of VALID_CLASSES) {
        expect(MECHANISM_CLASS_META[c].label.length).toBeGreaterThan(0);
        expect(['red', 'amber', 'sky']).toContain(MECHANISM_CLASS_META[c].tone);
      }
    });
  });

  describe('golden values — Arc 1 (forecasting)', () => {
    it('NWP blend — 1.33°C lead-1 RMSE, icon_seamless 1.46°C, the four lever deltas', () => {
      const r = rowById('nwp-blend');
      expect(r.verdict).toBe('KILL');
      expect(r.mechClass).toBe('point-skill-ceiling');
      expect(r.keyNumber).toContain('1.33°C lead-1 RMSE');
      expect(r.keyNumber).toContain('icon_seamless 1.46°C');
      expect(r.keyNumber).toContain('−3.32%');
      expect(r.keyNumber).toContain('−0.01%');
      expect(r.keyNumber).toContain('R² 0.60%');
      expect(r.keyNumber).toContain('−0.05%');
    });

    it('intraday nowcast — h15 market 0.40 ≈ oracle 0.43 vs nowcast 0.65', () => {
      const r = rowById('intraday-nowcast');
      expect(r.keyNumber).toContain('0.40');
      expect(r.keyNumber).toContain('0.43');
      expect(r.keyNumber).toContain('0.65');
      expect(r.doc).toBe('FORECASTING-RD WO-4');
    });

    it('dead-bucket latency — dead mass median 0.0000, 1.39% clear the fee, no decay', () => {
      const r = rowById('deadmass-latency');
      expect(r.keyNumber).toContain('0.0000');
      expect(r.keyNumber).toContain('1.39%');
      expect(r.mechClass).toBe('latency');
      expect(r.doc).toBe('FORECASTING-RD WO-5');
    });
  });

  describe('golden values — Arc 2 (sharp wallet)', () => {
    it('day-before — +0.46pp, CI [−0.92, +1.83], 0/44 stations, Brier 0.740/0.756 vs 0.715', () => {
      const r = rowById('day-before');
      expect(r.verdict).toBe('FAIL');
      expect(r.keyNumber).toContain('+0.46pp');
      expect(r.keyNumber).toContain('CI [−0.92, +1.83]');
      expect(r.keyNumber).toContain('0/44 stations');
      expect(r.keyNumber).toContain('0.740/0.756');
      expect(r.keyNumber).toContain('0.715');
    });

    it('copy-trade — taker-follower −6.05pp vs the sharp’s +1.34pp', () => {
      const r = rowById('copy-trade');
      expect(r.keyNumber).toContain('−6.05pp');
      expect(r.keyNumber).toContain('+1.34pp');
      expect(r.mechClass).toBe('adverse-selection');
    });

    it('maker-spray — −1.46pp CI [−2.51, −0.41] (all) / −1.73pp CI [−3.16, −0.30] (forecast)', () => {
      const r = rowById('maker-spray');
      expect(r.keyNumber).toContain('−1.46pp CI [−2.51, −0.41]');
      expect(r.keyNumber).toContain('−1.73pp CI [−3.16, −0.30]');
      expect(r.doc).toBe('WALLET-RECON §12');
    });

    it('sharp-as-forecaster — −1.74pp / −1.20pp, zero-skill P(PASS) = 0.0%', () => {
      const r = rowById('sharp-as-forecaster');
      expect(r.keyNumber).toContain('−1.74pp / −1.20pp');
      expect(r.keyNumber).toContain('P(PASS) = 0.0%');
    });

    it('selector-learn (REC-1) — in-sample +10.6pp → OOS −5.7pp, 4 independent weather-days', () => {
      const r = rowById('selector-learn');
      expect(r.verdict).toBe('INSUFFICIENT_DATA');
      expect(r.keyNumber).toContain('+10.6pp');
      expect(r.keyNumber).toContain('−5.7pp');
      expect(r.keyNumber).toContain('4 independent weather-days');
    });

    it('tail-calibration (M1, §13) — gap +2.37pp / +2.76pp below the +3pp bar, AMBIGUOUS', () => {
      const r = rowById('tail-calibration');
      expect(r.verdict).toBe('AMBIGUOUS');
      expect(r.keyNumber).toContain('+2.37pp / +2.76pp');
      expect(r.keyNumber).toContain('+3pp bar');
    });
  });

  describe('golden values — structural / forecast-free signals', () => {
    it('reward farming (REC-10) — −47%/day ≈ 8× the ~6%/day reward → net −41%/day', () => {
      const r = rowById('reward-farming');
      expect(r.keyNumber).toContain('−47%/day');
      expect(r.keyNumber).toContain('~6%/day');
      expect(r.keyNumber).toContain('−41%/day');
    });

    it('complete-set (8th signal) — Σask<1 4.0% / Σbid>1 11.8%, 0.37%/0.06% clear, live 0/107, depth ≥ 25', () => {
      const r = rowById('complete-set');
      expect(r.signalLabel).toBe('8th signal');
      expect(r.mechClass).toBe('fee-fill-wall');
      expect(r.keyNumber).toContain('Σask<1 4.0%');
      expect(r.keyNumber).toContain('Σbid>1 11.8%');
      expect(r.keyNumber).toContain('0.37% / 0.06%');
      expect(r.keyNumber).toContain('live 0/107');
      expect(r.keyNumber).toContain('depth ≥ 25');
    });

    it('sports-sharps (9th signal) — fishalive $9M is ONE pre-match bet (n=1), reconciles at 0.74%', () => {
      const r = rowById('sports-sharps');
      expect(r.signalLabel).toBe('9th signal');
      expect(r.mechClass).toBe('survivorship');
      expect(r.keyNumber).toContain('$9M');
      expect(r.keyNumber).toContain('n=1');
      expect(r.keyNumber).toContain('0.74%');
    });

    it('cross-venue (10th signal) — 6 of 7 city-days, 1–10 contracts of true touch depth, winFrac 0', () => {
      const r = rowById('cross-venue');
      expect(r.signalLabel).toBe('10th signal');
      expect(r.mechClass).toBe('fee-fill-wall');
      expect(r.keyNumber).toContain('6 of 7 city-days');
      expect(r.keyNumber).toContain('1–10 contracts');
      expect(r.keyNumber).toContain('winFrac over executable wins = 0');
    });

    it('whale-insider — no signature at $100k or $25k ($3.0B / 43k fills)', () => {
      const r = rowById('whale-insider');
      expect(r.keyNumber).toContain('$100k or $25k');
      expect(r.keyNumber).toContain('$3.0B / 43k fills');
      expect(r.mechClass).toBe('structural');
    });
  });

  describe('BADATMATH_REPLICA (the concrete confirmation)', () => {
    it('three curves with the golden ROIs and n=180 seed', () => {
      expect(BADATMATH_REPLICA.nSeed).toBe(180);
      const byKey = Object.fromEntries(BADATMATH_REPLICA.curves.map((c) => [c.key, c]));
      expect(byKey['maker-ideal']!.roiPct).toBe(19.3);
      expect(byKey['maker-realistic']!.roiPct).toBe(-13.4);
      expect(byKey['taker']!.roiPct).toBe(3.9);
      expect(byKey['maker-ideal']!.ci).toEqual([-16, 55]);
      expect(byKey['maker-realistic']!.ci).toEqual([-47, 21]);
      expect(byKey['taker']!.ci).toEqual([-27, 35]);
    });

    it('the two taxes — spread 15.4pp, adverse-selection 32.8pp (which dwarfs it)', () => {
      expect(BADATMATH_REPLICA.spreadTaxPp).toBe(15.4);
      expect(BADATMATH_REPLICA.adverseSelTaxPp).toBe(32.8);
      expect(BADATMATH_REPLICA.adverseSelTaxPp).toBeGreaterThan(BADATMATH_REPLICA.spreadTaxPp);
      // the taxes match the frozen headline figures
      expect(BADATMATH_REPLICA.spreadTaxPp).toBe(SIGNAL_HERO.spreadTaxPp);
      expect(BADATMATH_REPLICA.adverseSelTaxPp).toBe(SIGNAL_HERO.adverseSelTaxPp);
    });
  });

  describe('HARDENING_SWEEP (the eleventh way)', () => {
    it('is dated 2026-06-26 and has all four lanes B / D / C1 / C2', () => {
      expect(HARDENING_SWEEP.date).toBe('2026-06-26');
      expect(HARDENING_SWEEP.lanes.map((l) => l.lane)).toEqual(['B', 'D', 'C1', 'C2']);
    });

    it('golden lane figures', () => {
      const byLane = Object.fromEntries(HARDENING_SWEEP.lanes.map((l) => [l.lane, l]));
      expect(byLane['B']!.result).toContain('0/16 ladders');
      expect(byLane['B']!.result).toContain('1.3¢/set');
      expect(byLane['D']!.result).toContain('0 of 5 fee-cleared');
      expect(byLane['D']!.result).toContain('$0.0474');
      expect(byLane['C1']!.result).toContain('120s-window artifact');
      expect(byLane['C2']!.result).toContain('<1s');
      expect(byLane['C2']!.result).toContain('300–1800s');
    });
  });

  describe('OPENING_CONVERGENCE_SIGNAL (the live 12th signal)', () => {
    it('carries the frozen static context verbatim — NO-GO 0/325 + the marginal backtest PASS', () => {
      const r = OPENING_CONVERGENCE_SIGNAL;
      expect(r.signalLabel).toBe('12th signal');
      expect(r.live).toBe(true);
      expect(r.keyNumber).toContain('Phase-0.5 spike NO-GO 0/325');
      expect(r.keyNumber).toContain('Wilson CI [0%, 1%]');
      expect(r.keyNumber).toContain('+6.9% / +$534');
      expect(r.keyNumber).toContain('CI [+0.4%, +12.1%]');
      expect(r.keyNumber).toContain('forward paper loop is the gate of record');
    });
  });

  describe('SIGNAL_BACKLOG_KILLS (the 2026-07-03 sweep)', () => {
    it('has all eleven pre-registered backlog items, each valid', () => {
      expect(SIGNAL_BACKLOG_KILLS).toHaveLength(11);
      const items = SIGNAL_BACKLOG_KILLS.map((b) => b.item);
      expect(new Set(items).size).toBe(items.length);
      for (const b of SIGNAL_BACKLOG_KILLS) {
        expect(VALID_VERDICTS).toContain(b.verdict);
        expect(b.keyNumber.length).toBeGreaterThan(10);
        expect(b.doc).toContain('SIGNAL-BACKLOG.md');
      }
    });

    it('golden values on the load-bearing backlog rows', () => {
      const byItem = Object.fromEntries(SIGNAL_BACKLOG_KILLS.map((b) => [b.item, b]));
      expect(byItem['#9']!.keyNumber).toContain('$34k/24h');
      expect(byItem['#9']!.keyNumber).toContain('$802/24h');
      expect(byItem['#11']!.keyNumber).toContain('0.0159°C');
      expect(byItem['#11']!.keyNumber).toContain('[−0.0280, −0.0051]');
      expect(byItem['#6']!.keyNumber).toContain('+0.80pp');
      expect(byItem['#6']!.keyNumber).toContain('[−1.74, +3.34]');
      expect(byItem['#4']!.keyNumber).toContain('−1.73pp');
      expect(byItem['#4']!.keyNumber).toContain('[−2.77, −0.69]');
      expect(byItem['#12']!.keyNumber).toContain('ankara/14h + houston/14h');
      expect(byItem['#12']!.keyNumber).toContain('−11.4pp @14h → −101.9pp @19h');
    });
  });

  describe('TWELVE_WAYS + SIGNAL_HERO', () => {
    it('the market measured efficient exactly twelve ways, numbered 1..12', () => {
      expect(TWELVE_WAYS).toHaveLength(12);
      expect(TWELVE_WAYS.map((w) => w.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(SIGNAL_HERO.measuredWays).toBe(TWELVE_WAYS.length);
    });

    it('the 12th way is the opening-convergence flat-open Phase-0.5 NO-GO (0/325)', () => {
      const twelfth = TWELVE_WAYS[11]!;
      expect(twelfth.verdict).toBe('NO-GO');
      expect(twelfth.way).toContain('flat-open');
      expect(twelfth.way).toContain('0/325');
    });

    it('the 11th way is the executable-depth hardening sweep', () => {
      expect(TWELVE_WAYS[10]!.way).toContain('hardening sweep');
    });

    it('headline golden figures — 10 signals, RMSE 1.33°C, sharp $25,407, taxes 15.4 / 32.8', () => {
      expect(SIGNAL_HERO.signalsFalsified).toBe(10);
      expect(SIGNAL_HERO.forecastRmseLead1C).toBe(1.33);
      expect(SIGNAL_HERO.bestSingleModel).toBe('icon_seamless 1.46°C');
      expect(SIGNAL_HERO.sharpRealizedUsd).toBe(25407);
      expect(SIGNAL_HERO.spreadTaxPp).toBe(15.4);
      expect(SIGNAL_HERO.adverseSelTaxPp).toBe(32.8);
      expect(SIGNAL_HERO.sourceDoc).toBe('FINDINGS.md');
    });

    it('totalRows reconciles with the actual arc-row count + the live signal', () => {
      const actual = SIGNAL_ARCS.reduce((s, a) => s + a.rows.length, 0) + 1;
      expect(SIGNAL_HERO.totalRows).toBe(actual);
      // the flagship carries every arc row plus the live 12th
      expect(allRows()).toHaveLength(actual);
    });

    it('at least the ten canonical orthogonal signals are represented as arc rows', () => {
      // sanity: the 8th/9th/10th/12th doc-numbered signals are all present + labelled
      const labelled = allRows().filter((r) => r.signalLabel && /\dth signal/.test(r.signalLabel));
      expect(labelled.map((r) => r.signalLabel).sort()).toEqual(['10th signal', '12th signal', '8th signal', '9th signal']);
    });
  });
});
