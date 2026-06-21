/**
 * /amsterdam — the Amsterdam paper-trade simulation (the analytics-pivot deliverable).
 *
 * Races $10/day of fictitious money on our predicted whole-°C bucket at four intraday lock hours
 * (13/14/15/16 local), under identical rules, and scores each against the real Polymarket Amsterdam
 * market (resolves to the WU EHAM daily high). The head-to-head answers "best time of day" empirically:
 * who gains the most after ~14 days. NOT trading — the model-vs-market insight value made tangible.
 *
 * Layout (0046 redesign): a top DECISION STRIP answers the operator's at-a-glance questions — today's
 * predicted high, the live running max, tomorrow's prediction, the overall prediction rate, and the
 * provisional leader — then the hero chart + best-time recommendation, then the P&L surfaces, then the
 * verification depth folded behind "show detail" disclosures.
 */
import type { ReactElement } from 'react';
import { EquityChart, type EquitySeries } from '../../../components/EquityChart.tsx';
import { PeakHourChart } from '../../../components/PeakHourChart.tsx';
import { fmtDate, fmtPct, fmtProb, fmtTemp, fmtUsd, num } from '../../../lib/format.ts';
import { getAmsterdamSim } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const monthName = (m: number): string => MONTH_NAMES[m - 1] ?? '';

/**
 * Per-arm identity colour — a categorical ramp DISTINCT from the green/red P&L-sign colours (so a green
 * line never reads as "profitable" and a red line never as "losing"; arm identity and P&L sign are now
 * two separate visual channels). Paired with ARM_DASH for colour-blind safety in the equity chart.
 */
const ARM_COLOR: Record<number, string> = {
  13: 'var(--ams-arm-13)',
  14: 'var(--ams-arm-14)',
  15: 'var(--ams-arm-15)',
  16: 'var(--ams-arm-16)',
};
/** Per-arm line style so the equity curves are distinguishable without colour (WCAG). */
const ARM_DASH: Record<number, string> = {
  13: '',
  14: '5 3',
  15: '1 3',
  16: '7 3 1 3',
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
  return <span className={`chip ${cls}`} title={`bet ${status}`}>{status}</span>;
};

/** Floor-truth outcome marker: ✓ (hit floor of real high), ✗ (miss), or — when truth hasn't landed. */
const truthChip = (won: boolean | null): ReactElement =>
  won == null ? (
    <span className="muted" title="floor-truth not yet known">—</span>
  ) : (
    <span className={won ? 'pos' : 'neg'} title={won ? 'floor-truth hit' : 'floor-truth miss'}>{won ? '✓' : '✗'}</span>
  );

/** Below this many graded bets a CI is too wide to read — the arm is annotated "too few to call". */
const MIN_CREDIBLE_N = 10;

/** wuRound (round half away from zero) — mirrors @weather-edge/core units.wuRound for the displayed bucket. */
const roundC = (n: number): number => {
  const r = Math.sign(n) * Math.round(Math.abs(n));
  return r === 0 ? 0 : r;
};

/** A timestamptz → Europe/Amsterdam local 'HH:mm' (the station clock the running max is measured on). */
const amsTime = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }).format(d);
};

/** Signed fixed-dp value, '—' when absent. */
const fmtSigned = (v: unknown, dp = 2): string => {
  const n = num(v);
  return n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
};

/**
 * The honest "off zero?" verdict for a CI: 'pos' when the whole interval is above 0 (a real positive
 * edge), 'neg' when entirely below, else 'flat' (straddles 0 → indistinguishable from the efficient null).
 */
const ciVerdict = (lo: unknown, hi: unknown): 'pos' | 'neg' | 'flat' => {
  const l = num(lo);
  const h = num(hi);
  if (l === null || h === null) return 'flat';
  if (l > 0) return 'pos';
  if (h < 0) return 'neg';
  return 'flat';
};

