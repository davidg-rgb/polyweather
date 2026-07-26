/**
 * CityFloorStrip — the /cities "when is the day decided" section (CITY-ORACLE-BUILDOUT Build 1).
 *
 * Renders the committed RESOLUTION-GRADE floor-formation climatology (core/sim/city-floor-climatology:
 * IEM METAR/SPECI — the exact stream WU's resolution table re-renders — in rendered-integer space) as a
 * per-city table for each city's CURRENT LOCAL MONTH: a compact decided-window range strip (p10 → p90 of
 * the first local hour the WU-rendered running max reaches the day's final value, median tick), plus the
 * same numbers as text so nothing is color-alone. Server component, inline SVG, no client JS, no DB —
 * static asset only (the PeakHourChart idiom).
 */
import type { ReactElement } from 'react';
import {
  CITY_FLOOR_CLIMATOLOGY,
  cityFloorMonth,
  getResolutionRisk,
  type CityFloorClimatology,
  type MonthFloorClimatology,
} from '@weather-edge/core';

const MONTH_NAME = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** 1..12 current calendar month in the city's own timezone (the month its markets resolve in). */
function localMonth(tz: string, nowMs: number): number {
  const m = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'numeric' }).format(new Date(nowMs)),
  );
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : new Date(nowMs).getUTCMonth() + 1;
}

/** First local hour with decidedPct ≥ p, or null if the curve never reaches it before end of day. */
function hourDecidedAt(m: MonthFloorClimatology, p: number): number | null {
  for (let h = 0; h < 24; h++) if ((m.decidedPct[h] ?? 0) >= p) return h;
  return null;
}

/** The compact decided-window strip: a 0–24h axis, p10→p90 range bar, median tick. Pure SVG. */
function DecidedWindowStrip({ m }: { m: MonthFloorClimatology }): ReactElement {
  const W = 210;
  const H = 16;
  const xAt = (h: number): number => (h / 24) * W;
  const x0 = xAt(m.decidedHourP10);
  const x1 = Math.max(xAt(m.decidedHourP90 + 1), x0 + 2); // +1: the p90 HOUR spans [p90, p90+1)
  const xMed = xAt(m.decidedHourMedian + 0.5);
  const label =
    `Decided window: 10% of days by ${m.decidedHourP10}:00, half by ${m.decidedHourMedian}:00, ` +
    `90% by ${m.decidedHourP90}:00 local (n=${m.nDays} days).`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <title>{label}</title>
      {/* recessive axis + 06/12/18 ticks */}
      <line x1={0} y1={H - 2} x2={W} y2={H - 2} stroke="var(--ams-grid)" strokeWidth={1} />
      {[6, 12, 18].map((h) => (
        <line key={h} x1={xAt(h)} y1={2} x2={xAt(h)} y2={H - 2} stroke="var(--ams-grid)" strokeWidth={1} />
      ))}
      {/* the p10–p90 decided window */}
      <rect
        x={x0}
        y={4}
        width={x1 - x0}
        height={H - 9}
        rx={3}
        fill="var(--ams-secondary)"
        fillOpacity={0.32}
      />
      {/* median tick */}
      <rect x={xMed - 1} y={2} width={2.5} height={H - 5} rx={1} fill="var(--ams-amber)" />
    </svg>
  );
}

interface StripRow {
  c: CityFloorClimatology;
  month: number;
  m: MonthFloorClimatology | null;
}

export function CityFloorStrip({ nowMs }: { nowMs: number }): ReactElement {
  const rows: StripRow[] = CITY_FLOOR_CLIMATOLOGY.cities
    .map((c) => {
      const month = localMonth(c.tz, nowMs);
      return { c, month, m: cityFloorMonth(c, month) };
    })
    .sort((a, b) => {
      // earliest-deciding cities first (ties: alphabetical) — thin rows sink to the bottom
      if (a.m === null && b.m === null) return a.c.name.localeCompare(b.c.name);
      if (a.m === null) return 1;
      if (b.m === null) return -1;
      return a.m.decidedHourMedian - b.m.decidedHourMedian || a.c.name.localeCompare(b.c.name);
    });

  const monthsShown = new Set(rows.map((r) => MONTH_NAME[r.month - 1]));

  return (
    <>
      <h2>When is the day decided?</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        <strong>Resolution-grade floor-formation climatology</strong>, per city for its current local month (
        {[...monthsShown].join(' / ')}). Markets resolve on WU&apos;s Daily Observations table — a bit-for-bit
        re-render of the METAR/SPECI stream — so &quot;decided&quot; here is the integer question that actually
        settles a bucket: the first local hour the <em>rendered</em> running max reaches the day&apos;s final
        rendered value. After that hour, later observations can tie but never move the winning bucket. Curves are
        computed from the multi-year IEM METAR archive (the validated oracle replica&apos;s data), not from
        reanalysis. Bar = the 10th–90th percentile decided window; <span style={{ color: 'var(--ams-amber)' }}>▮</span>{' '}
        tick = the median. <strong>Replica agrees</strong> = how often that METAR replica&apos;s daily max equals
        our stored WU grading truth over the trailing ~90 days (<span className="mono">RESOLUTION-RISK.md</span> —
        a low value flags a WU page that does not render this station&apos;s METAR stream). Read-only analytics —
        no signal claim (all twelve tested signals are dead, <span className="mono">FINDINGS.md</span>).
      </p>
      <div className="panel">
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>city</th>
                <th>decided window (local 0–24h, ticks 06/12/18)</th>
                <th className="num">p10</th>
                <th className="num">median</th>
                <th className="num">p90</th>
                <th className="num">90% of days by</th>
                <th className="num">n days</th>
                <th className="num">replica agrees</th>
                <th className="num">coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, m }) => {
                const risk = getResolutionRisk(c.slug);
                return (
                <tr key={c.slug}>
                  <td>
                    {c.name} <span className="muted small mono">{c.icao} °{c.unit}</span>
                  </td>
                  {m ? (
                    <>
                      <td>
                        <DecidedWindowStrip m={m} />
                      </td>
                      <td className="num mono">{m.decidedHourP10}:00</td>
                      <td className="num mono" style={{ color: 'var(--ams-amber)', fontWeight: 600 }}>
                        {m.decidedHourMedian}:00
                      </td>
                      <td className="num mono">{m.decidedHourP90}:00</td>
                      <td className="num mono">
                        {hourDecidedAt(m, 0.9) !== null ? `${hourDecidedAt(m, 0.9)}:00` : '—'}
                      </td>
                      <td className="num mono">{m.nDays}</td>
                    </>
                  ) : (
                    <>
                      <td className="muted small" colSpan={5}>
                        sample too thin for this month (&lt;30 complete days)
                      </td>
                      <td className="num mono muted">—</td>
                    </>
                  )}
                  <td
                    className="num mono"
                    title={
                      risk
                        ? `METAR replica vs stored WU truth over ${risk.n} days (trailing ~90d). ` +
                          `A low number means WU's page for this city does NOT re-render this station's METAR stream ` +
                          `(shenzhen is the known case) — treat replica-derived analytics for it with caution.`
                        : 'no crosscheck row'
                    }
                    style={risk && risk.resolutionRisk > 0.1 ? { color: 'var(--ams-red)', fontWeight: 600 } : undefined}
                  >
                    {risk ? `${Math.round(risk.matchRate * 100)}%` : '—'}
                  </td>
                  <td className="num mono small muted">
                    {c.fromYear}–{c.toYear}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
