/**
 * LineChart — the new generic two-series line chart (the Brier gap on /data). Pure, no-DOM render to a static
 * SVG string, asserting the degenerate-case branches the data-page fixture never exercises: the empty-state
 * guard (labels < 2 / all-null), a fully-null series drawing nothing, a mid-series null breaking the line, the
 * last-point label de-collision clamp, and the span-0 guard producing finite coordinates. Mirrors the
 * equity-chart.test.ts idiom (its structural twin).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LineChart, type LineSeries } from '../src/components/LineChart.tsx';

const render = (props: Parameters<typeof LineChart>[0]): string => renderToStaticMarkup(LineChart(props));

describe('LineChart', () => {
  it('renders the accessible empty-state when there are fewer than 2 labels', () => {
    const svg = render({ labels: ['2026-06-14'], series: [{ label: 'ours', color: '#f0b65e', values: [0.7] }], emptyHint: 'nope' });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="nope"');
    expect(svg).not.toContain('<path'); // no geometry drawn in the fallback
  });

  it('renders the empty-state when every series value is null (allY < 1)', () => {
    const svg = render({ labels: ['a', 'b', 'c'], series: [{ label: 'ours', color: '#f0b65e', values: [null, null, null] }] });
    expect(svg).not.toContain('<path');
  });

  it('a fully-null series draws no coordinates/dot/label while a populated one still renders', () => {
    const series: LineSeries[] = [
      { label: 'ours', color: '#f0b65e', dash: '5 3', values: [0.74, 0.8, 0.76] },
      { label: 'market', color: '#4cc2ff', values: [null, null, null] },
    ];
    const svg = render({ labels: ['d1', 'd2', 'd3'], series });
    // both series emit a <path> element (the EquityChart idiom), but only the populated one has coordinates,
    // a last-point dot, and a label — the null series contributes nothing visible.
    expect((svg.match(/<path d="M[^"]*"/g) ?? []).length).toBe(1); // exactly one path with real coordinates
    expect((svg.match(/<circle /g) ?? []).length).toBe(1); // one last-point dot, for the populated series only
    expect(svg).toContain('>ours</text>');
    expect(svg).not.toContain('>market</text>'); // null series has no last point → no label
  });

  it('a null in the middle of a series breaks the line (a second M in the path)', () => {
    const svg = render({ labels: ['d1', 'd2', 'd3', 'd4'], series: [{ label: 'ours', color: '#f0b65e', values: [0.7, null, 0.75, 0.72] }] });
    const path = (svg.match(/<path d="([^"]*)"/) ?? [])[1] ?? '';
    expect((path.match(/M/g) ?? []).length).toBe(2); // pen lifts at the null, restarts after
  });

  it('de-collides last-point labels to >= the 11px minimum gap, within the plot floor', () => {
    // identical last points over a wide range → their raw label Ys coincide and must be nudged apart.
    const series: LineSeries[] = [
      { label: 'ours', color: '#111111', values: [0.6, 0.9, 0.75] },
      { label: 'market', color: '#222222', values: [0.62, 0.88, 0.75] },
    ];
    const svg = render({ labels: ['d1', 'd2', 'd3'], series });
    const labelY = (lbl: string): number => {
      const m = svg.match(new RegExp(`<text[^>]*\\by="([\\d.]+)"[^>]*>${lbl}</text>`));
      expect(m, `label ${lbl} should render with a y`).not.toBeNull();
      return Number(m![1]);
    };
    const a = labelY('ours');
    const b = labelY('market');
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(11 - 1e-6);
    expect(Math.max(a, b)).toBeLessThanOrEqual(260 - 24); // height - padB
  });

  it('all-equal values (span 0) produce finite coordinates — no NaN', () => {
    const svg = render({ labels: ['d1', 'd2', 'd3'], series: [{ label: 'flat', color: '#f0b65e', values: [0.7, 0.7, 0.7] }] });
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('<path'); // a flat line still draws
  });
});
