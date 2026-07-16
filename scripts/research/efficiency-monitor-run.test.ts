import { describe, expect, it } from 'vitest';
import { reservedWindowWaitMs } from './efficiency-monitor-run.ts';

// The reserved :32–:42 UTC window guard must WAIT (bounded ≤ 11 min), never die: GitHub's scheduled-run
// drift landed the daily recorder inside the window on 07-15 and 07-16 and the old hard-throw cost both
// days' snapshots.
describe('reservedWindowWaitMs', () => {
  const at = (m: number, s = 0, ms = 0): Date => new Date(Date.UTC(2026, 6, 16, 8, m, s, ms));

  it('returns 0 outside the window', () => {
    expect(reservedWindowWaitMs(at(0))).toBe(0);
    expect(reservedWindowWaitMs(at(17))).toBe(0);
    expect(reservedWindowWaitMs(at(31, 59))).toBe(0);
    expect(reservedWindowWaitMs(at(43))).toBe(0);
    expect(reservedWindowWaitMs(at(59))).toBe(0);
  });

  it('waits to exactly :43:00 from the window start (the 11-minute worst case)', () => {
    expect(reservedWindowWaitMs(at(32))).toBe(11 * 60_000);
  });

  it('waits the remaining sub-minute tail at the window edge', () => {
    expect(reservedWindowWaitMs(at(42, 59, 500))).toBe(500);
  });

  it('covers the observed failure minutes (:35, :36 — the 07-15/07-16 drifted fires)', () => {
    expect(reservedWindowWaitMs(at(35))).toBe(8 * 60_000);
    expect(reservedWindowWaitMs(at(36, 19))).toBe(6 * 60_000 + 41_000);
  });

  it('never returns a negative wait inside the window', () => {
    for (let m = 32; m <= 42; m++) expect(reservedWindowWaitMs(at(m, 30))).toBeGreaterThan(0);
  });
});
