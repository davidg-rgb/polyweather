/**
 * /paper-trade — the PER-CITY "$10 on our predicted high, bought CHEAP, held to close" table.
 *
 * Operator ask (2026-07-09): replace the multi-city arms-race with a table of ALL cities. For each city, place
 * a fictive $10 bet on OUR predicted daily-high bucket, but only enter while it is still cheap (ask ≤ 15¢ =
 * "high return potential"), at the confidence sweet-spot (the entry lead that maximizes the day-clustered lower
 * bound), held to resolution; log per city: bets, days active, win%, avg entry price, net P&L, ROI.
 *
 * HONESTY: this IS signal #12 (opening-convergence), already falsified (FINDINGS.md / MARKET-PNL.md). The
 * cheap-entry filter buys the predicted bucket only while it is still a not-yet-converged LONGSHOT; at the
 * executable ask, held to resolution, it LOSES at every entry lead (pooled −28% at the 24h sweet-spot). The
 * market prices our bucket ≤15¢ EXACTLY when it is unlikely to win. This page renders that truth per city
 * from the committed archive-backtest asset (core/sim/city-buy-table-results.ts) — server-side, no DB round
 * trip, no client fetch — NOT to resurrect the signal. The 45-City Scan below is the pre-registered TRAIN/TEST
 * cut of the same question.
 */
import type { ReactElement } from 'react';
import {
  CITY_BUY_TABLE,
  CITY_SCAN_ASK_SPLIT,
  CITY_SCAN_CAVEATS,
  CITY_SCAN_CONFIDENCE_TERCILES,
  CITY_SCAN_CONFIRMATION_CLOCK,
  CITY_SCAN_ENROLLMENT,
  CITY_SCAN_META,
  CITY_SCAN_POOLED_CURVE,
  CITY_SCAN_TOP5_TRAIN_CELLS,
  type CityBuyLeadPoint,
  type CityBuyRow,
  type CityScanCandidate,
} from '@weather-edge/core';
import { fmtDate, fmtDelta, fmtPct, fmtUsd, num } from '../../../lib/format.ts';

// The (dash) layout is operator-gated (reads cookies → dynamic); this page's data is a committed static asset,
// so it renders instantly, but we keep the route dynamic to match the gated layout (no static-prerender conflict).
export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';

const signedUsd = (v: number | null, dp = 2): string =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v), dp)}`;
const pnlClass = (v: number | null): string => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
/** percentage-point value, signed: pp(3.6) = '+3.6pp', pp(-11.4) = '-11.4pp'. */
const pp = (v: number | null): string => (v == null ? '—' : `${fmtDelta(v, 1)}pp`);
/** cents from a fraction: cents(0.062) = '6.2¢'. */
const cents = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(1)}¢`);

const B = CITY_BUY_TABLE;

