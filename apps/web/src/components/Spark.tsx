/** Inline SVG sparkline — pnl series (/) and equity curve (/bets). Server component. */

import type { ReactElement } from 'react';
export function Spark({
  values,
  width = 320,
  height = 56,
  stroke = 'var(--accent)',
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
}): ReactElement {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) {
    return (
      <svg className="spark" width={width} height={height} role="img" aria-label="not enough data">
        <text x={4} y={height / 2} fill="var(--muted)" fontSize={11}>
          not enough data
        </text>
      </svg>
    );
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const pad = 3;
  const pts = finite
    .map((v, i) => {
      const x = pad + (i * (width - 2 * pad)) / (finite.length - 1);
      const y = height - pad - ((v - min) * (height - 2 * pad)) / span;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="spark" width={width} height={height} role="img" aria-label="sparkline">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}
