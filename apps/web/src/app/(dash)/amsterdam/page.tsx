/**
 * /amsterdam — the Amsterdam paper-trade simulation (the analytics-pivot deliverable).
 *
 * Races $10/day of fictitious money on our predicted whole-°C bucket at four intraday lock hours
 * (13/14/15/16 local), under identical rules, and scores each against the real Polymarket Amsterdam
 * market (resolves to the WU EHAM daily high). The head-to-head answers "best time of day" empirically:
 * who gains the most after ~14 days. NOT trading — the model-vs-market insight value made tangible.
 */
import type { ReactElement } from 'react';
import { EquityChart, type EquitySeries } from '../../../components/EquityChart.tsx';
import { fmtDate, fmtPct, fmtProb, fmtTemp, fmtUsd, num } from '../../../lib/format.ts';
import { getAmsterdamSim } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const ARM_COLOR: Record<number, string> = {
  13: 'var(--amber)',
  14: 'var(--accent)',
  15: 'var(--green)',
  16: 'var(--red)',
};
const ARM_NOTE: Record<number, string> = {
  13: 'coin-flip, fat odds',
  14: 'some accuracy, real odds',
  15: 'confident sweet spot',
  16: 'near-certain, ~no payout',
};

const pnlClass = (v: unknown): string => ((num(v) ?? 0) >= 0 ? 'pos' : 'neg');
const statusChip = (status: string): ReactElement => {
  const cls = status === 'won' ? 'green' : status === 'lost' ? 'red' : 'amber';
  return <span className={`chip ${cls}`}>{status}</span>;
};

