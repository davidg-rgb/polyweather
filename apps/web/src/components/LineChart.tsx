/**
 * LineChart — a generic multi-series line chart (server component, inline SVG, no client JS, no chart lib —
 * the same dependency-free idiom as EquityChart/BarChart). Unlike EquityChart (which is P&L-specific and pins
 * the y-axis through $0), this scales y to the data's own [min,max] with a little padding, so two close series
 * (e.g. two Brier curves ~0.70 vs ~0.75) show their GAP rather than hugging a shared baseline. Each series is
 * distinguished by colour AND dash pattern and labelled at its last point (WCAG colour-not-only). nulls break
 * the line (a series that starts late). The y-formatter + axis label are injectable.
 */
import type { ReactElement } from 'react';

export interface LineSeries {
  label: string;
  color: string;
  /** SVG stroke-dasharray — distinguishes series by LINE STYLE as well as colour. */
  dash?: string;
  /** Aligned to `labels`; null = no point for this series at that x (line breaks). */
  values: (number | null)[];
}

export function LineChart({
  labels,
  series,
  width = 720,
  height = 260,
  yFmt = (v: number): string => v.toFixed(2),
  yLabel = '',
  ariaLabel = 'line chart',
  emptyHint = 'not enough data yet',
}: {
  labels: string[];
  series: LineSeries[];
  width?: number;
  height?: number;
  yFmt?: (v: number) => string;
  yLabel?: string;
  ariaLabel?: string;
  emptyHint?: string;
}): ReactElement {
  const allY = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (labels.length < 2 || allY.length < 1) {
    return (
      <svg className="equity" width={width} height={height} role="img" aria-label={emptyHint}>
        <text x={12} y={height / 2} fill="var(--ams-muted, var(--muted))" fontSize={12}>
          {emptyHint}
        </text>
      </svg>
    );
  }

  const padL = 52;
  const padR = 64; // room for the per-line last-point labels
  const padT = 14;
  const padB = 24;
  const rawMin = Math.min(...allY);
  const rawMax = Math.max(...allY);
  const span = rawMax - rawMin || 1;
  const minY = rawMin - span * 0.08;
  const maxY = rawMax + span * 0.08;
  const spanY = maxY - minY || 1;
  const n = labels.length;

  const xAt = (i: number): number => padL + (i * (width - padL - padR)) / Math.max(1, n - 1);
  const yAt = (v: number): number => padT + (height - padT - padB) * (1 - (v - minY) / spanY);

  const pathFor = (vals: (number | null)[]): string => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const lastPoint = (vals: (number | null)[]): { x: number; y: number } | null => {
    for (let i = vals.length - 1; i >= 0; i--) {
      const v = vals[i];
      if (v !== null && v !== undefined && Number.isFinite(v)) return { x: xAt(i), y: yAt(v) };
    }
    return null;
  };

  const gridTicks = [minY, (minY + maxY) / 2, maxY];

  // Vertical de-collision for the last-point labels (two close series would overlap unreadably).
  const minGap = 11;
  const placements = new Map<string, { x: number; dotY: number; labelY: number }>();
  const ordered = series
    .map((s) => ({ label: s.label, lp: lastPoint(s.values) }))
    .filter((p): p is { label: string; lp: { x: number; y: number } } => p.lp !== null)
    .sort((a, b) => a.lp.y - b.lp.y);
  let prevY = -Infinity;
  for (const p of ordered) {
    const labelY = Math.min(Math.max(p.lp.y, prevY + minGap), height - padB);
    placements.set(p.label, { x: p.lp.x, dotY: p.lp.y, labelY });
    prevY = labelY;
  }

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
      {/* y gridlines + ticks */}
      {gridTicks.map((g, k) => (
        <g key={k}>
          <line
            x1={padL}
            x2={width - padR}
            y1={yAt(g)}
            y2={yAt(g)}
            stroke="var(--ams-grid, var(--border))"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text x={padL - 6} y={yAt(g) + 3} textAnchor="end" fontSize={10} fill="var(--ams-muted, var(--muted))">
            {yFmt(g)}
          </text>
        </g>
      ))}
      {yLabel ? (
        <text x={padL - 6} y={padT - 3} textAnchor="end" fontSize={9} fill="var(--ams-muted, var(--muted))">
          {yLabel}
        </text>
      ) : null}

      {/* series — colour AND dash, each labelled at its last point */}
      {series.map((s) => {
        const place = placements.get(s.label);
        return (
          <g key={s.label}>
            <path d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={1.8} strokeDasharray={s.dash} />
            {place ? (
              <>
                <circle cx={place.x} cy={place.dotY} r={2.6} fill={s.color} />
                <text x={place.x + 5} y={place.labelY + 3} fontSize={9} fontWeight={700} fill={s.color}>
                  {s.label}
                </text>
              </>
            ) : null}
          </g>
        );
      })}

      {/* x labels: first + last */}
      <text x={padL} y={height - 5} fontSize={10} fill="var(--ams-muted, var(--muted))">
        {labels[0]?.slice(5)}
      </text>
      <text x={width - padR} y={height - 5} textAnchor="end" fontSize={10} fill="var(--ams-muted, var(--muted))">
        {labels[n - 1]?.slice(5)}
      </text>
    </svg>
  );
}
