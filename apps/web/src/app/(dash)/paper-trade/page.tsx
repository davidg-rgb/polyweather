/**
 * /paper-trade — the GENERALIZED multi-city paper-trade head-to-head (the Amsterdam sim, N cities).
 *
 * Operator ask (2026-06-29): run the daily $10/arm paper-trade on the most forecast-accurate °C cities with
 * a liquid Polymarket market — Singapore (WSSS) + Karachi (OPKC) — to MEASURE whether a systematic everyday
 * bet on our predicted bucket nets a profit vs the real market. Per city it races config arm hours (11–14
 * local, bracketing the tropical ~12:30 peak), records the in-lock-hour odds, grades to the resolved high,
 * and tracks cumulative P&L. Read-only over dash_city_sim (migration 0070). NOT trading — analytics only;
 * efficiency prior says the curves hug $0 net of fees (a sustained climb is the signal worth chasing).
 */
import type { ReactElement } from 'react';
import {
  CITY_SCAN_ASK_SPLIT,
  CITY_SCAN_CAVEATS,
  CITY_SCAN_CONFIDENCE_TERCILES,
  CITY_SCAN_CONFIRMATION_CLOCK,
  CITY_SCAN_ENROLLMENT,
  CITY_SCAN_META,
  CITY_SCAN_POOLED_CURVE,
  CITY_SCAN_TOP5_TRAIN_CELLS,
  type CityScanCandidate,
  localHourInstant,
} from '@weather-edge/core';
import { EquityChart, type EquitySeries } from '../../../components/EquityChart.tsx';
import { fmtDate, fmtDelta, fmtPct, fmtStockholm, fmtUsd, num } from '../../../lib/format.ts';
import {
  type CityForecast,
  type CitySimCity,
  type CitySimView,
  getCityForecast,
  getCitySim,
} from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
// Arms are coloured by POSITION (not absolute hour, since cities race different hours) on the categorical ramp.
// Six slots so a widened race (e.g. 10–15 local) keeps distinct colours without wrapping.
const ARM_PALETTE = [
  'var(--ams-arm-13)', 'var(--ams-arm-14)', 'var(--ams-arm-15)', 'var(--ams-arm-16)',
  'var(--ams-tertiary)', 'var(--ams-secondary-dim)',
];
const ARM_DASH = [undefined, '5 3', '2 3', '7 3 2 3', '1 2', '9 3'];

