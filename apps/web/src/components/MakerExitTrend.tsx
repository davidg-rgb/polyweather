/**
 * MakerExitTrend — small-multiple sparklines of the /maker-exit measured assumptions over time (server component,
 * inline SVG, no client JS). One mini line per assumption (makerFillRate / realizedRebateUsd / qualifyingTickFrac
 * + the v2 WHY fields), drawn from the dash_maker_exit_history (0079) snapshot stream. The fill-rate line is
 * annotated with the 0.30 warning + 0.49 backtest reference lines (MAKER-EXIT-SIM.md).
 *
 * HONEST NULLS: a null point (a NaN assumption — no realized trades / a zero denominator) BREAKS the line; it is
 * never drawn as a zero. A metric with no finite point yet renders a "no realized data yet" placeholder card.
 */
import type { ReactElement } from 'react';
import type { MakerExitHistoryFeed } from '../lib/loaders.ts';
import {
  MAKER_EXIT_TREND_SPECS,
  TREND_MAX_CITY_ERRORS,
  TREND_MIN_MARKETS,
  filterTrendPoints,
  hasAnyFinite,
  lastFinite,
  seriesDomain,
  toSeries,
  type TrendRefLine,
  type TrendSpec,
} from '../lib/maker-exit-trend.ts';
import { fmtPct, fmtUsd } from '../lib/format.ts';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';
const SKY = 'var(--ams-secondary)';
const MUTED = 'var(--ams-muted, var(--muted))';

/** Format the current-value readout per metric kind. */
function fmtValue(v: number | null, kind: TrendSpec['kind']): string {
  if (v === null) return '—';
  if (kind === 'usd') return fmtUsd(v);
  if (kind === 'pp') return `${v.toFixed(1)}pp`;
  return fmtPct(v, 0);
}

/** Tone the fill-rate readout by the 0.30 / 0.49 thresholds (red ≤0.30, green ≥0.49, amber between). */
function readoutColor(spec: TrendSpec, last: number | null): string | undefined {
  if (spec.key !== 'makerFillRate' || last === null) return undefined;
  if (last <= 0.3) return RED;
  if (last >= 0.49) return GREEN;
  return AMBER;
}

const refColor = (t: TrendRefLine['tone']): string => (t === 'warn' ? RED : GREEN);

/** One mini sparkline: null-breaking polyline + optional horizontal reference lines + a last-point dot. */
function Sparkline({
  values,
  domain,
  color,
  refLines,
}: {
  values: (number | null)[];
  domain: [number, number];
  color: string;
  refLines?: TrendRefLine[];
}): ReactElement {
  const W = 232;
  const H = 66;
  const padL = 6;
  const padR = 54; // room for the ref-line labels on the fill-rate card
  const padT = 8;
  const padB = 12;
  const [minY, maxY] = domain;
  const spanY = maxY - minY || 1;
  const n = values.length;

  const xAt = (i: number): number => padL + (i * (W - padL - padR)) / Math.max(1, n - 1);
  const yAt = (v: number): number => padT + (H - padT - padB) * (1 - (v - minY) / spanY);

  const path = ((): string => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  })();

  let last: { x: number; y: number } | null = null;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null) {
      last = { x: xAt(i), y: yAt(v) };
      break;
    }
  }

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="assumption trend sparkline">
      {/* reference lines (fill-rate only) — dashed, labelled at the right */}
      {(refLines ?? [])
        .filter((r) => r.y >= minY && r.y <= maxY)
        .map((r) => (
          <g key={r.label}>
            <line x1={padL} x2={W - padR} y1={yAt(r.y)} y2={yAt(r.y)} stroke={refColor(r.tone)} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
            <text x={W - padR + 3} y={yAt(r.y) + 3} fontSize={8} fontWeight={700} fill={refColor(r.tone)}>
              {r.label}
            </text>
          </g>
        ))}
      {/* the metric line */}
      {path ? <path d={path} fill="none" stroke={color} strokeWidth={1.8} /> : null}
      {last ? <circle cx={last.x} cy={last.y} r={2.4} fill={color} /> : null}
    </svg>
  );
}

/** One small-multiple card: label + hint + current value + the sparkline + first/last snapshot time. */
function TrendCard({ spec, points, dates }: { spec: TrendSpec; points: MakerExitHistoryFeed['points']; dates: string[] }): ReactElement {
  const values = toSeries(points, spec.key);
  const domain = seriesDomain(values, spec);
  const last = lastFinite(values);
  const any = hasAnyFinite(values);
  const shortTime = (iso: string): string => (typeof iso === 'string' ? iso.slice(5, 16).replace('T', ' ') : '');
  return (
    <div className="tile" style={{ minWidth: 0 }}>
      <div className="tile-head" style={{ alignItems: 'baseline' }}>
        <span className="cap">{spec.label}</span>
        <span className="big" style={{ fontSize: '1.05rem', color: readoutColor(spec, last) ?? SKY }}>
          {fmtValue(last, spec.kind)}
        </span>
      </div>
      {any ? (
        <Sparkline values={values} domain={domain} color={SKY} refLines={spec.refLines} />
      ) : (
        <div className="sub" style={{ height: 66, display: 'flex', alignItems: 'center', color: MUTED }}>
          no realized data yet — fills in as trades resolve
        </div>
      )}
      <div className="sub" style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
        <span className="muted" style={{ fontSize: '0.72rem' }}>{dates.length > 0 ? shortTime(dates[0]!) : ''}</span>
        {spec.hint ? <span className="muted" style={{ fontSize: '0.72rem', textAlign: 'center', flex: 1 }}>{spec.hint}</span> : null}
        <span className="muted" style={{ fontSize: '0.72rem' }}>{dates.length > 0 ? shortTime(dates[dates.length - 1]!) : ''}</span>
      </div>
    </div>
  );
}

/**
 * The small-multiples grid, rendered ABOVE the assumption tiles. Degraded (partial-view) snapshots are
 * FILTERED OUT of the headline + sparklines first (review #21: a 1-of-73-cities tick's makerFillRate of
 * 0.0/1.0 must never crater the #1 KILL-driving assumption's trend) — the excluded count renders as a subtle
 * note under the grid. Returns null when fewer than 2 trend-worthy snapshots remain (a sparkline needs a
 * segment) — the page then shows exactly its pre-0079 behaviour.
 */
export function MakerExitTrend({ history }: { history: MakerExitHistoryFeed | null }): ReactElement | null {
  const { points, excluded } = filterTrendPoints(history?.points ?? []);
  if (points.length < 2) return null;
  const dates = points.map((p) => p.capturedAt);
  return (
    <>
      <div className="mx-trend" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.6rem', marginBottom: excluded > 0 ? '0.25rem' : '0.8rem' }}>
        {MAKER_EXIT_TREND_SPECS.map((spec) => (
          <TrendCard key={spec.key} spec={spec} points={points} dates={dates} />
        ))}
      </div>
      {excluded > 0 ? (
        <p className="muted small" style={{ margin: '0 0 0.8rem', fontSize: '0.72rem' }}>
          {excluded} degraded snapshot{excluded === 1 ? '' : 's'} excluded from the trend (partial city fetch
          &gt;{TREND_MAX_CITY_ERRORS} errors, or below the {TREND_MIN_MARKETS}-market gate floor).
        </p>
      ) : null}
    </>
  );
}