/** A muted `[lo, hi]` 95% band, '—' when either bound is absent. */
const CiBand = ({ lo, hi, dp = 2, signed = false }: { lo: unknown; hi: unknown; dp?: number; signed?: boolean }): ReactElement => {
  const l = num(lo);
  const h = num(hi);
  if (l === null || h === null) return <span className="muted small">—</span>;
  const f = (x: number): string => (signed ? `${x >= 0 ? '+' : ''}${x.toFixed(dp)}` : x.toFixed(dp));
  return (
    <span className="muted small">
      [{f(l)}, {f(h)}]
    </span>
  );
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

  const {
    config, coverage, arms, leaderHour, chart, betLog, latest, truthCoverage, bestTime, peakHourChart,
    tomorrow, liveRunMax, overall,
  } = view;
  const hasTruth = (num(truthCoverage?.nBetsWithTruth) ?? 0) > 0;
  const nGradedDays = num(coverage.nGradedDays) ?? 0;
  const hasBets = (num(coverage.nDays) ?? 0) > 0;
  const leader = arms.find((a) => a.hour === leaderHour) ?? null;
  const worst = arms.length
    ? arms.reduce((a, b) => ((num(b.pnl) ?? 0) < (num(a.pnl) ?? 0) ? b : a))
    : null;

  const series: EquitySeries[] = Object.keys(chart.byHour)
    .map(Number)
    .sort((a, b) => a - b)
    .map((h) => ({ label: `${h}:00`, color: ARM_COLOR[h] ?? 'var(--ams-secondary)', dash: ARM_DASH[h], values: chart.byHour[h]! }));

  const rec = bestTime.recommendedHour;
  const pc = bestTime.headline.predictiveConfidence;
  const fc = bestTime.headline.floorConfidence;

  // ── decision-strip facts (0046) ──────────────────────────────────────────────────────────────────────
  // Today's predicted high = the de-biased lead-1 forecast carried on today's bets (one per-day scalar);
  // fall back to the running-max floor if no forecast was available for the day.
  const fcToday =
    num(latest.byHour[config.primaryHour]?.forecastC) ??
    config.armHours.map((h) => num(latest.byHour[h]?.forecastC)).find((x) => x != null) ??
    null;
  const runMaxToday = peakHourChart.todayRunMax.length
    ? Math.max(...peakHourChart.todayRunMax.map((p) => p.runMaxC))
    : null;
  const predictedHighC = fcToday ?? runMaxToday;
  const predictedHighBucket = predictedHighC == null ? null : roundC(predictedHighC);

  // Running max "now": the live intraday_max (0046) when present, else the last lock's frozen floor.
  const liveMaxC = num(liveRunMax?.maxTenthsC);
  const runNowC = liveMaxC ?? runMaxToday;

  // Tomorrow's prediction (0046).
  const tmrwFc = num(tomorrow?.forecastC);
  const tmrwPred = num(tomorrow?.predictedC);
  const tmrwAsk = num(tomorrow?.ask);

  return (
    <div className="ams-dash">
      <h1>
        Amsterdam — paper-trade simulation{' '}
        <span className="chip blue">EHAM · °C · fictitious</span>
      </h1>
      <p className="muted small">
        ${config.stakeUsd}/day on our predicted whole-°C bucket at {config.armHours.join(' / ')} local, same
        rules — racing to see which hour gains the most. Resolves to the Wunderground Schiphol daily high (the
        market&apos;s own truth). Insight value, <strong>not trading</strong>.
      </p>

      {/* ── Decision strip: the at-a-glance answers (0046) ──────────────────────────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Today&apos;s predicted high</span>
            {latest.date ? <span className="cap" style={{ color: 'var(--ams-secondary)' }}>{fmtDate(latest.date)}</span> : null}
          </div>
          <div className="big sky">{predictedHighBucket == null ? '—' : `${predictedHighBucket}°`}</div>
          <div className="sub">
            {fcToday != null ? `debiased NWP forecast ${fcToday.toFixed(1)}°C` : 'from the running-max floor'}
          </div>
        </div>

        <div className="tile">
          <div className="tile-head">
            <span className="cap">Running max now</span>
            {liveRunMax ? <span className="cap" style={{ color: 'var(--ams-secondary)' }}>live</span> : null}
          </div>
          <div className="big sky">
            {runNowC == null ? '—' : liveMaxC != null ? `${liveMaxC.toFixed(1)}°` : `${roundC(runNowC)}°`}
          </div>
          <div className="sub">
            {liveRunMax
              ? `as of ${amsTime(liveRunMax.lastObsAt)} local · ${num(liveRunMax.nObs) ?? 0} obs · max usually ~${bestTime.medianPeakHour}:00`
              : runMaxToday != null
                ? `floor at last lock · max usually lands ~${bestTime.medianPeakHour}:00`
                : 'no observations yet today'}
          </div>
        </div>

        <div className="tile">
          <div className="tile-head">
            <span className="cap">Tomorrow{tomorrow?.targetDate ? ` · ${fmtDate(tomorrow.targetDate)}` : ''}</span>
            <span className="pill">forecast</span>
          </div>
          <div className="big violet">{tmrwPred == null ? '—' : `${tmrwPred}°`}</div>
          <div className="sub">
            {tmrwFc != null
              ? `${tomorrow?.biasCorrected ? 'debiased' : 'raw'} NWP ${tmrwFc.toFixed(1)}°C${tmrwAsk != null ? ` · ask ${fmtProb(tmrwAsk)}` : ''}${rec != null ? ` · lock ${rec}:00` : ''}`
              : tomorrow == null
                ? 'lights up with the 0046 deploy'
                : 'no NWP capture for tomorrow yet'}
          </div>
        </div>

        <div className="tile">
          <div className="tile-head">
            <span className="cap">Overall prediction rate</span>
          </div>
          <div className="big">{overall.marketHitRate == null ? '—' : fmtPct(overall.marketHitRate, 0)}</div>
          <div className="sub">
            {overall.nGradedAll} graded · floor-truth{' '}
            {overall.truthHitRate == null ? '—' : fmtPct(overall.truthHitRate, 0)} ({overall.nTruthAll})
          </div>
        </div>

        <div className="tile">
          <div className="tile-head">
            <span className="cap">Paper-trade leader</span>
            <span className="chip soft" title="small sample — not yet decisive">provisional</span>
          </div>
          <div className={`big ${leader ? pnlClass(leader.pnl) : ''}`}>{leader ? fmtUsd(leader.pnl) : '—'}</div>
          <div className="sub">{leader ? `${leader.hour}:00 best of 4 arms · n=${nGradedDays}` : 'no graded bets yet'}</div>
        </div>
      </div>

      {/* ── Hero bento: real-time-vs-climatology chart + best-time tiles ────────────────────────────── */}
      <div className="bento">
        <div className="glass hero">
          <div className="tile-head">
            <span className="cap">
              Real-time vs 20-year average · {monthName(peakHourChart.month)}
              {peakHourChart.hot ? ' · hot-day peak timing' : ''}
            </span>
            <span className="cap" style={{ color: 'var(--ams-secondary-dim)' }}>
              Schiphol · KNMI 240 · {bestTime.medianPeakHour}:00 median peak
            </span>
          </div>
          <PeakHourChart data={peakHourChart} />
          <div className="chart-legend">
            <span>
              <i className="ln solid" /> {peakHourChart.latestDate ? `latest (${fmtDate(peakHourChart.latestDate)})` : 'latest'} running max
            </span>
            <span>
              <i className="ln dash" /> 20-yr avg temp (monthly)
            </span>
            <span>
              <i className="ln dot" /> 20-yr avg running max (monthly)
            </span>
            <span>
              <i className="sw" style={{ background: 'var(--ams-secondary-dim)', opacity: 0.4 }} /> peak-hour distribution
            </span>
            <span>
              <i className="sw" /> peak window {peakHourChart.peakWindow.fromHour}:00–{peakHourChart.peakWindow.toHour}:00
            </span>
            {rec != null ? (
              <span style={{ color: 'var(--ams-amber)' }}>
                <i className="ln dash" style={{ borderColor: 'var(--ams-amber)' }} /> recommended lock {rec}:00
              </span>
            ) : null}
          </div>
        </div>

        <div className="metric-col">
          <div className="tile rec">
            <div className="tile-head">
              <span className="cap">Best time to bet</span>
              <span className="pill">model</span>
            </div>
            <div className="big amber">{rec == null ? '—' : `${rec}:00`}</div>
            <div className="sub">{bestTime.rationale}</div>
          </div>

          {/* predictive confidence + its floor-locked input, shown as one parent→child tile */}
          <div className="tile">
            <div className="tile-head">
              <span className="cap">Predictive confidence</span>
              <span className="cap" style={{ color: 'var(--ams-secondary)' }}>{rec == null ? '' : `@ ${rec}:00`}</span>
            </div>
            <div className="big">{pc == null ? '—' : fmtPct(pc, 0)}</div>
            <div className="meter">
              <span className="glow" style={{ width: `${Math.round((pc ?? 0) * 100)}%` }} />
            </div>
            <div className="sub">
              = floor-locked <strong style={{ color: 'var(--ams-tertiary)' }}>{fc == null ? '—' : fmtPct(fc, 0)}</strong>{' '}
              (P(≤0.5°C left to climb)) × prediction accuracy, shrunk to the climatology prior.{' '}
              {peakHourChart.hot ? '≥25°C hot-day' : `${monthName(peakHourChart.month)}`} climatology.
            </div>
          </div>
        </div>
      </div>

      {/* ── Best time to bet — the accuracy × peak-hour fusion, per lock hour ─────────────────────────── */}
      <h2>Best time to bet — accuracy × peak hour</h2>
      <div className="panel">
        <p className="muted small">
          Two independent things decide a fixed-stake bucket bet: whether the day still climbs past our bucket
          after we lock (<strong>floor confidence</strong>, from 20 years of KNMI Schiphol hourly data), and
          whether our call is right given the floor (<strong>prediction accuracy</strong>, the graded paper
          bets). <span className="mono">Predictive confidence</span> fuses them; the recommendation maximises{' '}
          <span className="mono">predictive&nbsp;conf / ask − 1</span> among floor-locked hours.
        </p>
        <div className="tbl-scroll">
          <table style={{ width: 'auto' }}>
            <thead>
              <tr>
                <th>lock</th>
                <th className="num">peaked by</th>
                <th className="num">floor conf</th>
                <th className="num">avg upside</th>
                <th className="num">model hit</th>
                <th className="num">predictive conf</th>
                <th className="num">avg ask</th>
                <th className="num">blended EV/$1</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bestTime.rows.map((r) => {
                const ev = r.evBlended;
                const evCls = ev == null ? '' : ev > 0 ? 'pos' : ev < 0 ? 'neg' : '';
                return (
                  <tr key={r.hour} className={r.recommended ? 'rec-row' : undefined}>
                    <td className="mono">{r.hour}:00</td>
                    <td className="num">{fmtPct(r.peakedPct, 0)}</td>
                    <td className="num">{fmtPct(r.floorConfidence, 0)}</td>
                    <td className="num">{r.meanUpsideC.toFixed(1)}°C</td>
                    <td className="num">
                      {r.empiricalHitRate == null ? <span className="muted">prior</span> : fmtPct(r.empiricalHitRate, 0)}
                      {r.nGraded > 0 ? <span className="muted small"> · {r.nGraded}n</span> : null}
                    </td>
                    <td className="num">{fmtPct(r.predictiveConfidence, 0)}</td>
                    <td className="num">{r.avgAsk == null ? '—' : fmtProb(r.avgAsk)}</td>
                    <td className={`num ${evCls}`}>{ev == null ? '—' : `${ev >= 0 ? '+' : ''}${ev.toFixed(2)}`}</td>
                    <td>{r.recommended ? <span className="pill">bet</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <details className="detail">
          <summary>How the best-time model works</summary>
          <p className="muted small">
            <strong>floor conf</strong> = P(remaining warming ≤ 0.5°C) — the running-max floor is essentially the
            day&apos;s high. <strong>avg upside</strong> = mean °C the floor can still rise after that hour.{' '}
            <strong>model hit</strong> is the empirical market hit rate (or the climatology prior before enough
            graded bets). <span className="mono">Predictive confidence</span> is the empirical hit rate shrunk
            toward a structural prior (floor confidence × baseline skill), so early on it leans on the climatology
            and tightens as bets accumulate. Hot days peak ~1h later, so on a forecast-hot day the safe hour
            shifts toward 16:00–17:00 — the table switches climatologies automatically. A decision aid,{' '}
            <strong>not</strong> a calibrated probability.
          </p>
        </details>
      </div>

      {/* Reconciliation: why the model rec can differ from the realised leader (the page's #1 confusion) */}
      {rec != null && leaderHour != null && rec !== leaderHour ? (
        <div className="info-banner">
          <strong>Why &ldquo;bet {rec}:00&rdquo; when {leaderHour}:00 is winning?</strong> The model recommends the
          hour with the best win-probability per unit cost ({rec}:00 — floor near-locked, odds still pay), while
          the leaderboard is the small-sample realised P&amp;L so far ({leaderHour}:00, n={nGradedDays} — too few
          to trust). They measure different things and converge as bets accumulate; until n≥{MIN_CREDIBLE_N} treat
          the leaderboard as provisional.
        </div>
      ) : null}

      {!hasBets ? (
        <div className="panel">
          <p className="muted">
            No bets recorded yet. The daily job places the four arms once each afternoon&apos;s running max is
            known and grades them after the day resolves — the leaderboard and curve fill in from there.
          </p>
        </div>
      ) : null}

      {/* Leaderboard banner — neutral spread summary (status, not pass/fail) */}
      {leader ? (
        <div className="info-banner">
          🥇 {leader.hour}:00 leads at {fmtUsd(leader.pnl)}
          {worst && worst.hour !== leader.hour ? ` · ${worst.hour}:00 trails at ${fmtUsd(worst.pnl)}` : ''} ·{' '}
          {nGradedDays} graded day{nGradedDays === 1 ? '' : 's'}
          {nGradedDays < config.compareDays
            ? `, provisional until ${config.compareDays}`
            : `, past the ${config.compareDays}-day mark`}.
        </div>
      ) : null}

      {/* Arm stat cards — the per-arm P&L at a glance */}
      <div className="grid cols-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {arms.map((a) => (
          <div
            key={a.hour}
            className="panel"
            style={a.isLeader ? { borderColor: ARM_COLOR[a.hour] ?? 'var(--ams-amber)' } : undefined}
          >
            <div className="stat">
              <span className="label">
                <span className="swatch" style={{ background: ARM_COLOR[a.hour], display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 6 }} />
                {a.hour}:00 lock {a.isLeader ? <span className="chip soft" style={{ marginLeft: 6 }}>leader</span> : null}
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

      {/* Today's per-arm call */}
      {latest.date ? (
        <>
          <h2>Latest call — {fmtDate(latest.date)}</h2>
          <div className="panel">
            <div className="tbl-scroll">
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
                    <th className="num">actual (mkt)</th>
                    <th className="num">real high</th>
                    <th className="num">err</th>
                    <th className="num">truth</th>
                  </tr>
                </thead>
                <tbody>
                  {config.armHours.map((h) => {
                    const r = latest.byHour[h];
                    if (!r) {
                      return (
                        <tr key={h}>
                          <td className="mono">{h}:00</td>
                          <td className="num" colSpan={10}>
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
                        <td className="num">{num(r.actualDecimalC) === null ? '—' : `${num(r.actualDecimalC)!.toFixed(1)}°`}</td>
                        <td className="num">{fmtSigned(r.signedErrorC)}</td>
                        <td className="num">{truthChip(r.truthWon)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      {/* ── Verification depth — folded behind disclosures so the decision surface stays scannable ────── */}
      <h2>Verification &amp; history</h2>
      <div className="panel">
        {/* Best time of day — the evidence, with 95% confidence intervals */}
        <details className="detail">
          <summary>Best time of day — the evidence (hit / edge / EV with 95% CIs)</summary>
          <p className="muted small">
            The early arms lift the running-max floor to our lead-1 NWP forecast, corrected for its recent bias (the
            day&apos;s high can only finish above what&apos;s happened so far). On a walk-forward backtest over 69
            post-warmup test days the 13:00 exact-bucket hit rose ~42%→~62% and its error roughly halved (McNemar
            p=0.024 — significant; 14:00 is directional, p=0.33); 15:00/16:00 keep the floor (already 86%/92%, the
            forecast only adds noise there). An arm only shows a <span className="pos">real edge</span> once its
            whole interval clears zero; while a CI straddles 0 it is{' '}
            <span className="muted">indistinguishable from the efficient market</span> (the WO-5 prior). Arms with
            fewer than {MIN_CREDIBLE_N} graded bets are greyed — too few to call. Single-station, spring/summer only.
          </p>
          <div className="tbl-scroll">
            <table style={{ width: 'auto' }}>
              <thead>
                <tr>
                  <th>arm</th>
                  <th className="num">hit rate (95% CI)</th>
                  <th className="num">avg ask</th>
                  <th className="num">edge = hit−ask (95% CI)</th>
                  <th className="num">EV/$1 (95% CI)</th>
                  <th className="num">net P&amp;L</th>
                  <th className="num">graded</th>
                </tr>
              </thead>
              <tbody>
                {arms.map((a) => {
                  const n = num(a.nGraded) ?? 0;
                  const thin = n < MIN_CREDIBLE_N;
                  const edgeV = ciVerdict(a.edgeCiLo, a.edgeCiHi);
                  const evV = ciVerdict(a.evCiLo, a.evCiHi);
                  return (
                    <tr key={a.hour} style={thin ? { opacity: 0.55 } : undefined}>
                      <td className="mono">
                        {a.hour}:00
                        {a.isLeader ? <span className="chip soft" style={{ marginLeft: 6 }}>leader</span> : null}
                      </td>
                      <td className="num">
                        {fmtPct(a.hitRate)}
                        <br />
                        <CiBand lo={num(a.hitCiLo) === null ? null : num(a.hitCiLo)! * 100} hi={num(a.hitCiHi) === null ? null : num(a.hitCiHi)! * 100} dp={0} />
                      </td>
                      <td className="num">{fmtProb(a.avgAsk)}</td>
                      <td className={`num ${edgeV === 'flat' ? '' : edgeV}`}>
                        {fmtSigned(a.edge)}
                        <br />
                        <CiBand lo={a.edgeCiLo} hi={a.edgeCiHi} signed />
                      </td>
                      <td className={`num ${evV === 'flat' ? '' : evV}`}>
                        {fmtSigned(a.ev)}
                        <br />
                        <CiBand lo={a.evCiLo} hi={a.evCiHi} signed />
                      </td>
                      <td className={`num ${pnlClass(a.pnl)}`}>{fmtUsd(a.pnl)}</td>
                      <td className="num">
                        {n}
                        {thin ? <><br /><span className="muted small">too few</span></> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>

        {/* Floor "truth accuracy" — the forecast-skill lens vs the REAL decimal high (KNMI) */}
        <details className="detail">
          <summary>
            Floor truth accuracy — vs the real KNMI high
            {truthCoverage?.tableNDays ? ` (${num(truthCoverage.tableNDays)} days)` : ''}
          </summary>
          <p className="muted small">
            A cleaner <strong>forecast-skill</strong> lens than the market: did our whole-°C call equal the integer{' '}
            <span className="mono">floor</span> of the <em>real</em> Schiphol daily high, measured to 0.1°C by{' '}
            <strong>KNMI</strong> (station 240, variable TX)? <span className="mono">MAE</span> /{' '}
            <span className="mono">bias</span> are the signed error of our continuous nowcast at decimal resolution
            — positive bias = we ran hot. The market-hit column (greyed) is repeated for contrast; it stays the
            number that drives P&amp;L.
            {truthCoverage?.tableNDays
              ? ` KNMI truth spans ${num(truthCoverage.tableNDays)} day${num(truthCoverage.tableNDays) === 1 ? '' : 's'}${
                  truthCoverage.tableFirstDate && truthCoverage.tableLastDate
                    ? ` (${fmtDate(truthCoverage.tableFirstDate)} → ${fmtDate(truthCoverage.tableLastDate)})`
                    : ''
                }.`
              : ''}
          </p>
          {!hasTruth ? (
            <p className="muted">
              No floor-truth filled yet — run <span className="mono">pnpm tsx scripts/amsterdam-truth-backfill.ts</span>{' '}
              (and apply migration <span className="mono">0043</span>) to backfill the KNMI decimal high.
            </p>
          ) : (
            <div className="tbl-scroll">
              <table style={{ width: 'auto' }}>
                <thead>
                  <tr>
                    <th>arm</th>
                    <th className="num">floor-hit (95% CI)</th>
                    <th className="num">market-hit</th>
                    <th className="num">MAE (°C)</th>
                    <th className="num">bias (95% CI)</th>
                    <th className="num">truth n</th>
                  </tr>
                </thead>
                <tbody>
                  {arms.map((a) => {
                    const n = num(a.nTruth) ?? 0;
                    const thin = n < MIN_CREDIBLE_N;
                    return (
                      <tr key={a.hour} style={thin ? { opacity: 0.55 } : undefined}>
                        <td className="mono">
                          {a.hour}:00
                          {a.isLeader ? <span className="chip soft" style={{ marginLeft: 6 }}>leader</span> : null}
                        </td>
                        <td className="num">
                          {fmtPct(a.truthHitRate)}
                          <br />
                          <CiBand
                            lo={num(a.truthHitCiLo) === null ? null : num(a.truthHitCiLo)! * 100}
                            hi={num(a.truthHitCiHi) === null ? null : num(a.truthHitCiHi)! * 100}
                            dp={0}
                          />
                        </td>
                        <td className="num muted">{fmtPct(a.hitRate)}</td>
                        <td className="num">{num(a.mae) === null ? '—' : `${num(a.mae)!.toFixed(2)}`}</td>
                        <td className="num">
                          {fmtSigned(a.bias)}
                          <br />
                          <CiBand lo={a.biasCiLo} hi={a.biasCiHi} signed />
                        </td>
                        <td className="num">
                          {n}
                          {thin ? <><br /><span className="muted small">too few</span></> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </details>

        {/* Full bet log */}
        <details className="detail">
          <summary>Full bet log{betLog.length ? ` (${betLog.length} bets)` : ''}</summary>
          {betLog.length === 0 ? (
            <p className="muted">No bets yet.</p>
          ) : (
            <div className="tbl-scroll">
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
                    <th className="num">actual (mkt)</th>
                    <th className="num">real high</th>
                    <th className="num">err</th>
                    <th className="num">truth</th>
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
                      <td className="num">{num(b.actualDecimalC) === null ? '—' : `${num(b.actualDecimalC)!.toFixed(1)}°`}</td>
                      <td className="num">{fmtSigned(b.signedErrorC)}</td>
                      <td className="num">{truthChip(b.truthWon)}</td>
                      <td className={`num ${pnlClass(b.pnl)}`}>{b.status === 'pending' ? '—' : fmtUsd(b.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </div>
    </div>
  );
}
