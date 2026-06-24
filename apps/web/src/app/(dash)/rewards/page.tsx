/**
 * /rewards — the REC-8/9 reward-farming test, made visible (analytics, NOT trading).
 *
 * Polymarket turned on FUNDED liquidity rewards on weather markets (2026-06-24) — a forecast-free, selection-
 * free income path, orthogonal to every falsified taker/maker signal (FINDINGS.md). The REC-8 first-pass PASSED
 * its frozen criterion (net +$28/mkt) but is NOT actionable: the advertised rates look like under-paid caps, and
 * the PASS was load-bearing on ONE instantaneous order-book snapshot of the competition denominator. The
 * reward-snapshot Edge tick (every 20 min, 0057) now logs a TIME-INTEGRATED series of the reward POOL vs the
 * in-band competing maker CAPITAL. This page surfaces that series live so the operator can watch the one number
 * that decides the deferred re-run: is competing capital THICKENING (window closing) or staying THIN (open)?
 * Read-only; the live trading rail stays DORMANT.
 */
import type { ReactElement } from 'react';
import { EquityChart, type EquitySeries } from '../../../components/EquityChart.tsx';
import { fmtAgo, fmtDateTime, fmtPct, fmtProb, fmtUsd, num } from '../../../lib/format.ts';
import { getMarketRewards, type RewardMarketRow, type RewardsView } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

/** pool / in-band → daily gross yield fraction (null when in-band is 0/absent). */
function impliedYield(pool: unknown, inBand: unknown): number | null {
  const p = num(pool);
  const b = num(inBand);
  if (p === null || b === null || b <= 0) return null;
  return p / b;
}

/** Two-series time chart: reward pool vs in-band competing capital, over the captures. */
function RewardTrend({ view }: { view: RewardsView }): ReactElement {
  const pts = view.series;
  const dates = pts.map((p) => fmtDateTime(p.capturedAt));
  const series: EquitySeries[] = [
    { label: 'daily pool', color: 'var(--ams-amber)', dash: '', values: pts.map((p) => num(p.totalPoolUsd)) },
    {
      label: 'in-band capital',
      color: 'var(--ams-secondary)',
      dash: '5 3',
      values: pts.map((p) => num(p.totalInBandUsd)),
    },
  ];
  return (
    <>
      <EquityChart dates={dates} series={series} />
      <div className="chart-legend">
        <span>
          <span className="ln solid" style={{ borderColor: 'var(--ams-amber)' }} /> daily reward pool ($/day)
        </span>
        <span>
          <span className="ln dash" style={{ borderColor: 'var(--ams-secondary)' }} /> in-band competing maker capital ($)
        </span>
      </div>
      <p className="muted small" style={{ margin: '0.4rem 0 0' }}>
        The gap is the story: the pool is the income on offer; the in-band capital is who you split it with. A pool
        line that holds while the capital line CLIMBS = the window is crowding (yield falling). Captured every 20 min.
      </p>
    </>
  );
}