/* ── the lead-curve "peak-time" hero: ROI at each entry lead, negative at every one, worse near close ──── */
function LeadCurveChart({ width = 560, height = 220 }: { width?: number; height?: number }): ReactElement {
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const yMax = 15;
  const yMin = -105;
  const yAt = (v: number): number => padT + ((yMax - v) / (yMax - yMin)) * plotH;
  const zeroY = yAt(0);
  // far → near (48h..6h) left → right, so the eye reads "as we approach market close".
  const pts = B.leadCurve;
  const n = pts.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.44, 46);
  const xC = (i: number): number => padL + slot * (i + 0.5);
  const grid = [0, -25, -50, -75, -100];
  const worst = pts.reduce((a, b) => (b.roiPct < a.roiPct ? b : a));
  const ariaLabel =
    `Pooled ROI of the cheap-entry (≤${cents(B.params.cheapMax)}) predicted-bucket bet, by entry lead: ` +
    pts.map((p) => `${p.leadH}h ${pp(p.roiPct)}`).join(', ') +
    `. Negative at every lead and worst nearest close (${worst.leadH}h, ${pp(worst.roiPct)}). Whiskers are day-clustered CIs.`;

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
            {g === 0 ? '0' : `${g}`}
          </text>
        </g>
      ))}
      {pts.map((r, i) => {
        const isSweet = r.leadH === B.params.sweetLeadH;
        const barH = Math.max(zeroY - yAt(r.roiPct), 1.5); // all negative → bars hang below zero
        return (
          <g key={r.leadH}>
            <line x1={xC(i)} x2={xC(i)} y1={yAt(r.ciPct[1])} y2={yAt(r.ciPct[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yAt(r.ciPct[1])} y2={yAt(r.ciPct[1])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yAt(r.ciPct[0])} y2={yAt(r.ciPct[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <rect x={xC(i) - barW / 2} y={zeroY} width={barW} height={barH} rx={3} fill={isSweet ? AMBER : RED} opacity={isSweet ? 0.9 : 0.55}>
              <title>{`${r.leadH}h before close — ROI ${pp(r.roiPct)} · n=${r.bets} · win ${r.winPct}% · mean ask ${cents(r.avgAsk)} · CI [${pp(r.ciPct[0])}, ${pp(r.ciPct[1])}]`}</title>
            </rect>
            <text x={xC(i)} y={yAt(r.roiPct) + 12} textAnchor="middle" fontSize={9} fontWeight={isSweet ? 700 : 400} fill={isSweet ? AMBER : RED} className="mono">
              {pp(r.roiPct)}
            </text>
            <text x={xC(i)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--ams-muted)" className="mono">
              {r.leadH}h{isSweet ? ' ★' : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── per-city lead sparkline: net P&L by entry lead (48/24/12/6h), zero-centered, green up / red down ──── */
function LeadSparkline({ leadNet }: { leadNet: Record<string, number> }): ReactElement {
  const order = B.params.leadsH.map(String);
  const vals = order.map((k) => (k in leadNet ? leadNet[k]! : null));
  const w = 66;
  const h = 22;
  const cap = 300; // clamp so a single fat longshot doesn't flatten every other bar
  const bw = w / order.length;
  const mid = h / 2;
  const yFor = (v: number): number => (Math.max(-cap, Math.min(cap, v)) / cap) * (mid - 1.5);
  const title = order.map((k, i) => `${k}h ${vals[i] == null ? '—' : signedUsd(vals[i], 0)}`).join(' · ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`net by lead — ${title}`}>
      <title>{`net P&L by entry lead — ${title}`}</title>
      <line x1={0} x2={w} y1={mid} y2={mid} stroke="var(--ams-grid)" strokeWidth={1} />
      {vals.map((v, i) => {
        if (v == null) return null;
        const dy = yFor(v);
        const y = v >= 0 ? mid - dy : mid;
        return (
          <rect
            key={order[i]}
            x={i * bw + 1.5}
            y={y}
            width={bw - 3}
            height={Math.max(Math.abs(dy), 1)}
            rx={1}
            fill={v >= 0 ? GREEN : RED}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}

/* ── one per-city row ──────────────────────────────────────────────────────────────────────────────────── */
function CityRow({ r }: { r: CityBuyRow }): ReactElement {
  return (
    <tr>
      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
        {r.display}
        <span className="cap muted" style={{ marginLeft: '0.4rem' }}>{r.icao}</span>
      </td>
      <td>{r.daysActive}</td>
      <td>{r.bets}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {r.winPct.toFixed(1)}%
        <span className="cap muted"> ({r.won}/{r.bets})</span>
      </td>
      <td className="mono">{cents(r.avgAsk)}</td>
      <td>{fmtUsd(r.staked, 0)}</td>
      <td className={pnlClass(r.netUsd)} style={{ fontWeight: 700 }}>{signedUsd(r.netUsd)}</td>
      <td className={pnlClass(r.roiPct)}>{pp(r.roiPct)}</td>
      <td style={{ lineHeight: 0 }}><LeadSparkline leadNet={r.leadNet} /></td>
    </tr>
  );
}

/* ── the per-city buy table (the deliverable) ──────────────────────────────────────────────────────────── */
function BuyTableSection(): ReactElement {
  const pooled = B.pooled;
  const roiNeg = pooled.roiPct < 0;
  const breakeven = pooled.avgAsk * 100; // win rate needed just to break even at the mid entry price
  const sweetLead = B.leadCurve.find((l) => l.leadH === B.params.sweetLeadH);

  return (
    <>
      <h1>Per-city buy table — $10 on our predicted high, bought cheap</h1>

      {/* the honest verdict, leading with the number */}
      <div className="info-banner" style={{ borderLeftColor: RED }}>
        <strong style={{ color: RED }}>Verdict: a net loss — pooled ROI {pp(pooled.roiPct)}</strong>{' '}
        ({signedUsd(pooled.netUsd, 0)} on {pooled.bets} bets · {B.universe.nDays} days · {B.universe.nCities} cities,
        day-clustered CI [{pp(pooled.dayCiPct[0])}, {pp(pooled.dayCiPct[1])}]). This is the strategy you described —
        $10 on our predicted whole-° bucket, entered only while it is still <strong>cheap (ask ≤ {cents(B.params.cheapMax)})</strong>,
        at the confidence sweet-spot ({B.params.sweetLeadH}h before close), held to resolution — scored across every
        city on the real price archive at the <strong>executable ask</strong>. It is <strong>signal #12
        (opening-convergence), already falsified</strong> (FINDINGS.md / MARKET-PNL.md): the cheap filter buys the
        bucket only while it is still a <strong>not-yet-converged longshot</strong>, and the market prices it
        ≤{cents(B.params.cheapMax)} <em>exactly when it is unlikely to win</em> — pooled win rate {pooled.winPct}% vs
        the ~{breakeven.toFixed(0)}% you need just to break even. The {pooled.nCitiesPositive} net-positive cities are
        small-sample longshot noise (Jeddah went 2-for-2 → +1209%), not a per-city edge. <strong>Nothing here reopens
        the trading rail.</strong>
      </div>

      {/* summary strip */}
      <div className="strip" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.8rem' }}>
        <div className="tile">
          <div className="cap">Net P&amp;L (pooled)</div>
          <div className={`big ${roiNeg ? 'neg' : 'pos'}`}>{signedUsd(pooled.netUsd, 0)}</div>
          <div className="sub">on {fmtUsd(pooled.bets * B.params.stake, 0)} staked · {pooled.bets} bets</div>
        </div>
        <div className="tile">
          <div className="cap">ROI · day-clustered CI</div>
          <div className={`big ${roiNeg ? 'neg' : 'pos'}`}>{pp(pooled.roiPct)}</div>
          <div className="sub">[{pp(pooled.dayCiPct[0])}, {pp(pooled.dayCiPct[1])}]</div>
        </div>
        <div className="tile">
          <div className="cap">Win rate vs breakeven</div>
          <div className="big" style={{ fontSize: '1.4rem' }}>
            {pooled.winPct}% <span className="muted" style={{ fontSize: '0.9rem' }}>/ {breakeven.toFixed(0)}%</span>
          </div>
          <div className="sub">avg entry {cents(pooled.avgAsk)} · {pooled.won} won</div>
        </div>
        <div className="tile">
          <div className="cap">Cities net-positive</div>
          <div className="big sky">{pooled.nCitiesPositive}<span className="muted" style={{ fontSize: '0.9rem' }}> / {B.universe.nCities}</span></div>
          <div className="sub">small-sample longshot noise</div>
        </div>
        <div className="tile">
          <div className="cap">Sweet-spot entry</div>
          <div className="big" style={{ color: AMBER }}>{B.params.sweetLeadH}h</div>
          <div className="sub">max day-clustered lower bound{sweetLead ? ` · ${pp(sweetLead.roiPct)}` : ''}</div>
        </div>
        <div className="tile">
          <div className="cap">Window</div>
          <div className="big" style={{ fontSize: '1.2rem' }}>{fmtDate(B.universe.dateRange[0])} →</div>
          <div className="sub">{fmtDate(B.universe.dateRange[1])} · {B.universe.nDays} weather-days</div>
        </div>
      </div>

      {/* the "peak time for ROI confidence" axis */}
      <section className="panel" style={{ marginTop: '1.4rem' }}>
        <div className="tile-head" style={{ alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>The &ldquo;peak time&rdquo; axis — ROI by entry lead</h2>
          <span className="cap muted">hours before market close · pooled, cheap-filtered · day-clustered CI whiskers</span>
        </div>
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          The sweet-spot you asked for is a real trade-off: enter earlier and the bucket is cheaper but our forecast
          is less certain; enter later and it is more accurate but no longer cheap. The best of a bad set is{' '}
          <strong style={{ color: AMBER }}>{B.params.sweetLeadH}h</strong> — but ROI is <strong>negative at every
          lead</strong>, and it gets <em>worse</em> the closer to close you buy ({pp(B.leadCurve[B.leadCurve.length - 1]!.roiPct)}{' '}
          at {B.leadCurve[B.leadCurve.length - 1]!.leadH}h). A genuine forecast edge would do the opposite —
          strengthen near resolution, where our forecast is sharpest. That it collapses instead is the efficiency
          signature: near close the winner has already converged above {cents(B.params.cheapMax)}, so the cheap
          filter keeps only near-certain losers.
        </p>
        <div style={{ marginTop: '0.4rem', overflowX: 'auto' }}>
          <LeadCurveChart />
        </div>
        <div className="tbl-scroll" style={{ marginTop: '0.6rem' }}>
          <table>
            <thead>
              <tr>
                <th>entry lead</th><th>bets</th><th>days</th><th>win%</th><th>avg ask</th><th>ROI</th>
                <th>net</th><th>day-clustered CI</th>
              </tr>
            </thead>
            <tbody>
              {B.leadCurve.map((l: CityBuyLeadPoint) => (
                <tr key={l.leadH} className={l.leadH === B.params.sweetLeadH ? 'rec-row' : undefined}>
                  <td style={{ fontWeight: l.leadH === B.params.sweetLeadH ? 700 : 400 }}>
                    {l.leadH}h before close{l.leadH === B.params.sweetLeadH ? ' ★ sweet-spot' : ''}
                  </td>
                  <td>{l.bets}</td>
                  <td>{l.days}</td>
                  <td>{l.winPct}%</td>
                  <td className="mono">{cents(l.avgAsk)}</td>
                  <td className="neg">{pp(l.roiPct)}</td>
                  <td className="neg">{signedUsd(l.netUsd, 0)}</td>
                  <td>[{pp(l.ciPct[0])}, {pp(l.ciPct[1])}]</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* THE TABLE */}
      <section className="panel" style={{ marginTop: '1.4rem' }}>
        <div className="tile-head" style={{ alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Per-city results @ {B.params.sweetLeadH}h sweet-spot</h2>
          <span className="chip soft">backtest · executable ask · held to close</span>
          <span className="cap muted">
            {B.universe.nCities} of {B.universe.nCitiesTotal} cities had a qualifying cheap entry · sorted by net P&amp;L
          </span>
        </div>
        <p className="muted small" style={{ marginTop: '0.4rem' }}>
          Each row: bet $10 on our predicted whole-° bucket every day the bucket was priced ≤ {cents(B.params.cheapMax)}
          at the {B.params.sweetLeadH}h lead, buy at the executable ask (mid + {cents(B.params.halfSpread)} spread,
          floored at {cents(B.params.floor)}), hold to resolution. The <strong>net-by-lead</strong> sparkline shows the
          same city across all four entry leads (48/24/12/6h) — green up, red down. Per-city n is tiny; read the
          <strong> pooled</strong> verdict above, not any single row.
        </p>
        <div className="tbl-scroll" style={{ marginTop: '0.6rem' }}>
          <table>
            <thead>
              <tr>
                <th>city</th><th title="distinct weather-days a bet was placed">days</th>
                <th>bets</th><th>win%</th><th title="mean executable entry ask">avg ¢</th>
                <th>staked</th><th>net P&amp;L</th><th>ROI</th>
                <th title="net P&L across the four entry leads: 48 / 24 / 12 / 6h before close">net by lead</th>
              </tr>
            </thead>
            <tbody>
              {B.rows.map((r) => <CityRow key={r.city} r={r} />)}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--ams-grid)', fontWeight: 700 }}>
                <td>POOLED ({B.universe.nCities})</td>
                <td>{B.universe.nDays}</td>
                <td>{pooled.bets}</td>
                <td>{pooled.winPct}%</td>
                <td className="mono">{cents(pooled.avgAsk)}</td>
                <td>{fmtUsd(pooled.bets * B.params.stake, 0)}</td>
                <td className={pnlClass(pooled.netUsd)}>{signedUsd(pooled.netUsd, 0)}</td>
                <td className={pnlClass(pooled.roiPct)}>{pp(pooled.roiPct)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* method / reproduce */}
      <details className="detail" style={{ marginTop: '0.9rem' }}>
        <summary>method, honesty rails &amp; reproduce</summary>
        <div style={{ marginTop: '0.5rem' }}>
          <p className="small muted">
            <strong>Forecast:</strong> the CAUSAL walk-forward blend μ from <code>scripts/research/city-accuracy.ts</code>{' '}
            (bias corrected on prior data only — no hindsight/look-ahead). <strong>Bucket match:</strong> by parsing
            temperature from the label (bucket_idx is raw gamma order — trap #7). <strong>Price:</strong> the archive
            mid; we buy at the executable ask = mid + {cents(B.params.halfSpread)}, floored at {cents(B.params.floor)}
            (can&apos;t fill $10 on a sub-floor longshot). <strong>Sweet-spot:</strong> the entry lead maximizing the
            day-clustered lower bound (shrinkage, not the point estimate). <strong>CI:</strong> clustered on the
            independent unit (city × weather-day). This is the sibling of the pooled MARKET-PNL record, with the
            ≤{cents(B.params.cheapMax)} cheap-entry filter added.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            <strong>Reproduce</strong> (read-only; reads the local parquet archive + causal-forecast CSV, writes only
            out/, places no trade):<br />
            <code>pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv</code><br />
            <code>python scripts/research/city-buy-table.py --emit scripts/research/out/city-buy-table.json --emit-ts packages/core/src/sim/city-buy-table-results.ts --asof {B.recordedAt}</code>
          </p>
        </div>
      </details>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════
 * 45-City Scan — the pre-registered TRAIN/TEST cut of the SAME question (SIGNAL-BACKLOG.md §12). Kept as the
 * deeper, selection-disciplined companion to the table above. Renders entirely from the committed static asset.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */

function ScanCurveChart({ width = 760, height = 300 }: { width?: number; height?: number }): ReactElement {
  const padL = 48;
  const padR = 12;
  const padT = 16;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
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
            <line x1={xC(i)} x2={xC(i)} y1={yAt(r.ciPp[1])} y2={yAt(r.ciPp[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yAt(r.ciPp[1])} y2={yAt(r.ciPp[1])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yAt(r.ciPp[0])} y2={yAt(r.ciPp[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <rect x={xC(i) - barW / 2} y={zeroY} width={barW} height={barH} rx={3} fill={isBest ? AMBER : RED} opacity={isBest ? 0.9 : 0.55}>
              <title>{`${r.hour}:00 — ROI ${pp(r.roiPp)} · n=${r.n} · win ${fmtPct(r.winRate, 1)} · mean ask ${r.meanAsk.toFixed(3)} · CI [${pp(r.ciPp[0])}, ${pp(r.ciPp[1])}]`}</title>
            </rect>
            <text
              x={xC(i)}
              y={yAt(r.roiPp) + 12}
              textAnchor="middle"
              fontSize={9}
              fontWeight={isBest ? 700 : 400}
              fill={isBest ? AMBER : RED}
              className="mono"
            >
              {pp(r.roiPp)}
            </text>
            <text x={xC(i)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--ams-muted)" className="mono">
              {r.hour}h
            </text>
          </g>
        );
      })}
    </svg>
  );
}

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

function CityScanSection(): ReactElement {
  const best = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'best')!;
  const worst = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'worst')!;
  const candidates = CITY_SCAN_TOP5_TRAIN_CELLS.filter((c) => c.isCandidate);

  return (
    <section className="panel" style={{ marginTop: '2rem' }}>
      <div className="tile-head" style={{ alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>45-City Scan</h2>
        <span className="chip soft">pre-registered TRAIN/TEST cut · not a capital gate</span>
        <span className="cap muted">
          {CITY_SCAN_META.nEvents} events · {CITY_SCAN_META.nCities} cities · {CITY_SCAN_META.nDays} days · run {fmtDate(CITY_SCAN_META.verdictRecordedAt)}
        </span>
      </div>

      <p className="muted small" style={{ marginTop: '0.5rem' }}>
        The selection-disciplined companion to the table above: the same $10/day predicted-bucket bet across every
        city × entry hour (9h–19h local), but pre-registered — TRAIN (≤ {CITY_SCAN_META.trainLastDate}) selects
        candidates, TEST (≥ {CITY_SCAN_META.testFirstDate}) confirms them once. It shortlisted two &ldquo;another
        Karachi&rdquo; candidates out of the top-5 ranked cells — <strong>ankara/14:00</strong> and{' '}
        <strong>houston/14:00</strong>. Reads are restricted to markets from{' '}
        <strong>{CITY_SCAN_CONFIRMATION_CLOCK}</strong> onward (the backfill overlaps the scan&apos;s own window, so
        it is in-sample and doesn&apos;t count as confirmation).
      </p>

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

      <div style={{ marginTop: '1.1rem' }}>
        <div className="cap">Pooled entry-hour ROI, all {CITY_SCAN_META.nCities} cities (day-clustered CI whiskers)</div>
        <div style={{ marginTop: '0.5rem', overflowX: 'auto' }}>
          <ScanCurveChart />
        </div>
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          The flat 9h–14h shelf (−11 to −16pp) is the pooled-efficiency read; the monotone collapse from{' '}
          {best.hour}:00 ({pp(best.roiPp)}) to {worst.hour}:00 ({pp(worst.roiPp)}) is largely the locked fixed-bucket
          bet rule at late hours — see the caveats below.
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
          pooled-positive — confidence sorts the losses, it doesn&apos;t produce an edge.
        </p>
      </div>

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

      <div className="info-banner" style={{ marginTop: '1.1rem' }}>
        <strong>Read this before trusting the two candidates:</strong>
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
          {CITY_SCAN_CAVEATS.map((c, i) => (
            <li key={i} className="small" style={{ marginTop: i > 0 ? '0.4rem' : 0 }}>{c}</li>
          ))}
        </ul>
      </div>

      <details className="detail" style={{ marginTop: '0.9rem' }}>
        <summary>methodology, run record &amp; enrollment detail</summary>
        <div style={{ marginTop: '0.5rem' }}>
          <p className="small muted">
            <strong>Data:</strong> the local maker-exit cache ({CITY_SCAN_META.nEvents} events / {CITY_SCAN_META.nCities} cities
            / {CITY_SCAN_META.nDays} days of real tick series) joined against ONE {CITY_SCAN_META.nDbPullRows.toLocaleString('en-US')}-row
            point-in-time <code>bucket_probabilities</code> pull (latest house-calibrated build strictly before each bet&apos;s entry
            tick — no look-ahead). {CITY_SCAN_META.nCells.toLocaleString('en-US')} city×hour cells ={' '}
            {CITY_SCAN_META.nBets.toLocaleString('en-US')} bets + {CITY_SCAN_META.nSkips.toLocaleString('en-US')} skips
            (ask&gt;0.95: {CITY_SCAN_META.skipBreakdown.askTooHigh} · already resolved: {CITY_SCAN_META.skipBreakdown.alreadyResolved} ·
            no tick: {CITY_SCAN_META.skipBreakdown.noTick}). {CITY_SCAN_META.pctDbRecoveredForecast}% of bets used a genuine
            pre-entry forecast build; {CITY_SCAN_META.pctFrozenSeedFallback}% ({CITY_SCAN_META.nFallbackBets} bets) fell back to
            the cache&apos;s frozen seed — a look-ahead by construction, but measured 100% TRAIN-confined (the TEST holdout is clean).
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

export default function PaperTradePage(): ReactElement {
  return (
    <div className="ams-dash">
      <BuyTableSection />
      <CityScanSection />
    </div>
  );
}
