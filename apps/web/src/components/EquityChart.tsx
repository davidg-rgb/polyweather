/**
 * EquityChart — multi-series cumulative-P&L line chart for the Amsterdam paper-sim (server component,
 * inline SVG, no client JS). One line per betting-hour arm over the shared date axis, a dashed $0
 * baseline, and a last-point dot per arm. nulls (days before an arm's first bet) break the line.
 */
import type { ReactElement } from 'react';

export interface EquitySeries {
  label: string;
  color: string;
  /** Aligned to `dates`; null = no bet yet for this arm on/under that date. */
  values: (number | null)[];
}

export function EquityChart({
  dates,
  series,
  width = 720,
  height = 240,
}: {
  dates: string[];
  series: EquitySeries[];
  width?: number;
  height?: number;
}): ReactElement {
  const allY = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (dates.length < 2 || allY.length < 1) {
    return (
      <svg className="equity" width={width} height={height} role="img" aria-label="not enough data yet">
        <text x={12} y={height / 2} fill="var(--muted)" fontSize={12}>
          not enough graded days yet — the curve fills in as bets resolve
        </text>
      </svg>
    );
  }

  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const minY = Math.min(0, ...allY);
  const maxY = Math.max(0, ...allY);
  const spanY = maxY - minY || 1;
  const n = dates.length;

  const xAt = (i: number): number => padL + (i * (width - padL - padR)) / Math.max(1, n - 1);
  const yAt = (v: number): number => padT + (height - padT - padB) * (1 - (v - minY) / spanY);
  const y0 = yAt(0);

  const pathFor = (vals: (number | null)[]): string => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
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
      if (v !== null && v !== undefined) return { x: xAt(i), y: yAt(v) };
    }
    return null;
  };

  const fmtY = (v: number): string => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(0)}`;

  return (
    <svg className="equity" width={width} height={height} role="img" aria-label="cumulative P&L by betting hour">
      {/* y gridlines: min, 0, max */}
      {[minY, 0, maxY].map((g, k) => (
        <g key={k}>
          <line
            x1={padL}
            x2={width - padR}
            y1={yAt(g)}
            y2={yAt(g)}
            stroke="var(--border)"
            strokeWidth={1}
            strokeDasharray={g === 0 ? '0' : '3 3'}
          />
          <text x={padL - 6} y={yAt(g) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
            {fmtY(g)}
          </text>
        </g>
      ))}
      {/* zero baseline emphasized */}
      <line x1={padL} x2={width - padR} y1={y0} y2={y0} stroke="var(--muted)" strokeWidth={1} />
      {/* series */}
      {series.map((s) => {
        const lp = lastPoint(s.values);
        return (
          <g key={s.label}>
            <path d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={1.8} />
            {lp ? <circle cx={lp.x} cy={lp.y} r={2.6} fill={s.color} /> : null}
          </g>
        );
      })}
      {/* x labels: first + last date */}
      <text x={padL} y={height - 6} fontSize={10} fill="var(--muted)">
        {dates[0]?.slice(5)}
      </text>
      <text x={width - padR} y={height - 6} textAnchor="end" fontSize={10} fill="var(--muted)">
        {dates[n - 1]?.slice(5)}
      </text>
    </svg>
  );
}