const signedUsd = (v: number | null, dp = 2): string =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v), dp)}`;
const pnlClass = (v: number | null): string => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
/** percentage-point delta, signed: pp(3.6) = '+3.6pp', pp(-11.4) = '-11.4pp'. */
const pp = (v: number | null): string => (v == null ? '—' : `${fmtDelta(v, 1)}pp`);

/**
 * The Europe/Stockholm wall-clock equivalent of a city-LOCAL arm hour on a given target date, e.g.
 * '11:00 CEST'. DST-correct on both ends: the instant comes from the city's IANA zone
 * (core `localHourInstant`), the rendering from the Stockholm IANA zone via Intl — never a fixed
 * offset. Appends '+1d'/'−1d' when the Stockholm calendar date differs from the target date.
 */
function stockholmHm(tz: string, dateISO: string, hour: number): string {
  try {
    const instant = localHourInstant(tz, dateISO, hour);
    const p: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).formatToParts(instant)) {
      p[part.type] = part.value;
    }
    const sthlmDate = `${p.year}-${p.month}-${p.day}`;
    const shift = sthlmDate === dateISO ? '' : sthlmDate > dateISO ? ' +1d' : ' −1d';
    return `${p.hour}:${p.minute} ${p.timeZoneName}${shift}`;
  } catch {
    return '—';
  }
}

/** The entry-time watcher's confidence → a tile colour + a short badge label. */
const WATCH_UI: Record<string, { color: string; badge: string }> = {
  sufficient: { color: GREEN, badge: 'confident' },
  provisional: { color: 'var(--ams-secondary)', badge: 'provisional' },
  insufficient: { color: 'var(--ams-secondary-dim)', badge: 'gathering' },
};

/** One city's section: standings tiles, the arm leaderboard, the equity chart, today's call, the bet log. */
function CityPanel({ city }: { city: CitySimCity }): ReactElement {
  const totalPnl = num(city.totals?.pnl);
  const nGraded = num(city.totals?.nGraded) ?? 0;
  const nWon = num(city.totals?.nWon) ?? 0;
  const nDays = num(city.coverage?.nDays) ?? 0;
  const nGradedDays = num(city.coverage?.nGradedDays) ?? 0;
  const nPending = num(city.coverage?.nPending) ?? 0;
  const armColor = (h: number): string => ARM_PALETTE[Math.max(0, city.armHours.indexOf(h)) % ARM_PALETTE.length]!;
  const watch = city.entryWatch;
  const watchUi = WATCH_UI[watch.confidence] ?? WATCH_UI.insufficient!;

  const series: EquitySeries[] = city.armHours
    .filter((h) => city.chart.byHour[h])
    .map((h, i) => ({
      label: `${h}:00`,
      color: armColor(h),
      dash: ARM_DASH[i % ARM_DASH.length],
      values: city.chart.byHour[h]!,
    }));

  const latestDate = city.latest?.date ?? null;

  return (
    <section className="panel" style={{ marginTop: '1.5rem' }}>
      <div className="tile-head" style={{ alignItems: 'baseline', gap: '0.6rem' }}>
        <h2 style={{ margin: 0 }}>{city.displayName}</h2>
        <span className="cap" style={{ color: 'var(--ams-secondary)' }}>{city.icao}</span>
        <span className="cap muted">°{city.unit} · {city.tz} · arms {city.armHours.join('/')} · ${num(city.stakeUsd) ?? 10}/day</span>
      </div>

      {/* standings strip */}
      <div className="strip" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.6rem' }}>
        <div className="tile">
          <div className="cap">Net P&amp;L (all arms)</div>
          <div className={`big ${totalPnl != null && totalPnl >= 0 ? 'pos' : 'neg'}`}>{signedUsd(totalPnl)}</div>
          <div className="sub">{nGraded} graded · {nWon} won</div>
        </div>
        <div className="tile">
          <div className="cap">Leading arm</div>
          <div className="big sky">{city.leaderHour != null ? `${city.leaderHour}:00` : '—'}</div>
          <div className="sub">best P&amp;L of {city.armHours.length} arms</div>
        </div>
        <div className="tile" title={watch.rationale}>
          <div className="cap">Best entry-time ⓘ</div>
          <div className="big" style={{ color: watchUi.color }}>{watch.recommendedHour != null ? `${watch.recommendedHour}:00` : '—'}</div>
          <div className="sub">watcher · {watchUi.badge}</div>
        </div>
        <div className="tile">
          <div className="cap">Coverage</div>
          <div className="big">{nDays}<span className="muted" style={{ fontSize: '0.9rem' }}> days</span></div>
          <div className="sub">{nGradedDays} graded · {nPending} pending</div>
        </div>
        <div className="tile">
          <div className="cap">Window</div>
          <div className="big" style={{ fontSize: '1.2rem' }}>{fmtDate(city.coverage?.firstDate)} →</div>
          <div className="sub">{fmtDate(city.coverage?.lastDate)}</div>
        </div>
      </div>

      {/* entry-time watcher verdict — the continuously-updated optimal-entry recommendation */}
      <div className="info-banner" style={{ marginTop: '0.9rem', borderLeftColor: watchUi.color }}>
        <strong style={{ color: watchUi.color }}>Entry-time watcher:</strong> {watch.rationale}
        <span className="cap muted"> (ranks arms by the 95% lower bound of edge = won−ask, so a thin lucky arm
        can't out-rank a deep one; recommends, never prunes — keep racing all arms.)</span>
      </div>

      {/* arm leaderboard */}
      <div style={{ overflowX: 'auto', marginTop: '0.9rem' }}>
        <table>
          <thead>
            <tr>
              <th>arm</th><th>bets</th><th>graded</th><th>hit rate</th><th>avg ask</th>
              <th>net P&amp;L</th><th>ROI</th><th>edge (won−ask)</th>
            </tr>
          </thead>
          <tbody>
            {city.arms.map((a) => {
              const pnl = num(a.pnl);
              const hit = num(a.hitRate);
              const ng = num(a.nGraded) ?? 0;
              const edgeShown = ng > 0 && Number.isFinite(a.edge);
              return (
                <tr key={a.hour} className={a.recommended ? 'rec-row' : undefined}>
                  <td style={{ color: armColor(a.hour), fontWeight: 700 }}>
                    {a.hour}:00{a.isLeader ? ' 🥇' : ''}{a.recommended ? ' ⭐' : ''}
                  </td>
                  <td>{num(a.nBets) ?? 0}</td>
                  <td>{ng}</td>
                  <td>{hit == null ? '—' : `${fmtPct(hit, 0)}${ng > 0 ? ` (${fmtPct(a.hitCiLo, 0)}–${fmtPct(a.hitCiHi, 0)})` : ''}`}</td>
                  <td>{a.avgAsk == null ? '—' : fmtPct(a.avgAsk, 0)}</td>
                  <td className={pnlClass(pnl)}>{signedUsd(pnl)}</td>
                  <td className={pnlClass(num(a.roi))}>{a.roi == null ? '—' : fmtPct(a.roi, 1)}</td>
                  <td className={edgeShown ? pnlClass(a.edge) : ''}>
                    {edgeShown ? `${a.edge >= 0 ? '+' : '−'}${fmtPct(Math.abs(a.edge), 1)} (${fmtPct(a.edgeCiLo, 0)}–${fmtPct(a.edgeCiHi, 0)})` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* cumulative P&L per arm */}
      <div style={{ marginTop: '1rem' }}>
        <div className="cap">Cumulative P&amp;L per arm ($)</div>
        <EquityChart dates={city.chart.dates} series={series} />
        <div className="chart-legend">
          {city.armHours.map((h) => (
            <span key={h}><i className="ln solid" style={{ borderColor: armColor(h) }} /> {h}:00</span>
          ))}
        </div>
      </div>

      {/* latest standing call */}
      {latestDate ? (
        <div style={{ marginTop: '0.9rem' }}>
          <div className="cap">Latest call · {fmtDate(latestDate)}</div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>arm</th><th>predicted</th><th>run-max</th><th>ask</th><th>status</th><th>actual</th><th>P&amp;L</th></tr>
              </thead>
              <tbody>
                {city.armHours.map((h) => {
                  const r = city.latest.byHour[h];
                  if (!r) return null;
                  const pnl = num(r.pnl);
                  return (
                    <tr key={h}>
                      <td style={{ color: armColor(h), fontWeight: 700 }}>{h}:00</td>
                      <td>{r.predictedC == null ? '—' : `${r.predictedC}° ${r.label ?? ''}`}</td>
                      <td>{r.runMaxC == null ? '—' : `${num(r.runMaxC)?.toFixed(1)}°`}</td>
                      <td>{r.ask == null ? '—' : fmtPct(r.ask, 0)}</td>
                      <td>{r.status}{r.won === true ? ' ✓' : r.won === false ? ' ✗' : ''}</td>
                      <td>{r.actualC == null ? '—' : `${r.actualC}°`}</td>
                      <td className={pnlClass(pnl)}>{r.status === 'pending' ? '—' : signedUsd(pnl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* bet log */}
      {city.betLog.length > 0 ? (
        <details className="detail" style={{ marginTop: '0.9rem' }}>
          <summary>bet log · {city.betLog.length} most recent</summary>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>date</th><th>arm</th><th>predicted</th><th>ask</th><th>status</th><th>actual</th><th>P&amp;L</th></tr>
              </thead>
              <tbody>
                {city.betLog.map((b, i) => {
                  const pnl = num(b.pnl);
                  return (
                    <tr key={`${b.date}-${b.hour}-${i}`}>
                      <td>{fmtDate(b.date)}</td>
                      <td style={{ color: armColor(b.hour) }}>{b.hour}:00</td>
                      <td>{b.predictedC == null ? '—' : `${b.predictedC}° ${b.label ?? ''}`}</td>
                      <td>{b.ask == null ? '—' : fmtPct(b.ask, 0)}</td>
                      <td>{b.status}{b.won === true ? ' ✓' : b.won === false ? ' ✗' : ''}</td>
                      <td>{b.actualC == null ? '—' : `${b.actualC}°`}</td>
                      <td className={pnlClass(pnl)}>{b.status === 'pending' ? '—' : signedUsd(pnl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** The placed-bet tile body (unchanged pre-N2 rendering): the temps carried on the city's `latest` bets. */
function PlacedBetTile({ city, isCurrent, date }: { city: CitySimCity; isCurrent: boolean; date: string }): ReactElement {
  const rows = city.armHours
    .map((h) => ({ h, r: city.latest.byHour[h] }))
    .filter((x): x is { h: number; r: NonNullable<CitySimCity['latest']['byHour'][number]> } =>
      x.r != null && num(x.r.predictedC) != null);
  const temps = [...new Set(rows.map((x) => num(x.r.predictedC)))];
  const shared = temps.length === 1 ? temps[0] : null;
  const firstArm = rows[0]?.h;
  const lastArm = rows[rows.length - 1]?.h;
  return (
    <div className="tile">
      <div className="tile-head">
        <span className="cap">
          {city.displayName} <span className="muted">{city.icao}</span>
        </span>
        <span className={`chip ${isCurrent ? 'green' : 'soft'}`}>{isCurrent ? 'bidding now' : 'latest bet'}</span>
      </div>
      <div className="sub">
        bidding date <strong className="mono" style={{ color: 'var(--ams-text)' }}>{fmtDate(date)}</strong>
        {isCurrent ? '' : ' — today’s bets not placed yet (daily 10:00Z tick)'}
      </div>
      {shared != null && firstArm != null && lastArm != null ? (
        <>
          <div className="big sky">{shared}°{city.unit}</div>
          <div className="sub">
            all arms · {firstArm}:00–{lastArm}:00 local · {stockholmHm(city.tz, date, firstArm)}
            {firstArm !== lastArm ? `–${stockholmHm(city.tz, date, lastArm)}` : ''}
          </div>
        </>
      ) : rows.length > 0 ? (
        <div className="sub" style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          {rows.map(({ h, r }) => (
            <span key={h} className="mono">
              {h}:00 local · {stockholmHm(city.tz, date, h)} →{' '}
              <strong style={{ color: 'var(--ams-secondary)' }}>{num(r.predictedC)}°{city.unit}</strong>
            </span>
          ))}
        </div>
      ) : (
        <div className="sub muted">no prediction recorded for this date</div>
      )}
    </div>
  );
}

/**
 * The PRE-PLACEMENT tile (N2): before the daily 10:00Z tick, headline TODAY's intended whole-° call from the
 * live pre-placement forecast (dash_city_forecast, 0080 — the bias-corrected lead-1 forecast center the sim
 * will bet), not yesterday's placed bet. It's a forecast CENTER, not the bet: the running-max floor can still
 * lift the actual call at lock, so the tile says so and keeps yesterday's placed date as a footnote.
 */
function IntendedBetTile({ city, fc, latestDate }: { city: CitySimCity; fc: CityForecast; latestDate: string | null }): ReactElement {
  const pred = num(fc.predictedNative);
  const ask = num(fc.ask);
  const date = fc.targetDate ?? new Date().toISOString().slice(0, 10);
  return (
    <div className="tile">
      <div className="tile-head">
        <span className="cap">
          {city.displayName} <span className="muted">{city.icao}</span>
        </span>
        <span className="chip amber">intended · pre-tick</span>
      </div>
      <div className="sub">
        bidding date <strong className="mono" style={{ color: 'var(--ams-text)' }}>{fmtDate(date)}</strong>
        {' — today’s bet not placed yet (daily 10:00Z tick)'}
      </div>
      <div className="big sky">
        {pred}°{city.unit}
        {fc.label ? <span className="cap muted" style={{ marginLeft: '0.4rem' }}>{fc.label}</span> : null}
      </div>
      <div className="sub">
        forecast center {fc.biasCorrected ? '(bias corrected)' : '(raw)'}
        {fc.capturedAt ? ` · as of ${fmtStockholm(fc.capturedAt)}` : ''}
        {ask != null ? ` · ask ${fmtPct(ask, 0)}` : ''}
      </div>
      <div className="sub muted" style={{ fontSize: '0.85rem' }}>
        the running-max floor may lift the actual call at lock
        {latestDate ? ` · last placed bet ${fmtDate(latestDate)}` : ''}
      </div>
    </div>
  );
}

/**
 * The current-bet box (operator request 2026-07-04; completed 2026-07-04 N2): per active city, the target
 * date currently being bet and the predicted native temperature. Once the daily 10:00Z tick has placed the
 * day's bets the box reads them from the loader's `latest` standing call (dash_city_sim carries
 * `predicted_native` per arm as `predictedC`). BEFORE the tick, when the pre-placement forecast RPC
 * (dash_city_forecast, 0080) is available, it headlines TODAY's intended whole-° call instead of lagging on
 * yesterday's bet. Arm hours stay city-LOCAL by design; the Stockholm equivalent is computed per-date via
 * the IANA zones (DST-correct), shown alongside.
 *
 * `forecasts` is a null-guarded add-on: when it is null/absent (the 0080 RPC hasn't shipped), the box renders
 * exactly its pre-N2 placed-bet behaviour — the page ships dark until the migration is applied.
 */
function CurrentBetBox({
  cities,
  forecasts,
}: {
  cities: CitySimCity[];
  forecasts?: Map<string, CityForecast> | null;
}): ReactElement | null {
  const todayUtc = new Date().toISOString().slice(0, 10);
  // Show a city with a placed bet OR a pre-placement forecast to display. With no forecast map this reduces
  // to the original `latest?.date != null` filter — the box is byte-identical when 0080 is absent.
  const shown = cities.filter(
    (c) => c.latest?.date != null || num(forecasts?.get(c.slug)?.predictedNative) != null,
  );
  if (shown.length === 0) return null;

  return (
    <section className="panel" style={{ marginTop: '1rem' }}>
      <div className="tile-head" style={{ alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Current bets</h2>
        <span className="cap muted">
          bidding date + predicted temperature per city · arm hours are city-local, Stockholm equivalent alongside
        </span>
      </div>
      <div className="strip">
        {shown.map((city) => {
          const fc = forecasts?.get(city.slug) ?? null;
          const latestDate = city.latest?.date ?? null;
          const isCurrent = latestDate != null && latestDate >= todayUtc; // ≥ UTC-today counts as the live bet
          // Pre-tick (today's bet not yet placed) + a forecast center exists → headline today's INTENDED call.
          const showIntended = !isCurrent && fc != null && num(fc.predictedNative) != null;
          return showIntended ? (
            <IntendedBetTile key={city.slug} city={city} fc={fc} latestDate={latestDate} />
          ) : (
            // date is non-null here: !showIntended ⇒ either isCurrent (latestDate set) or the city entered
            // `shown` via its latest bet (latestDate set).
            <PlacedBetTile key={city.slug} city={city} isCurrent={isCurrent} date={latestDate!} />
          );
        })}
      </div>
    </section>
  );
}

/** One row of the top-5 TRAIN→TEST confirmation table. */
function CandidateRow({ c }: { c: CityScanCandidate }): ReactElement {
  return (
    <tr className={c.isCandidate ? 'rec-row' : undefined}>
      <td style={{ fontWeight: c.isCandidate ? 700 : 400 }}>
        {c.city}
        {c.icao ? <span className="cap muted" style={{ marginLeft: '0.4rem' }}>{c.icao}</span> : null}
      </td>
      <td>{c.arm}:00</td>
      <td>
        <span className={pnlClass(c.trainNetUsd)}>{signedUsd(c.trainNetUsd)}</span>
        <span className="cap muted" style={{ marginLeft: '0.3rem' }}>n={c.trainN}</span>
      </td>
      <td className={c.trainLbPp > 0 ? 'pos' : 'neg'}>{pp(c.trainLbPp)}</td>
      <td>
        <span className={pnlClass(c.testNetUsd)}>{signedUsd(c.testNetUsd)}</span>
        <span className="cap muted" style={{ marginLeft: '0.3rem' }}>n={c.testN}</span>
      </td>
      <td>{fmtPct(c.testWinRate, 1)}</td>
      <td>[{pp(c.testCiPp[0])}, {pp(c.testCiPp[1])}]</td>
      <td>
        {c.isCandidate ? (
          <span className="chip green">candidate → enrolled</span>
        ) : (
          <span className="chip red" title={c.failReason ?? undefined}>{c.failReason}</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The hero chart: the pooled entry-hour ROI curve (all 11 hours, day-clustered CI whiskers) as downward
 * bars from a zero line — negative at every hour IS the story. Server component, inline SVG, no client JS
 * (the EquityChart/BarChart/PeakHourChart dependency-free idiom). The best (14h) bar is amber; every bar
 * is directly value-labelled so meaning never rides on colour alone; the table below is the a11y fallback.
 */
function ScanCurveChart({ width = 760, height = 300 }: { width?: number; height?: number }): ReactElement {
  const padL = 48;
  const padR = 12;
  const padT = 16;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // y domain in pp — spans every CI in the record with headroom (ciHi max +8.3, ciLo min −104.6).
  const yMax = 10;
  const yMin = -110;
  const yAt = (v: number): number => padT + ((yMax - v) / (yMax - yMin)) * plotH;
  const zeroY = yAt(0);

  const n = CITY_SCAN_POOLED_CURVE.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.52, 42);
  const xC = (i: number): number => padL + slot * (i + 0.5);
  const grid = [0, -25, -50, -75, -100];

  const best = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'best')!;
  const worst = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'worst')!;
  const ariaLabel =
    `Pooled entry-hour ROI across all ${CITY_SCAN_META.nCities} cities: negative at every hour from 9:00 to 19:00 local; ` +
    `best ${pp(best.roiPp)} at ${best.hour}:00, worst ${pp(worst.roiPp)} at ${worst.hour}:00. ` +
    'Whiskers show the day-clustered confidence interval.';

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
      {/* gridlines + pp ticks */}
      {grid.map((g) => (
        <g key={g}>
          <line
            x1={padL}
            x2={width - padR}
            y1={yAt(g)}
            y2={yAt(g)}
            stroke={g === 0 ? 'var(--ams-muted)' : 'var(--ams-grid)'}
            strokeWidth={1}
            strokeDasharray={g === 0 ? '0' : '3 3'}
          />
          <text x={padL - 6} y={yAt(g) + 3} textAnchor="end" fontSize={10} fill="var(--ams-muted)" className="mono">
            {g === 0 ? '0' : `${g}pp`}
          </text>
        </g>
      ))}

      {CITY_SCAN_POOLED_CURVE.map((r, i) => {
        const isBest = r.label === 'best';
        const barH = Math.max(yAt(r.roiPp) - zeroY, 1.5);
        return (
          <g key={r.hour}>
            {/* day-clustered CI whisker */}
            <line x1={xC(i)} x2={xC(i)} y1={yAt(r.ciPp[1])} y2={yAt(r.ciPp[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yAt(r.ciPp[1])} y2={yAt(r.ciPp[1])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yAt(r.ciPp[0])} y2={yAt(r.ciPp[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            {/* the ROI bar (all values negative — bars hang below the zero line) */}
            <rect x={xC(i) - barW / 2} y={zeroY} width={barW} height={barH} rx={3} fill={isBest ? 'var(--ams-amber)' : 'var(--ams-red)'} opacity={isBest ? 0.9 : 0.55}>
              <title>{`${r.hour}:00 — ROI ${pp(r.roiPp)} · n=${r.n} · win ${fmtPct(r.winRate, 1)} · mean ask ${r.meanAsk.toFixed(3)} · CI [${pp(r.ciPp[0])}, ${pp(r.ciPp[1])}]`}</title>
            </rect>
            {/* direct value label at the bar end */}
            <text
              x={xC(i)}
              y={yAt(r.roiPp) + 12}
              textAnchor="middle"
              fontSize={9}
              fontWeight={isBest ? 700 : 400}
              fill={isBest ? 'var(--ams-amber)' : 'var(--ams-red)'}
              className="mono"
            >
              {pp(r.roiPp)}
            </text>
            {/* hour label */}
            <text x={xC(i)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--ams-muted)" className="mono">
              {r.hour}h
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * "45-City Scan" — the analytics section surfacing SIGNAL-BACKLOG.md §12: the one-time historical replay
 * that SELECTED ankara/14h + houston/14h (now enrolled above); the live paper loop CONFIRMS them going
 * forward, from CITY_SCAN_CONFIRMATION_CLOCK onward. Renders entirely from the committed static asset
 * (core/sim/city-scan-results.ts) — no DB round trip, no client fetch.
 */
function CityScanSection(): ReactElement {
  const best = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'best')!;
  const worst = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'worst')!;
  const candidates = CITY_SCAN_TOP5_TRAIN_CELLS.filter((c) => c.isCandidate);

  return (
    <section className="panel" style={{ marginTop: '2rem' }}>
      <div className="tile-head" style={{ alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>45-City Scan</h2>
        <span className="chip soft">analytics selection · not a capital gate</span>
        <span className="cap muted">
          {CITY_SCAN_META.nEvents} events · {CITY_SCAN_META.nCities} cities · {CITY_SCAN_META.nDays} days · run {fmtDate(CITY_SCAN_META.verdictRecordedAt)}
        </span>
      </div>

      <p className="muted small" style={{ marginTop: '0.5rem' }}>
        A one-time historical replay of the $10/day predicted-bucket bet across every city × entry hour
        (9h–19h local), pre-registered before measurement: TRAIN (≤ {CITY_SCAN_META.trainLastDate}) selects
        candidates, TEST (≥ {CITY_SCAN_META.testFirstDate}) confirms them once. It shortlisted two
        &ldquo;another Karachi&rdquo; candidates out of the top-5 ranked cells —{' '}
        <strong>ankara/14:00</strong> and <strong>houston/14:00</strong> — which are{' '}
        <strong>now enrolled</strong> in the live paper loop above. The live loop is the confirmation
        instrument going forward: reads are restricted to markets from{' '}
        <strong>{CITY_SCAN_CONFIRMATION_CLOCK}</strong> onward (the enrollment backfill overlaps the scan's
        own window, so it is in-sample and doesn't count as confirmation).
      </p>

      {/* hero: pooled ROI negative everywhere */}
      <div className="strip">
        <div className="tile">
          <div className="cap">Pooled ROI</div>
          <div className="big neg">negative</div>
          <div className="sub">at every one of the 11 tested entry hours (9h–19h)</div>
        </div>
        <div className="tile rec">
          <div className="cap">Best hour (least-negative)</div>
          <div className="big neg">{pp(best.roiPp)}</div>
          <div className="sub">{best.hour}:00 local — where both candidates sit</div>
        </div>
        <div className="tile">
          <div className="cap">Worst hour</div>
          <div className="big neg">{pp(worst.roiPp)}</div>
          <div className="sub">{worst.hour}:00 local — a fixed-bucket artifact (see caveats)</div>
        </div>
        <div className="tile">
          <div className="cap">Entry ask — win vs lose</div>
          <div className="big" style={{ fontSize: '1.3rem' }}>
            {CITY_SCAN_ASK_SPLIT.winMeanAsk.toFixed(3)} <span className="muted">/</span> {CITY_SCAN_ASK_SPLIT.loseMeanAsk.toFixed(3)}
          </div>
          <div className="sub">
            n={CITY_SCAN_ASK_SPLIT.winN.toLocaleString('en-US')} won / {CITY_SCAN_ASK_SPLIT.loseN.toLocaleString('en-US')} lost ·
            higher confidence → less bad, never positive
          </div>
        </div>
        <div className="tile">
          <div className="cap">Candidates found</div>
          <div className="big sky">{candidates.length} / {CITY_SCAN_TOP5_TRAIN_CELLS.length}</div>
          <div className="sub">of the top-5 TRAIN cells clear the locked bar</div>
        </div>
      </div>

      {/* HERO: the full pooled entry-hour ROI curve — negative at every hour */}
      <div style={{ marginTop: '1.1rem' }}>
        <div className="cap">Pooled entry-hour ROI, all {CITY_SCAN_META.nCities} cities (day-clustered CI whiskers)</div>
        <div style={{ marginTop: '0.5rem', overflowX: 'auto' }}>
          <ScanCurveChart />
        </div>
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          The flat 9h–14h shelf (−11 to −16pp) is the pooled-efficiency read; the monotone collapse from{' '}
          {best.hour}:00 ({pp(best.roiPp)}) to {worst.hour}:00 ({pp(worst.roiPp)}) is largely the locked
          fixed-bucket bet rule at late hours — see the caveats below. Figures from the §12 Data appendix
          (two bit-identical independent runs).
        </p>
        <details className="detail">
          <summary>full curve table (n · net · ROI · win rate · mean ask · CI)</summary>
          <div className="tbl-scroll" style={{ marginTop: '0.5rem' }}>
            <table>
              <thead>
                <tr>
                  <th>arm (local)</th><th>n</th><th>net</th><th>ROI</th><th>win rate</th><th>mean ask</th>
                  <th>day-clustered CI</th>
                </tr>
              </thead>
              <tbody>
                {CITY_SCAN_POOLED_CURVE.map((r) => (
                  <tr key={r.hour} className={r.label === 'best' ? 'rec-row' : undefined}>
                    <td style={{ fontWeight: r.label ? 700 : 400 }}>
                      {r.hour}:00{r.label === 'best' ? ' ⭐ best' : r.label === 'worst' ? ' · worst' : ''}
                    </td>
                    <td>{r.n}</td>
                    <td className="neg">{signedUsd(r.netUsd)}</td>
                    <td className="neg">{pp(r.roiPp)}</td>
                    <td>{fmtPct(r.winRate, 1)}</td>
                    <td>{r.meanAsk.toFixed(3)}</td>
                    <td>[{pp(r.ciPp[0])}, {pp(r.ciPp[1])}]</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      {/* confidence terciles — the monotone "higher confidence → less bad, never positive" read */}
      <div style={{ marginTop: '1.2rem' }}>
        <div className="cap">Forecast-confidence terciles (mode-bucket probability)</div>
        <div className="tbl-scroll" style={{ marginTop: '0.5rem' }}>
          <table>
            <thead>
              <tr><th>tercile</th><th>conf range</th><th>n</th><th>net</th><th>ROI</th><th>win rate</th></tr>
            </thead>
            <tbody>
              {CITY_SCAN_CONFIDENCE_TERCILES.map((t) => (
                <tr key={t.tercile}>
                  <td style={{ fontWeight: 700 }}>{t.tercile}</td>
                  <td className="mono">[{t.confRange[0].toFixed(3)}, {t.confRange[1].toFixed(3)}]</td>
                  <td>{t.n.toLocaleString('en-US')}</td>
                  <td className="neg">{signedUsd(t.netUsd)}</td>
                  <td className="neg">{pp(t.roiPp)}</td>
                  <td>{fmtPct(t.winRate, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: '0.4rem' }}>
          Higher forecast confidence is monotonically less bad (−37.9pp → −26.8pp → −22.2pp) but never
          pooled-positive — confidence sorts the losses, it doesn't produce an edge.
        </p>
      </div>

      {/* top-5 TRAIN -> TEST confirmation table */}
      <div style={{ marginTop: '1.2rem' }}>
        <div className="cap">Top-5 TRAIN cells (entry-watch shrinkage lower bound), confirmed on TEST only</div>
        <div className="tbl-scroll" style={{ marginTop: '0.5rem' }}>
          <table>
            <thead>
              <tr>
                <th>city</th><th>arm</th><th>TRAIN net</th><th>TRAIN LB</th><th>TEST net</th>
                <th>TEST win rate</th><th>TEST CI (day-clustered)</th><th>result</th>
              </tr>
            </thead>
            <tbody>
              {CITY_SCAN_TOP5_TRAIN_CELLS.map((c) => <CandidateRow key={`${c.city}-${c.arm}`} c={c} />)}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: '0.4rem' }}>
          Why both prongs matter: munich ranks <em>first</em> on TRAIN (+6.9pp LB) and then loses on TEST;
          helsinki posts a positive TEST net that does <em>not</em> count because it failed the TRAIN prong —
          selection and confirmation stay separate, in both directions.
        </p>
      </div>

      {/* caveats — rendered visibly, not hidden in a tooltip */}
      <div className="info-banner" style={{ marginTop: '1.1rem' }}>
        <strong>Read this before trusting the two candidates:</strong>
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
          {CITY_SCAN_CAVEATS.map((c, i) => (
            <li key={i} className="small" style={{ marginTop: i > 0 ? '0.4rem' : 0 }}>{c}</li>
          ))}
        </ul>
      </div>

      {/* methodology + run record + enrollment detail */}
      <details className="detail" style={{ marginTop: '0.9rem' }}>
        <summary>methodology, run record &amp; enrollment detail</summary>
        <div style={{ marginTop: '0.5rem' }}>
          <p className="small muted">
            <strong>Data:</strong> the local maker-exit cache ({CITY_SCAN_META.nEvents} events / {CITY_SCAN_META.nCities} cities
            / {CITY_SCAN_META.nDays} days of real tick series) joined against ONE {CITY_SCAN_META.nDbPullRows.toLocaleString('en-US')}-row
            point-in-time <code>bucket_probabilities</code> pull (latest house-calibrated build strictly before each bet's entry
            tick — no look-ahead). {CITY_SCAN_META.nCells.toLocaleString('en-US')} city×hour cells ={' '}
            {CITY_SCAN_META.nBets.toLocaleString('en-US')} bets + {CITY_SCAN_META.nSkips.toLocaleString('en-US')} skips
            (ask&gt;0.95: {CITY_SCAN_META.skipBreakdown.askTooHigh} · already resolved: {CITY_SCAN_META.skipBreakdown.alreadyResolved} ·
            no tick: {CITY_SCAN_META.skipBreakdown.noTick}). {CITY_SCAN_META.pctDbRecoveredForecast}% of bets used a genuine
            pre-entry forecast build; {CITY_SCAN_META.pctFrozenSeedFallback}% ({CITY_SCAN_META.nFallbackBets} bets) fell back to
            the cache's frozen seed — a look-ahead by construction, but measured 100% TRAIN-confined (the TEST holdout is clean)
            and conservative (every touched top-5 cell improves without its fallback bet).
          </p>
          <p className="small muted">
            <strong>Reproducibility:</strong> executed {CITY_SCAN_META.nIndependentRuns} times independently, bit-identical, plus{' '}
            {CITY_SCAN_META.nReviewLenses} adversarial review lens on the script's load-bearing paths (look-ahead strictness,
            split hygiene, entry-watch LB reuse, P&amp;L/bucket-index mapping). Source: <code>{CITY_SCAN_META.scriptPath}</code>,
            adjudicated against {CITY_SCAN_META.sourceDocs.join(' + ')}.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            <strong>Enrollment (executed):</strong>{' '}
            {CITY_SCAN_ENROLLMENT.map((e, i) => (
              <span key={e.city}>
                {i > 0 ? ' · ' : ''}
                <strong>{e.city}</strong> ({e.icao}, {e.tz}) — arms {e.armHours.join('/')}, forecast_max_hour {e.forecastMaxHour},
                active thru {e.activeUntil}; backfilled {e.backfillNGraded}/{e.backfillNBets} graded ({e.backfillFirstDate} →{' '}
                {e.backfillLastDate}){e.note ? ` — ${e.note}` : ''}
              </span>
            ))}
          </p>
        </div>
      </details>
    </section>
  );
}

export default async function PaperTradePage(): Promise<ReactElement> {
  const db = await serverDb();
  // The head-to-head (placed bets) + today's pre-placement forecast (N2) in one round of parallel reads.
  const [view, fcView]: [CitySimView | null, Awaited<ReturnType<typeof getCityForecast>>] = await Promise.all([
    getCitySim(db),
    getCityForecast(db),
  ]);
  // null-guarded: when the 0080 RPC is absent, forecasts stays null and the box ships its pre-N2 behaviour.
  const forecasts = fcView ? new Map(fcView.cities.map((c) => [c.slug, c])) : null;

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>Multi-city paper-trade</h1>
        <div className="info-banner">The paper-trade dashboard is not available yet (the dash_city_sim RPC is missing or errored).</div>
        <CityScanSection />
      </div>
    );
  }

  const overallPnl = num(view.overall?.pnl);
  const overallGraded = num(view.overall?.nGraded) ?? 0;
  const overallWon = num(view.overall?.nWon) ?? 0;

  return (
    <div className="ams-dash">
      <h1>Multi-city paper-trade</h1>
      <div className="info-banner">
        <strong>Systematic $10/day-per-arm paper-trade</strong> on our predicted whole-° bucket for the most
        forecast-accurate °C markets, scored against the real Polymarket book. Each city races its config arm
        hours (local), records the in-lock-hour odds, and grades to the resolved daily high. <strong>NOT
        trading</strong> — the analytics deliverable: it MEASURES whether a daily bet on our forecast nets a
        profit. Efficiency prior (FINDINGS.md) says the curves hug $0 net of fees; a sustained climb on any arm
        is the signal worth chasing.
        <div className="sub" style={{ marginTop: '0.4rem' }}>
          Combined net P&amp;L:{' '}
          <strong style={{ color: overallPnl != null && overallPnl >= 0 ? GREEN : RED }}>{signedUsd(overallPnl)}</strong>{' '}
          across {view.cities.length} cities · {overallGraded} graded bets · {overallWon} won ·{' '}
          generated {fmtStockholm(view.generatedAt)}
        </div>
      </div>

      <CurrentBetBox cities={view.cities} forecasts={forecasts} />

      {view.cities.length === 0 ? (
        <div className="info-banner">No active cities configured yet — add a city_sim_config row.</div>
      ) : (
        view.cities.map((c) => <CityPanel key={c.slug} city={c} />)
      )}

      <CityScanSection />
    </div>
  );
}
