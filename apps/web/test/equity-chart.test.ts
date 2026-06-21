/**
 * EquityChart (0046 a11y remediation) — renders the pure, no-hooks server component to a static SVG string
 * and asserts the accessibility geometry the multi-agent review added: a viewBox + preserveAspectRatio (so
 * the chart scales), theme-aware grid/label colours via CSS vars (not hard-coded, so it tracks light/dark),
 * one colour+dash-distinguished path per arm labelled at its last point (colour-blind safe), and the
 * vertical de-collision that keeps clustered last-point labels readable. renderToStaticMarkup needs no DOM —
 * the component takes data in and returns markup out.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EquityChart, type EquitySeries } from '../src/components/EquityChart.tsx';

const render = (props: Parameters<typeof EquityChart>[0]): string => renderToStaticMarkup(EquityChart(props));

describe('EquityChart [cov-7]', () => {
  it('renders the accessible empty-state fallback when there are fewer than 2 dates', () => {
    const svg = render({ dates: ['2026-06-10'], series: [{ label: '13:00', color: '#f5a623', values: [1] }] });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="not enough data yet"');
    expect(svg).toContain('not enough graded days yet');
    expect(svg).not.toContain('<path'); // no series geometry drawn in the fallback
  });

  it('renders a scalable, theme-aware SVG with one dash-distinguished path per arm', () => {
    const series: EquitySeries[] = [
      { label: '13:00', color: '#f5a623', values: [0, 5, 21] }, // no dash → solid
      { label: '14:00', color: '#4aa3df', dash: '6 4', values: [0, -2, -5] },
      { label: '15:00', color: '#9b59b6', dash: '2 4', values: [null, 1, -43] }, // null = no bet yet → line breaks
      { label: '16:00', color: '#f06ec0', dash: '8 3 2 3', values: [0, -8, -14] },
    ];
    const svg = render({ dates: ['2026-06-12', '2026-06-15', '2026-06-21'], series });

    // scalable
    expect(svg).toContain('viewBox="0 0 720 240"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    // accessible name (renderToStaticMarkup escapes the ampersand)
    expect(svg).toContain('aria-label="cumulative P&amp;L by betting hour, US dollars"');
    // theme-aware grid + label colours via CSS custom properties with fallbacks (not hard-coded hexes)
    expect(svg).toContain('var(--ams-grid, var(--border))');
    expect(svg).toContain('var(--ams-muted, var(--muted))');
    // exactly one series path per arm, each carrying its own colour + dash style
    expect((svg.match(/<path /g) ?? []).length).toBe(series.length);
    expect(svg).toContain('stroke="#4aa3df"');
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('stroke-dasharray="8 3 2 3"');
    // each arm labelled at its last point → identifiable without the legend
    for (const s of series) expect(svg).toContain(`>${s.label}</text>`);
  });

  it('de-collides clustered last-point labels so they stay >= the 11px minimum gap apart', () => {
    // Three arms whose final cum values sit within ~2px of each other (the efficient-market-null clump the
    // remediation targeted). Their raw label Ys would overlap; the component nudges each down to keep gaps.
    const series: EquitySeries[] = [
      { label: 'A', color: '#111111', values: [0, 20.0] },
      { label: 'B', color: '#222222', values: [0, 20.1] },
      { label: 'C', color: '#333333', values: [0, 19.9] },
    ];
    const svg = render({ dates: ['2026-06-20', '2026-06-21'], series });

    const labelY = (lbl: string): number => {
      const m = svg.match(new RegExp(`<text[^>]*\\by="([\\d.]+)"[^>]*>${lbl}</text>`));
      expect(m, `label ${lbl} should render with a y`).not.toBeNull();
      return Number(m![1]);
    };
    const ys = [labelY('A'), labelY('B'), labelY('C')].sort((a, b) => a - b);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(11 - 1e-6);
    expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(11 - 1e-6);
  });
});
