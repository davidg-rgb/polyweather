/**
 * BarChart label-density — at high bar counts (the 44-bar /data skyline) the x-axis label + tag must thin to
 * the same `labelEvery` cadence as the value labels, or they smear into an unreadable overlap. Sparse charts
 * (n <= 12 → labelEvery 1) must stay fully labelled and unchanged. Each label appears once in the bar's
 * `<title>` tooltip regardless; an axis label adds a SECOND occurrence — so a thinned label occurs once, a
 * shown label twice.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart } from '../src/components/BarChart.tsx';

const occ = (h: string, s: string): number => h.split(s).length - 1;
const mk = (i: number): string => `mk${String(i).padStart(2, '0')}`;
const series = (n: number) => Array.from({ length: n }, (_, i) => ({ label: mk(i), value: i + 1, tag: `t${String(i).padStart(2, '0')}` }));

describe('BarChart x-axis label density', () => {
  it('sparse (n=8) labels every bar (labelEvery=1) — unchanged from the original sparse use', () => {
    const html = renderToStaticMarkup(BarChart({ data: series(8) }));
    // every bar shows its axis label → label appears in <title> AND as an axis <text> = 2 occurrences.
    expect(occ(html, 'mk01')).toBe(2);
    expect(occ(html, 'mk07')).toBe(2);
  });

  it('dense (n=30) thins axis labels to the labelEvery cadence (ceil(30/8)=4) + the last bar', () => {
    const html = renderToStaticMarkup(BarChart({ data: series(30), width: 920 }));
    // mk00 is on-cadence (0 % 4 === 0) → shown: title + axis = 2.
    expect(occ(html, 'mk00')).toBe(2);
    // mk01 is off-cadence (1 % 4 !== 0, not last, not max) → thinned: title only = 1.
    expect(occ(html, 'mk01')).toBe(1);
    expect(occ(html, 'mk13')).toBe(1); // 13 % 4 !== 0 → thinned
    // the last bar is always labelled (i === n-1).
    expect(occ(html, 'mk29')).toBe(2);
    // the tag of a thinned bar is suppressed too (no second 't01' beyond the title's interpolation).
    expect(html).not.toContain('>t01<');
    // an on-cadence tag still renders.
    expect(html).toContain('>t00<');
  });
});
