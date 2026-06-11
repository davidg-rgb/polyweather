/**
 * Reliability diagram (§5): predicted-probability bins vs observed hit rate
 * against the perfect-calibration diagonal; dot area ∝ n. Data shaped by
 * shapeReliability (§15-tested). Server component.
 */
import type { ReactElement } from 'react';
import type { ReliabilityPoint } from '../lib/shapers.ts';

const SIZE = 260;
const PAD = 28;

export function ReliabilityDiagram({ points, title }: { points: ReliabilityPoint[]; title?: string }): ReactElement {
  const plot = SIZE - 2 * PAD;
  const x = (p: number): number => PAD + p * plot;
  const y = (p: number): number => SIZE - PAD - p * plot;
  const maxN = Math.max(1, ...points.map((p) => p.n));
  return (
    <div>
      {title ? <h3>{title}</h3> : null}
      {points.length === 0 ? (
        <p className="muted small">No reliability data stored yet.</p>
      ) : (
        <svg width={SIZE} height={SIZE} role="img" aria-label="reliability diagram">
          <rect x={PAD} y={PAD} width={plot} height={plot} fill="none" stroke="var(--border)" />
          {/* perfect calibration */}
          <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--muted)" strokeDasharray="4 3" />
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <text x={x(t)} y={SIZE - PAD + 14} fill="var(--muted)" fontSize={9} textAnchor="middle">{t}</text>
              <text x={PAD - 6} y={y(t) + 3} fill="var(--muted)" fontSize={9} textAnchor="end">{t}</text>
            </g>
          ))}
          <text x={SIZE / 2} y={SIZE - 4} fill="var(--muted)" fontSize={10} textAnchor="middle">predicted q</text>
          <text x={10} y={SIZE / 2} fill="var(--muted)" fontSize={10} textAnchor="middle" transform={`rotate(-90 10 ${SIZE / 2})`}>observed</text>
          {points.map((p) => (
            <circle
              key={p.x}
              cx={x(p.x)}
              cy={y(p.y)}
              r={3 + 6 * Math.sqrt(p.n / maxN)}
              fill="var(--accent)"
              fillOpacity={0.7}
            >
              <title>{`bin ${p.x}: observed ${p.y.toFixed(3)} (n=${p.n})`}</title>
            </circle>
          ))}
        </svg>
      )}
    </div>
  );
}