export default async function AmsterdamPage(): Promise<ReactElement> {
  const db = await serverDb();
  const view = await getAmsterdamSim(db);

  if (!view) {
    return (
      <div>
        <h1>Amsterdam — paper-trade simulation</h1>
        <p className="muted">
          The simulation isn&apos;t available yet (the <span className="mono">dash_amsterdam_sim</span> RPC is
          deploying). Refresh shortly.
        </p>
      </div>
    );
  }

  const { config, coverage, arms, leaderHour, chart, betLog, latest } = view;
  const nGradedDays = num(coverage.nGradedDays) ?? 0;
  const hasBets = (num(coverage.nDays) ?? 0) > 0;
  const leader = arms.find((a) => a.hour === leaderHour) ?? null;

  const series: EquitySeries[] = Object.keys(chart.byHour)
    .map(Number)
    .sort((a, b) => a - b)
    .map((h) => ({ label: `${h}:00`, color: ARM_COLOR[h] ?? 'var(--accent)', values: chart.byHour[h]! }));

  return (
    <div>
      <h1>
        Amsterdam — paper-trade simulation{' '}
        <span className="chip blue">EHAM · °C · fictitious</span>
      </h1>
      <p className="muted small">
        ${config.stakeUsd}/day on our predicted whole-°C bucket at {config.armHours.join(' / ')} local, same
        rules — racing to see which hour gains the most. Resolves to the Wunderground Schiphol daily high (the
        market&apos;s own truth). Insight value, <strong>not trading</strong>.
      </p>

      {!hasBets ? (
        <div className="panel">
          <p className="muted">
            No bets recorded yet. The daily job places the four arms once each afternoon&apos;s running max is
            known and grades them after the day resolves — the leaderboard and curve fill in from there.
          </p>
        </div>
      ) : null}

      {/* Leaderboard banner */}
      {leader ? (
        <div className={(num(leader.pnl) ?? 0) >= 0 ? 'ok-banner' : 'drift-banner'}>
          🥇 {leader.hour}:00 leads at {fmtUsd(leader.pnl)} net after {nGradedDays} graded day
          {nGradedDays === 1 ? '' : 's'}
          {nGradedDays < config.compareDays
            ? ` — ${config.compareDays - nGradedDays} more to the ${config.compareDays}-day verdict.`
            : ` — past the ${config.compareDays}-day mark.`}
        </div>
      ) : null}

      {/* Arm stat cards */}
      <div className="grid cols-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {arms.map((a) => (
          <div
            key={a.hour}
            className="panel"
            style={a.isLeader ? { borderColor: ARM_COLOR[a.hour] ?? 'var(--green)' } : undefined}
          >
            <div className="stat">
              <span className="label">
                <span className="swatch" style={{ background: ARM_COLOR[a.hour], display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 6 }} />
                {a.hour}:00 lock {a.isLeader ? <span className="chip green" style={{ marginLeft: 6 }}>leader</span> : null}
              </span>
              <span className={`value ${pnlClass(a.pnl)}`}>{fmtUsd(a.pnl)}</span>
            </div>
            <p className="muted small" style={{ margin: '0.4rem 0 0' }}>
              {ARM_NOTE[a.hour]}
              <br />
              ROI {fmtPct(a.roi)} · hit {fmtPct(a.hitRate)} · ask {fmtProb(a.avgAsk)}
              <br />
              {num(a.nGraded) ?? 0} graded · {num(a.nPending) ?? 0} pending · {num(a.nWon) ?? 0} won
            </p>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      <h2>Cumulative P&amp;L — who&apos;s winning</h2>
      <div className="panel">
        <EquityChart dates={chart.dates} series={series} />
        <div className="legend">
          {series.map((s) => (
            <span key={s.label}>
              <span className="swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <p className="muted small">
          Each line is one arm&apos;s running net P&amp;L ($10 staked per day, settled at the WU high). Flat-ish
          near $0 is the efficient-market null; a sustained climb is a real edge.
        </p>
      </div>

      {/* Best time of day — the evidence */}
      <h2>Best time of day — the evidence</h2>
      <div className="panel">
        <p className="muted small">
          The early arms lift the running-max floor to our lead-1 NWP forecast, corrected for its recent bias (the
          day&apos;s high can only finish above what&apos;s happened so far). On a walk-forward backtest over 69
          post-warmup test days the 13:00 exact-bucket hit rose ~42%→~62% and its error roughly halved (McNemar
          p=0.024 — significant; 14:00 is directional, p=0.33); 15:00/16:00 keep the floor (already 86%/92%, the
          forecast only adds noise there). Evidence is single-station, spring/summer only. The market still
          re-prices our bucket in lockstep (its ask ≈ our hit rate), so a better nowcast sharpens the call without
          necessarily paying more — the live race below is the real test.
        </p>
        <table style={{ width: 'auto' }}>
          <thead>
            <tr>
              <th>arm</th>
              <th className="num">hit rate</th>
              <th className="num">avg ask</th>
              <th className="num">edge (hit−ask)</th>
              <th className="num">net P&amp;L</th>
              <th className="num">graded</th>
            </tr>
          </thead>
          <tbody>
            {arms.map((a) => {
              const edge = num(a.hitRate) !== null && num(a.avgAsk) !== null ? num(a.hitRate)! - num(a.avgAsk)! : null;
              return (
                <tr key={a.hour}>
                  <td className="mono">{a.hour}:00</td>
                  <td className="num">{fmtPct(a.hitRate)}</td>
                  <td className="num">{fmtProb(a.avgAsk)}</td>
                  <td className={`num ${edge !== null && edge >= 0 ? 'pos' : 'neg'}`}>
                    {edge === null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(2)}`}
                  </td>
                  <td className={`num ${pnlClass(a.pnl)}`}>{fmtUsd(a.pnl)}</td>
                  <td className="num">{num(a.nGraded) ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Latest standing */}
      {latest.date ? (
        <>
          <h2>Latest call — {fmtDate(latest.date)}</h2>
          <div className="panel">
            <table style={{ width: 'auto' }}>
              <thead>
                <tr>
                  <th>arm</th>
                  <th className="num">running max</th>
                  <th className="num">forecast</th>
                  <th className="num">our bucket</th>
                  <th className="num">odds (ask)</th>
                  <th>status</th>
                  <th className="num">P&amp;L</th>
                  <th className="num">actual</th>
                </tr>
              </thead>
              <tbody>
                {config.armHours.map((h) => {
                  const r = latest.byHour[h];
                  if (!r) {
                    return (
                      <tr key={h}>
                        <td className="mono">{h}:00</td>
                        <td className="num" colSpan={7}>
                          <span className="muted">no bet</span>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={h}>
                      <td className="mono">{h}:00</td>
                      <td className="num">{fmtTemp(r.runMaxC, 'C')}</td>
                      <td className="num">{r.forecastC == null ? '—' : fmtTemp(r.forecastC, 'C')}</td>
                      <td className="num">{r.label ?? fmtTemp(r.predictedC, 'C')}</td>
                      <td className="num">{fmtProb(r.ask)}</td>
                      <td>{statusChip(r.status)}</td>
                      <td className={`num ${pnlClass(r.pnl)}`}>{r.status === 'pending' ? '—' : fmtUsd(r.pnl)}</td>
                      <td className="num">{r.actualC == null ? '—' : fmtTemp(r.actualC, 'C')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {/* Bet log */}
      <h2>Bet log</h2>
      <div className="panel">
        {betLog.length === 0 ? (
          <p className="muted">No bets yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>date</th>
                <th>arm</th>
                <th className="num">run max</th>
                <th className="num">forecast</th>
                <th className="num">our bucket</th>
                <th className="num">ask</th>
                <th>status</th>
                <th className="num">actual</th>
                <th className="num">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {betLog.map((b) => (
                <tr key={`${b.date}-${b.hour}`}>
                  <td>{fmtDate(b.date)}</td>
                  <td className="mono">{b.hour}:00</td>
                  <td className="num">{fmtTemp(b.runMaxC, 'C')}</td>
                  <td className="num">{b.forecastC == null ? '—' : fmtTemp(b.forecastC, 'C')}</td>
                  <td className="num">{b.label ?? fmtTemp(b.predictedC, 'C')}</td>
                  <td className="num">{fmtProb(b.ask)}</td>
                  <td>{statusChip(b.status)}</td>
                  <td className="num">{b.actualC == null ? '—' : fmtTemp(b.actualC, 'C')}</td>
                  <td className={`num ${pnlClass(b.pnl)}`}>{b.status === 'pending' ? '—' : fmtUsd(b.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