/** Top funded markets by daily pool in the latest capture. */
function TopMarketsTable({ rows }: { rows: RewardMarketRow[] }): ReactElement {
  if (rows.length === 0) return <p className="muted">No funded markets in the latest capture.</p>;
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>market</th>
            <th className="num">pool $/day</th>
            <th className="num">mid</th>
            <th className="num">best bid</th>
            <th className="num">best ask</th>
            <th className="num">in-band bid $</th>
            <th className="num">in-band ask $</th>
            <th className="num">max spread ¢</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.slug ?? 'mkt'}-${i}`}>
              <td className="mono small">{r.slug ?? '—'}</td>
              <td className="num">{fmtUsd(r.dailyPoolUsd, 0)}</td>
              <td className="num">{fmtProb(r.mid)}</td>
              <td className="num">{fmtProb(r.bestBid)}</td>
              <td className="num">{fmtProb(r.bestAsk)}</td>
              <td className="num">{fmtUsd(r.bidDepthUsd, 0)}</td>
              <td className="num">{fmtUsd(r.askDepthUsd, 0)}</td>
              <td className="num">{num(r.maxSpreadCents) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function RewardsPage(): Promise<ReactElement> {
  const db = await serverDb();
  const view = await getMarketRewards(db, { days: 7, top: 20 });

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>reward farming — funded-weather liquidity rewards</h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_market_rewards</span> RPC is deploying).
          Refresh shortly.
        </p>
      </div>
    );
  }

  const latest = view.latest;
  const yieldFrac = latest ? impliedYield(latest.totalPoolUsd, latest.totalInBandUsd) : null;
  const hasCaptures = view.series.length > 0 && latest?.capturedAt != null;

  return (
    <div className="ams-dash">
      <h1>
        reward farming <span className="chip soft">analytics · rail DORMANT</span>
      </h1>
      <p className="muted small">
        Polymarket funds liquidity rewards on weather markets — a forecast-free, selection-free income path. This
        tracks the reward <strong>pool</strong> against the in-band competing maker <strong>capital</strong> over time,
        so the thin-book window&apos;s opening/closing is visible. Insight value, <strong>not trading</strong>.
        {latest?.capturedAt ? (
          <>
            {' '}
            Latest capture <span className="mono">{fmtAgo(latest.capturedAt)}</span>.
          </>
        ) : null}
      </p>

      {/* ── headline tiles ───────────────────────────────────────────────────────────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Funded weather markets</span>
            <span className="chip soft">latest</span>
          </div>
          <div className="big sky">{num(latest?.nMarkets) ?? '—'}</div>
          <div className="sub">markets carrying a daily reward pool</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Total daily pool</span>
          </div>
          <div className="big amber">{fmtUsd(latest?.totalPoolUsd, 0)}</div>
          <div className="sub">USDC on offer per day, all funded markets</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">In-band competing capital</span>
          </div>
          <div className="big">{fmtUsd(latest?.totalInBandUsd, 0)}</div>
          <div className="sub">resting maker $ near mid you&apos;d split the pool with</div>
        </div>
        <div className="tile rec">
          <div className="tile-head">
            <span className="cap">Implied gross yield</span>
            <span className="chip soft">/ day</span>
          </div>
          <div className="big amber">{yieldFrac === null ? '—' : fmtPct(yieldFrac, 2)}</div>
          <div className="sub">pool ÷ in-band capital — the thin-book paradox number</div>
        </div>
      </div>

      {/* ── verdict banner (static, sourced from REWARD-FARMING-HANDOFF.md) ─────────────────────────────── */}
      <div className="info-banner">
        <strong>REC-8 first-pass = PASS-per-criterion but NOT actionable.</strong> Advertised rates are likely
        under-paid caps; passive, forecast-free farming is a thin <em>bonus</em>, not a profit engine. The REC-9 probe
        (~$59) and the wallet are held pending an operator decision. This page tracks the one thing the deferred re-run
        turns on — whether the competition window is opening (capital staying thin) or closing (capital thickening).
        Source: <span className="mono">REWARD-FARMING-HANDOFF.md §10–§11</span>. Rail stays DORMANT.
      </div>

      {/* ── pool vs competing-capital trend ─────────────────────────────────────────────────────────────── */}
      <h2>Pool vs competing capital — last {view.days} days</h2>
      <div className="panel">
        {hasCaptures ? (
          <RewardTrend view={view} />
        ) : (
          <p className="muted">
            No captures recorded yet — the series fills in as the every-20-min <span className="mono">reward-snapshot</span>{' '}
            tick runs.
          </p>
        )}
      </div>

      {/* ── top funded markets ──────────────────────────────────────────────────────────────────────────── */}
      <h2>Top funded markets — latest capture</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          {latest?.capturedAt ? (
            <>
              As of <span className="mono">{fmtDateTime(latest.capturedAt)}Z</span> ·{' '}
            </>
          ) : null}
          ranked by daily reward pool. In-band $ = resting maker capital within the reward spread near mid (the
          denominator you compete against for the pool).
        </p>
        <TopMarketsTable rows={view.topMarkets} />
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the live <span className="mono">market_rewards</span> feed (Edge tick every 20 min).
        No capital is deployed; the trading rail is DORMANT. The REC-9 net-profit decider is an operator action.
      </p>
    </div>
  );
}
