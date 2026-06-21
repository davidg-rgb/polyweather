/**
 * PeakHourChart — the /amsterdam hero "real-time vs 20-year average" chart (server component, inline SVG,
 * no client JS; the EquityChart idiom). Plots, over the local hour-of-day:
 *   · the 20-yr average temperature curve (dashed)           — "how a typical <month> day warms"
 *   · the 20-yr average running-max curve (dotted)           — the climatological bet floor
 *   · the latest day's live running-max (solid blue + dots)  — where our floor actually is
 *   · a faint per-hour peak distribution + a shaded band     — when the daily max usually lands (shape + window)
 *   · the model's recommended lock hour (amber rule)         — best time to bet
 *
 * Series are distinguished by LINE STYLE, not colour alone (WCAG; the hourly-breakdown table is the
 * screen-reader fallback). All geometry is pure → unit-testable scale, no animation by default.
 */
import type { ReactElement } from 'react';
import type { PeakHourChartView } from '../lib/loaders.ts';

const HOURS = 24;

export function PeakHourChart({
  data,
  width = 760,
  height = 300,
}: {
  data: PeakHourChartView;
  width?: number;
  height?: number;
}): ReactElement {
  const { avgTempC, avgRunMaxC, peakHistogram, todayRunMax, peakWindow, recommendedHour, medianPeakHour } = data;

  const padL = 40;
  const padR = 16;
  const padT = 30;
  const padB = 26;

  const allY = [...avgTempC, ...avgRunMaxC, ...todayRunMax.map((p) => p.runMaxC)].filter((v) => Number.isFinite(v));
  // Guard the empty/degenerate case the way the sibling EquityChart does — never emit NaN SVG coordinates
  // (Math.min(...[]) is Infinity, and spanY would be -Infinity which is truthy, so `|| 1` would not fire).
  if (allY.length === 0) {
    return (
      <svg className="peak-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="climatology unavailable">
        <text x={12} y={height / 2} fill="var(--ams-muted)" fontSize={12}>
          climatology unavailable
        </text>
      </svg>
    );
  }
  const minY = Math.floor(Math.min(...allY) - 1);
  const maxY = Math.ceil(Math.max(...allY) + 1);
  const rangeY = maxY - minY;
  const spanY = Number.isFinite(rangeY) && rangeY > 0 ? rangeY : 1;

  // x is the local hour 0..24 (24 = end-of-day tick); points sit at their integer hour.
  const xAt = (h: number): number => padL + (h * (width - padL - padR)) / HOURS;
  const yAt = (v: number): number => padT + (height - padT - padB) * (1 - (v - minY) / spanY);

  const lineFor = (vals: number[]): string =>
    vals.map((v, h) => `${h === 0 ? 'M' : 'L'}${xAt(h).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');

  const todaySorted = [...todayRunMax].sort((a, b) => a.hour - b.hour);
  const todayPath = todaySorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(p.hour).toFixed(1)},${yAt(p.runMaxC).toFixed(1)}`).join(' ');

  const gridYs = [minY, minY + spanY / 2, maxY];
  const xTicks = [0, 6, 12, 18, 24];
  const bandX = xAt(peakWindow.fromHour);
  const bandW = Math.max(xAt(peakWindow.toHour + 1) - bandX, 2); // ≥2px so a collapsed (single-hour) window is still visible
  const recX = recommendedHour == null ? null : xAt(recommendedHour + 0.5);

  // Faint peak-hour distribution behind the band — the actual shape the window summarises.
  const maxShare = Math.max(...peakHistogram, 1e-9);
  const barW = ((width - padL - padR) / HOURS) * 0.6;
  const barBase = height - padB;
  const barMaxH = (height - padT - padB) * 0.34;

  const ariaLabel =
    `Schiphol hour-of-day temperature: the daily max usually lands between ${peakWindow.fromHour}:00 and ` +
    `${peakWindow.toHour}:00 local (modal ${peakWindow.modeHour}:00, median ${medianPeakHour}:00). ` +
    (recommendedHour == null ? 'No lock hour recommended yet.' : `Recommended lock hour ${recommendedHour}:00.`);

  return (
    <svg
      className="peak-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      {/* faint peak-hour distribution (share of days peaking at each local hour) — the shape behind the band */}
      {peakHistogram.map((share, h) =>
        share > 0 ? (
          <rect
            key={h}
            x={xAt(h) - barW / 2}
            y={barBase - (share / maxShare) * barMaxH}
            width={barW}
            height={(share / maxShare) * barMaxH}
            fill="var(--ams-secondary-dim)"
            opacity={0.32}
          />
        ) : null,
      )}

      {/* peak-hour band — when the daily max usually lands */}
      <rect x={bandX} y={padT} width={bandW} height={height - padT - padB} fill="var(--ams-amber)" opacity={0.1} />
      <text x={bandX + bandW / 2} y={padT - 8} textAnchor="middle" fontSize={10} fill="var(--ams-amber)" className="cap">
        peak window
      </text>

      {/* y gridlines + °C labels */}
      {gridYs.map((g, k) => (
        <g key={k}>
          <line x1={padL} x2={width - padR} y1={yAt(g)} y2={yAt(g)} stroke="var(--ams-grid)" strokeWidth={1} />
          <text x={padL - 6} y={yAt(g) + 3} textAnchor="end" fontSize={10} fill="var(--ams-muted)" className="mono">
            {Math.round(g)}°
          </text>
        </g>
      ))}

      {/* x ticks (local hour) */}
      {xTicks.map((h) => (
        <text key={h} x={xAt(h)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--ams-muted)" className="mono">
          {String(h).padStart(2, '0')}:00
        </text>
      ))}

      {/* 20-yr average temperature — dashed */}
      <path d={lineFor(avgTempC)} fill="none" stroke="var(--ams-muted)" strokeWidth={1.5} strokeDasharray="4 3" />
      {/* 20-yr average running max — dotted */}
      <path d={lineFor(avgRunMaxC)} fill="none" stroke="var(--ams-secondary-dim)" strokeWidth={1.5} strokeDasharray="1 3" strokeLinecap="round" />

      {/* recommended lock hour — amber rule */}
      {recX != null ? (
        <g>
          <line x1={recX} x2={recX} y1={padT} y2={height - padB} stroke="var(--ams-amber)" strokeWidth={1.5} strokeDasharray="2 2" />
          <rect x={recX - 30} y={padT - 2} width={60} height={16} rx={2} fill="var(--ams-amber)" />
          <text x={recX} y={padT + 9} textAnchor="middle" fontSize={9} fontWeight={700} fill="#1a1200" className="mono">
            BET {String(recommendedHour).padStart(2, '0')}:00
          </text>
        </g>
      ) : null}

      {/* latest day's live running max — solid electric blue with markers */}
      {todaySorted.length > 0 ? (
        <g className="peak-live">
          <path d={todayPath} fill="none" stroke="var(--ams-secondary)" strokeWidth={2.4} strokeLinejoin="round" />
          {todaySorted.map((p) => (
            <circle key={p.hour} cx={xAt(p.hour)} cy={yAt(p.runMaxC)} r={3} fill="var(--ams-bg)" stroke="var(--ams-secondary)" strokeWidth={2} />
          ))}
        </g>
      ) : null}
    </svg>
  );
}
