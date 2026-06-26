/**
 * BarChart — a single-series vertical bar chart for the /whaletracker daily-notional view (server component,
 * inline SVG, no client JS, no chart lib — the same dependency-free idiom as EquityChart). Each datum is one
 * bar with a value label above and an optional small tag (e.g. the trade count) below the axis. The whole
 * series is one colour, so meaning never rides on colour alone: every bar is directly value-labelled (WCAG
 * `direct-labeling`/`color-not-only`), and the chart carries an aria-label summary for screen readers.
 */
import type { ReactElement } from 'react';

export interface BarDatum {
  /** x-axis label (e.g. 'MM-DD'). */
  label: string;
  /** bar height value (>= 0). */
  value: number;
  /** small caption under the axis (e.g. '3 bets'); optional. */
  tag?: string;
}

export function BarChart({
  data,
  width = 720,
  height = 240,
  color = 'var(--ams-secondary, var(--accent))',
  ariaLabel = 'bar chart',
  valueFmt = (v: number): string => String(v),
  emptyHint = 'no data in this window yet',
}: {
  data: BarDatum[];
  width?: number;
  height?: number;
  color?: string;
  ariaLabel?: string;
  valueFmt?: (v: number) => string;
  emptyHint?: string;
}): ReactElement {
  const maxV = Math.max(0, ...data.map((d) => (Number.isFinite(d.value) ? d.value : 0)));
  if (data.length === 0 || maxV <= 0) {
    return (
      <svg className="equity" width={width} height={height} role="img" aria-label={emptyHint}>
        <text x={12} y={height / 2} fill="var(--ams-muted, var(--muted))" fontSize={12}>
          {emptyHint}
        </text>
      </svg>
    );
  }

  const padL = 52;
  const padR = 12;
  const padT = 18; // room for the value label above the tallest bar
  const padB = 34; // room for the x-label + the tag line
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = data.length;

  // Comfortable bar width with a gap; cap so a 2-bar window doesn't render absurdly fat bars.
  const slot = plotW / n;
  const barW = Math.min(slot * 0.62, 84);
  const yAt = (v: number): number => padT + plotH * (1 - v / maxV);
  const xCenter = (i: number): number => padL + slot * (i + 0.5);
  const baseline = padT + plotH;

  // Only label every bar when they're not too dense; otherwise label the extremes + the max bar.
  const labelEvery = n <= 12 ? 1 : Math.ceil(n / 8);
  const maxIdx = data.reduce((m, d, i) => (d.value > data[m]!.value ? i : m), 0);

  const gridTicks = [0, 0.5, 1].map((f) => maxV * f);

  return (
    <svg
      className="equity"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      {/* y gridlines + value ticks */}
      {gridTicks.map((g, k) => (
        <g key={k}>
          <line
            x1={padL}
            x2={width - padR}
            y1={yAt(g)}
            y2={yAt(g)}
            stroke="var(--ams-grid, var(--border))"
            strokeWidth={1}
            strokeDasharray={g === 0 ? '0' : '3 3'}
          />
          <text x={padL - 6} y={yAt(g) + 3} textAnchor="end" fontSize={10} fill="var(--ams-muted, var(--muted))">
            {valueFmt(g)}
          </text>
        </g>
      ))}

      {/* bars */}
      {data.map((d, i) => {
        const v = Number.isFinite(d.value) ? Math.max(0, d.value) : 0;
        const x = xCenter(i) - barW / 2;
        const y = yAt(v);
        const h = Math.max(baseline - y, v > 0 ? 1.5 : 0);
        const showVal = i % labelEvery === 0 || i === maxIdx || i === n - 1;
        // x-axis label + tag share the value-label cadence: at high bar counts (e.g. the 44-bar /data skyline)
        // every-bar labels overrun their ~19px slot and collide into an unreadable smear. Sparse charts
        // (n <= 12 → labelEvery 1) are unaffected — showX is always true there.
        const showX = i % labelEvery === 0 || i === n - 1;
        return (
          <g key={`${d.label}-${i}`}>
            <rect x={x} y={y} width={barW} height={h} rx={3} fill={color} opacity={0.9}>
              <title>{`${d.label}: ${valueFmt(v)}${d.tag ? ` · ${d.tag}` : ''}`}</title>
            </rect>
            {showVal && v > 0 ? (
              <text
                x={xCenter(i)}
                y={y - 4}
                textAnchor="middle"
                fontSize={10}
                fontWeight={700}
                fill="var(--ams-text, var(--text))"
              >
                {valueFmt(v)}
              </text>
            ) : null}
            {/* x label (thinned at high density) */}
            {showX ? (
              <text x={xCenter(i)} y={baseline + 13} textAnchor="middle" fontSize={10} fill="var(--ams-muted, var(--muted))">
                {d.label}
              </text>
            ) : null}
            {/* tag (e.g. trade count) — thinned with the x label */}
            {showX && d.tag ? (
              <text x={xCenter(i)} y={baseline + 25} textAnchor="middle" fontSize={9} fill="var(--ams-muted, var(--muted))">
                {d.tag}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* baseline */}
      <line x1={padL} x2={width - padR} y1={baseline} y2={baseline} stroke="var(--ams-muted, var(--muted))" strokeWidth={1} />
    </svg>
  );
}
