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
import { EquityChart, type EquitySeries } from '../../../components/EquityChart.tsx';
import { fmtDate, fmtDateTime, fmtPct, fmtUsd, num } from '../../../lib/format.ts';
import { type CitySimCity, type CitySimView, getCitySim } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
// Arms are coloured by POSITION (not absolute hour, since cities race different hours) on the categorical ramp.
const ARM_PALETTE = ['var(--ams-arm-13)', 'var(--ams-arm-14)', 'var(--ams-arm-15)', 'var(--ams-arm-16)'];
const ARM_DASH = [undefined, '5 3', '2 3', '7 3 2 3'];

const signedUsd = (v: number | null, dp = 2): string =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v), dp)}`;
const pnlClass = (v: number | null): string => (v == null ? '' : v >= 0 ? 'pos' : 'neg');

/** One city's section: standings tiles, the arm leaderboard, the equity chart, today's call, the bet log. */
function CityPanel({ city }: { city: CitySimCity }): ReactElement {
  const totalPnl = num(city.totals?.pnl);
  const nGraded = num(city.totals?.nGraded) ?? 0;
  const nWon = num(city.totals?.nWon) ?? 0;
  const nDays = num(city.coverage?.nDays) ?? 0;
  const nGradedDays = num(city.coverage?.nGradedDays) ?? 0;
  const nPending = num(city.coverage?.nPending) ?? 0;
  const armColor = (h: number): string => ARM_PALETTE[Math.max(0, city.armHours.indexOf(h)) % ARM_PALETTE.length]!;

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
        <span className="cap muted">{city.unit}° · {city.tz} · arms {city.armHours.join('/')} · ${num(city.stakeUsd) ?? 10}/day</span>
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
          <div className="sub">{city.leaderHour != null ? `best of ${city.armHours.length} arms` : 'no graded bets yet'}</div>
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
                <tr key={a.hour} className={a.isLeader ? 'rec-row' : undefined}>
                  <td style={{ color: armColor(a.hour), fontWeight: 700 }}>{a.hour}:00{a.isLeader ? ' 🥇' : ''}</td>
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

export default async function PaperTradePage(): Promise<ReactElement> {
  const view: CitySimView | null = await getCitySim(serverDb());

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>Multi-city paper-trade</h1>
        <div className="info-banner">The paper-trade dashboard is not available yet (the dash_city_sim RPC is missing or errored).</div>
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
          generated {fmtDateTime(view.generatedAt)}
        </div>
      </div>

      {view.cities.length === 0 ? (
        <div className="info-banner">No active cities configured yet — add a city_sim_config row.</div>
      ) : (
        view.cities.map((c) => <CityPanel key={c.slug} city={c} />)
      )}
    </div>
  );
}
