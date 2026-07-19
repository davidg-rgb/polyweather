/**
 * /paper-trade — the PER-CITY "$10 on our predicted high, bought CHEAP, held to close" table.
 *
 * Operator ask (2026-07-09): replace the multi-city arms-race with a table of ALL cities. For each city, place
 * a fictive $10 bet on OUR predicted daily-high bucket, but only enter while it is still cheap (ask ≤ 15¢ =
 * "high return potential"), at the confidence sweet-spot (the entry lead that maximizes the day-clustered lower
 * bound), held to resolution; log per city: bets, days active, win%, avg entry price, net P&L, ROI.
 *
 * HONESTY: this IS signal #12 (opening-convergence), already falsified (FINDINGS.md / MARKET-PNL.md). The
 * cheap-entry filter buys the predicted bucket only while it is still a not-yet-converged LONGSHOT. Scored on
 * the CANONICAL calibrated book (CALIBRATED_BOOK exec ask + taker fee; a bet exists only where walked depth
 * covers the stake) the fillable population nearly vanishes — the legacy mid+1¢ read (−28% on 347 bets) was
 * mostly bets that could never fill at $10 — and what remains is an UNDERPOWERED WASH: no lead's
 * day-clustered lower bound comes near zero (2026-07-19 °F band-parse fix: ~27 recovered °F picks drift the
 * pooled point estimate just positive — the CI stays ±50pp wide; the no-edge verdict is unchanged). This page renders that truth per city from the committed
 * archive-backtest asset (core/sim/city-buy-table-results.ts) — a FROZEN record (see the as-of chip), NOT a
 * live feed — plus the LIVE forward ledger (dash_city_sim), which is still accruing and remains the
 * backtest-vs-realized cross-check instrument (loop rule 4). The 45-City Scan below is the pre-registered
 * TRAIN/TEST cut of the same question.
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
import { type CitySimView, getCitySim } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

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

/* ── the lead-curve "peak-time" hero: ROI at each entry lead — no lead demonstrates an edge ─────────────── */
function LeadCurveChart({ width = 560, height = 220 }: { width?: number; height?: number }): ReactElement {
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  // dynamic y-range from the ROI points (a tiny-n fluke row can be strongly positive); the CI whiskers are
  // CLAMPED to the plot rather than allowed to squash it (the 3-bet 6h row's CI reaches +600pp).
  const rois = B.leadCurve.map((p) => p.roiPct);
  const yMax = Math.max(15, Math.ceil(Math.max(...rois) / 25) * 25 + 10);
  const yMin = Math.min(-105, Math.floor(Math.min(...rois) / 25) * 25 - 10);
  const yAt = (v: number): number => padT + ((yMax - v) / (yMax - yMin)) * plotH;
  const yCl = (v: number): number => Math.max(padT, Math.min(padT + plotH, yAt(v)));
  const zeroY = yAt(0);
  // far → near (48h..6h) left → right, so the eye reads "as we approach market close".
  const pts = B.leadCurve;
  const n = pts.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.44, 46);
  const xC = (i: number): number => padL + slot * (i + 0.5);
  const grid = [-100, -75, -50, -25, 0, 25, 50, 75, 100, 125, 150].filter((g) => g >= yMin && g <= yMax);
  const ariaLabel =
    `Pooled ROI of the cheap-entry (≤${cents(B.params.cheapMax)}) predicted-bucket bet, by entry lead: ` +
    pts.map((p) => `${p.leadH}h ${pp(p.roiPct)} (n=${p.bets})`).join(', ') +
    `. No lead demonstrates an edge — every day-clustered CI lower bound sits far below zero; tiny-n rows are ` +
    `longshot noise. Whiskers are day-clustered CIs, clamped to the plot.`;

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
        const neg = r.roiPct < 0;
        const barTop = Math.min(zeroY, yAt(r.roiPct));
        const barH = Math.max(Math.abs(zeroY - yAt(r.roiPct)), 1.5);
        // a positive bar here is a wash-sized point estimate under a ±50pp day-CI (the invariant tests pin
        // every bets≥10 lead's lower bound below −20) — render it muted, not green, so noise never reads as signal.
        const fill = isSweet ? AMBER : neg ? RED : 'var(--ams-secondary-dim)';
        return (
          <g key={r.leadH}>
            <line x1={xC(i)} x2={xC(i)} y1={yCl(r.ciPct[1])} y2={yCl(r.ciPct[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yCl(r.ciPct[1])} y2={yCl(r.ciPct[1])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <line x1={xC(i) - 4} x2={xC(i) + 4} y1={yCl(r.ciPct[0])} y2={yCl(r.ciPct[0])} stroke="var(--ams-secondary-dim)" strokeWidth={1.4} />
            <rect x={xC(i) - barW / 2} y={barTop} width={barW} height={barH} rx={3} fill={fill} opacity={isSweet ? 0.9 : 0.55}>
              <title>{`${r.leadH}h before close — ROI ${pp(r.roiPct)} · n=${r.bets} · win ${r.winPct}% · mean all-in ask ${cents(r.avgAsk)} · CI [${pp(r.ciPct[0])}, ${pp(r.ciPct[1])}]`}</title>
            </rect>
            <text x={xC(i)} y={neg ? yAt(r.roiPct) + 12 : yAt(r.roiPct) - 5} textAnchor="middle" fontSize={9} fontWeight={isSweet ? 700 : 400} fill={isSweet ? AMBER : neg ? RED : 'var(--ams-muted)'} className="mono">
              {pp(r.roiPct)}
            </text>
            <text x={xC(i)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--ams-muted)" className="mono">
              {r.leadH}h{isSweet ? ' ★' : ''} <tspan fontSize={8}>n={r.bets}</tspan>
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
      <p className="cap muted" style={{ marginTop: '0.2rem' }}>
        <span className="chip soft">frozen archive record · as of {fmtDate(B.recordedAt)}</span>{' '}
        not a live feed — regenerate via the reproduce block below. The <strong>live forward ledger</strong> further
        down is the accruing real-data instrument.
      </p>

      {/* the honest verdict, leading with the number */}
      <div className="info-banner" style={{ borderLeftColor: RED }}>
        <strong style={{ color: RED }}>Verdict: no demonstrable edge — an underpowered wash.</strong>{' '}
        Pooled ROI {pp(pooled.roiPct)} ({signedUsd(pooled.netUsd, 0)} on {pooled.bets} fillable bets ·{' '}
        {B.universe.nDays} days · {B.universe.nCities} cities, day-clustered CI [{pp(pooled.dayCiPct[0])},{' '}
        {pp(pooled.dayCiPct[1])}]). This is the strategy you described — $10 on our predicted whole-° bucket, entered
        only while it is still <strong>cheap (all-in ask ≤ {cents(B.params.cheapMax)})</strong>, at the confidence
        sweet-spot ({B.params.sweetLeadH}h before close), held to resolution — scored on the <strong>canonical
        calibrated book</strong> (real opening_captures spread-by-price + taker fee), where a bet exists only if the
        walked depth can fill the $10. That cost model nearly erases the strategy: the legacy mid+1¢ scoring read
        −28.2% on 347 bets, but most of those “bets” were never fillable — the cheap zone carries $4–$24 of depth.
        What survives shows no edge: every lead&apos;s day-clustered CI straddles zero by tens of points (the pooled
        point estimate drifted just positive after the 2026-07-19 °F band-parse fix recovered ~27 mis-mapped picks —
        still noise), and pooled win rate {pooled.winPct}% sits at the ~{breakeven.toFixed(0)}% you need just to break
        even.
        It is <strong>signal #12 (opening-convergence), already falsified</strong> (FINDINGS.md / MARKET-PNL.md /
        BUY-TABLE.md). The {pooled.nCitiesPositive} net-positive cities are small-sample longshot noise, not a
        per-city edge. <strong>Nothing here reopens the trading rail.</strong>
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
          The sweet-spot you asked for is the best of a bad set:{' '}
          <strong style={{ color: AMBER }}>{B.params.sweetLeadH}h</strong> — <strong>no lead demonstrates an
          edge</strong> (every well-populated lead is a wash-sized point estimate whose day-clustered lower
          bound sits deep below zero). On the calibrated book the efficiency signature shows up as a{' '}
          <em>population collapse</em> near close: by 6h only {B.leadCurve.find((l) => l.leadH === 6)?.bets ?? 0} bets
          in the whole window were both cheap AND fillable at $10 — the eventual winner has already converged above{' '}
          {cents(B.params.cheapMax)}, and whatever is still cheap is too thin to fill. A strongly positive tiny-n row
          is longshot noise (read its CI), not a late-entry edge.
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
                  <td className={pnlClass(l.roiPct)}>{pp(l.roiPct)}</td>
                  <td className={pnlClass(l.netUsd)}>{signedUsd(l.netUsd, 0)}</td>
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
          <span className="chip soft">backtest · calibrated book + fee · held to close</span>
          <span className="cap muted">
            {B.universe.nCities} of {B.universe.nCitiesTotal} cities had a qualifying cheap entry · sorted by net P&amp;L
          </span>
        </div>
        <p className="muted small" style={{ marginTop: '0.4rem' }}>
          Each row: bet $10 on our predicted whole-° bucket every day the bucket&apos;s <strong>all-in cost</strong>{' '}
          (calibrated-book executable ask + taker fee) was ≤ {cents(B.params.cheapMax)} at the {B.params.sweetLeadH}h
          lead AND the walked depth could fill the stake, hold to resolution. The <strong>net-by-lead</strong>{' '}
          sparkline shows the same city across all four entry leads (48/24/12/6h) — green up, red down. Per-city n is
          tiny; read the <strong> pooled</strong> verdict above, not any single row.
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
            temperature from the label (bucket_idx is raw gamma order — trap #7). <strong>Cost basis ({B.params.book}):</strong>{' '}
            the CANONICAL cost model (<code>scripts/research/cost_model.py</code>, a zero-drift parse of core&apos;s
            CALIBRATED_BOOK — spread-by-price + walked depth fit from real opening_captures books) + the taker fee;
            a bet exists only where depth covers the stake. <strong>Sweet-spot:</strong> the entry lead maximizing
            the day-clustered lower bound (shrinkage, not the point estimate). <strong>CI:</strong> clustered on the
            independent unit (city × weather-day). This is the sibling of the pooled MARKET-PNL record, with the
            ≤{cents(B.params.cheapMax)} cheap-entry filter added; <code>--book flat</code> reproduces the legacy
            mid+{cents(B.params.halfSpread)} scoring for comparison.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            <strong>Reproduce</strong> (read-only; reads the local parquet archive + causal-forecast CSV, writes only
            out/, places no trade):<br />
            <code>pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv</code><br />
            <code>python scripts/research/city-buy-table.py --book {B.params.book} --emit scripts/research/out/city-buy-table.json --emit-ts packages/core/src/sim/city-buy-table-results.ts --asof {B.recordedAt}</code>
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════
 * LIVE forward ledger — the realized multi-city paper-trade (dash_city_sim, migration 0070/0075). This is the
 * project's backtest-vs-realized cross-check instrument (loop rule 4: a flat-accuracy backtest once gave WRONG
 * entry-hour advice that only the realized forward ledger caught). The cron keeps writing city_paper_bets
 * whether or not a page shows it — so this page MUST keep it visible while it accrues. Compact by design; the
 * frozen buy-table above answers the strategy question, this answers "what is the live data actually doing".
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */
function ForwardLedgerSection({ view }: { view: CitySimView | null }): ReactElement {
  return (
    <section className="panel" style={{ marginTop: '1.6rem' }}>
      <div className="tile-head" style={{ alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Live forward ledger — multi-city paper-trade</h2>
        <span className="chip soft">real forward data · accruing daily · NOT a backtest</span>
      </div>
      {view == null ? (
        <p className="muted small" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
          The dash_city_sim RPC is unavailable in this environment — the ledger still accrues server-side (the
          city-paper-trade cron writes city_paper_bets daily); it renders here on prod.
        </p>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: '0.5rem' }}>
            The daily $10/arm paper-trade on the enrolled cities — the <strong>realized</strong> counterpart to the
            frozen archive backtest above, and the instrument that cross-checks it (a backtest once recommended the
            wrong entry hour; only this ledger caught it). Overall:{' '}
            <strong className={pnlClass(num(view.overall.pnl))}>{signedUsd(num(view.overall.pnl), 0)}</strong> on{' '}
            {num(view.overall.nGraded) ?? 0} graded bets ({num(view.overall.nWon) ?? 0} won) · updated{' '}
            {fmtDate(view.generatedAt)}.
          </p>
          <div className="tbl-scroll" style={{ marginTop: '0.4rem' }}>
            <table>
              <thead>
                <tr>
                  <th>city</th><th>window</th><th>graded</th><th>won</th><th>staked</th><th>net P&amp;L</th>
                  <th title="max cumulative P&L arm">🥇 leader arm</th>
                  <th title="the entry-time watcher's shrinkage pick (max edge CI lower bound) — NOT the P&L leader">⭐ watcher pick</th>
                </tr>
              </thead>
              <tbody>
                {view.cities.map((c) => {
                  const rec = c.arms.find((a) => a.recommended);
                  return (
                    <tr key={c.slug}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {c.displayName}
                        <span className="cap muted" style={{ marginLeft: '0.4rem' }}>{c.icao}</span>
                      </td>
                      <td className="mono small">{c.coverage.firstDate ? `${fmtDate(c.coverage.firstDate)} → ${c.coverage.lastDate ? fmtDate(c.coverage.lastDate) : '…'}` : '—'}</td>
                      <td>{num(c.totals.nGraded) ?? 0}</td>
                      <td>{num(c.totals.nWon) ?? 0}</td>
                      <td>{fmtUsd(num(c.totals.staked) ?? 0, 0)}</td>
                      <td className={pnlClass(num(c.totals.pnl))} style={{ fontWeight: 700 }}>{signedUsd(num(c.totals.pnl), 2)}</td>
                      <td>{c.leaderHour != null ? `${c.leaderHour}:00` : '—'}</td>
                      <td>{rec ? `${rec.hour}:00` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default async function PaperTradePage(): Promise<ReactElement> {
  // The live forward ledger degrades to null (never a 500) when the DB/RPC is unreachable — the frozen
  // buy-table + scan sections are committed static assets and must render regardless.
  let live: CitySimView | null = null;
  try {
    live = await getCitySim(await serverDb());
  } catch {
    live = null;
  }
  return (
    <div className="ams-dash">
      <BuyTableSection />
      <ForwardLedgerSection view={live} />
      <CityScanSection />
    </div>
  );
}
