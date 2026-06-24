/**
 * /whaletracker — the past-N-days ≥$min Polymarket whale-trade tracker (analytics, NOT trading).
 *
 * Operator ask (2026-06-24): "show visuals of the past 10 days worth of bets made above $100k — link to profile,
 * link to bet, what the bet was, and the value." Reads the live whale_trades feed (every-minute whale-watch Edge
 * tick, 0055) through dash_whale_tracker (0058). Built EXTENSIBLE per "we will expand on the whaletracker": the
 * RPC params the window + min-USD and the row shape is kept rich (eventSlug, txHash, proxyWallet) so per-wallet
 * rollups / category clustering / post-resolution P&L are additive. Read-only; the trading rail stays DORMANT.
 */
import type { ReactElement } from 'react';
import { BarChart, type BarDatum } from '../../../components/BarChart.tsx';
import { fmtAgo, fmtDateTime, fmtPct, fmtProb, fmtUsd, num } from '../../../lib/format.ts';
import { getWhaleTracker, type WhaleBetRow, type WhaleTrackerView } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 10;
const DEFAULT_MIN_USD = 100_000;

/** Compact USD for chart labels: $753k, $1.2M. */
function fmtUsdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

/** Shorten a 0x proxy wallet for display: 0x1234…abcd. */
function shortWallet(w: string): string {
  return w.length > 14 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

/** The continuous UTC-day axis for the window (so empty days still show on the timeline). */
function utcDayRange(days: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Profile/bet links + the side·outcome chip — the four operator-required fields, in one row component. */
function WhaleRow({ b, isLargest }: { b: WhaleBetRow; isLargest: boolean }): ReactElement {
  const profileUrl = `https://polymarket.com/profile/${b.proxyWallet}`;
  const betUrl = b.link ?? (b.txHash ? `https://polygonscan.com/tx/${b.txHash}` : null);
  const traderLabel = b.trader === b.proxyWallet ? shortWallet(b.proxyWallet) : b.trader;
  const sideColor = b.side === 'SELL' ? 'var(--ams-red)' : 'var(--ams-tertiary)';
  const price = num(b.price);
  const shares = num(b.sizeShares);
  return (
    <tr className={isLargest ? 'rec-row' : undefined}>
      <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
        {fmtDateTime(b.tradedAt)}Z
        <br />
        <span className="muted" style={{ fontSize: '0.7rem' }}>
          {fmtAgo(b.tradedAt)}
        </span>
      </td>
      <td>
        <a href={profileUrl} target="_blank" rel="noreferrer" className="mono small" title={b.proxyWallet}>
          {traderLabel} ↗
        </a>
      </td>
      <td style={{ maxWidth: 360, whiteSpace: 'normal' }}>
        <div>{b.title ?? '—'}</div>
        <span className="chip" style={{ color: sideColor, borderColor: sideColor, marginTop: 4 }}>
          {b.side ?? '—'}
          {b.outcome ? ` ${b.outcome}` : ''}
        </span>
      </td>
      <td className="num" style={{ whiteSpace: 'nowrap' }}>
        <strong>{fmtUsd(b.notionalUsd, 0)}</strong>
        <br />
        <span className="muted" style={{ fontSize: '0.72rem' }}>
          {shares === null ? '—' : shares.toLocaleString('en-US')} sh @ {fmtProb(b.price)}
          {price === null ? '' : ` (≈${fmtPct(price, 1)})`}
        </span>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {betUrl ? (
          <a href={betUrl} target="_blank" rel="noreferrer">
            View bet ↗
          </a>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

export default async function WhaleTrackerPage(): Promise<ReactElement> {
  const db = await serverDb();
  const view: WhaleTrackerView | null = await getWhaleTracker(db, { days: DEFAULT_DAYS, minUsd: DEFAULT_MIN_USD });

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>whale tracker — large Polymarket bets</h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_whale_tracker</span> RPC is deploying).
          Refresh shortly.
        </p>
      </div>
    );
  }

  const minUsd = num(view.meta.minUsd) ?? DEFAULT_MIN_USD;
  const days = num(view.meta.days) ?? DEFAULT_DAYS;
  const totalUsd = num(view.meta.totalUsd) ?? 0;
  const count = num(view.meta.count) ?? 0;

  // largest single bet (over the returned rows) + busiest day (max count) — for the headline tiles.
  const largest = view.bets.reduce<WhaleBetRow | null>(
    (m, b) => ((num(b.notionalUsd) ?? 0) > (num(m?.notionalUsd) ?? -1) ? b : m),
    null,
  );
  const largestKey = largest ? `${largest.txHash}:${largest.tradedAt}` : null;
  const busiest = view.daily.reduce<WhaleTrackerView['daily'][number] | null>(
    (m, d) => ((num(d.count) ?? 0) > (num(m?.count) ?? -1) ? d : m),
    null,
  );

  // continuous-timeline bar series: total notional per UTC day, zero on quiet days.
  const byDate = new Map(view.daily.map((d) => [d.date.slice(0, 10), d]));
  const barData: BarDatum[] = utcDayRange(days, new Date()).map((date) => {
    const row = byDate.get(date);
    const c = num(row?.count) ?? 0;
    return { label: date.slice(5), value: num(row?.totalUsd) ?? 0, tag: c > 0 ? String(c) : undefined };
  });

  return (
    <div className="ams-dash">
      <h1>
        whale tracker <span className="chip soft">analytics · rail DORMANT</span>
      </h1>
      <p className="muted small">
        Every single Polymarket bet ≥ <span className="mono">{fmtUsdShort(minUsd)}</span> across ALL markets, recorded
        by the every-minute whale-watch tick. Profile link, bet link, what it was, and the value. Data accrues from
        whale-watch go-live (~2026-06-24), so the {days}-day window fills in over time. Read-only, <strong>not trading</strong>.
      </p>

      {/* ── headline tiles ───────────────────────────────────────────────────────────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Whale bets · {days}d</span>
            <span className="chip soft">≥ {fmtUsdShort(minUsd)}</span>
          </div>
          <div className="big sky">{count}</div>
          <div className="sub">single fills above the floor in the window</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Total notional</span>
          </div>
          <div className="big">{fmtUsdShort(totalUsd)}</div>
          <div className="sub">{fmtUsd(totalUsd, 0)} across all whale fills</div>
        </div>
        <div className="tile rec">
          <div className="tile-head">
            <span className="cap">Largest single bet</span>
          </div>
          <div className="big amber">{largest ? fmtUsdShort(num(largest.notionalUsd) ?? 0) : '—'}</div>
          <div className="sub">
            {largest ? `${largest.side ?? ''} ${largest.outcome ?? ''} · ${largest.title ?? '—'}` : 'none yet'}
          </div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Busiest day</span>
          </div>
          <div className="big">{busiest ? `${num(busiest.count) ?? 0}` : '—'}</div>
          <div className="sub">
            {busiest ? `${busiest.date.slice(5)} · ${fmtUsdShort(num(busiest.totalUsd) ?? 0)}` : 'no activity yet'}
          </div>
        </div>
      </div>

      {/* ── daily-notional bar chart ────────────────────────────────────────────────────────────────────── */}
      <h2>
        ≥ {fmtUsdShort(minUsd)} Polymarket bets — last {days} days
      </h2>
      <div className="panel">
        <BarChart
          data={barData}
          ariaLabel={`total whale notional per day over the last ${days} days, US dollars`}
          color="var(--ams-secondary)"
          valueFmt={fmtUsdShort}
          emptyHint="no ≥$100k bets recorded in the window yet — the bars fill in as whales trade"
        />
        <p className="muted small" style={{ margin: '0.4rem 0 0' }}>
          Bar = total notional that UTC day; the number under each day = how many ≥{fmtUsdShort(minUsd)} fills landed.
        </p>
      </div>

      {/* ── ranked bet table (the four required fields) ──────────────────────────────────────────────────── */}
      <h2>Individual bets — newest first</h2>
      <div className="panel">
        {view.bets.length === 0 ? (
          <p className="muted">
            No ≥{fmtUsdShort(minUsd)} bets recorded in the last {days} days yet. The table fills in as the whale-watch
            tick records large fills.
          </p>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {view.bets.length} shown{count > view.bets.length ? ` of ${count}` : ''} · the largest is highlighted.
              Trader → profile, "View bet" → the Polymarket event (polygonscan tx fallback).
            </p>
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>time (UTC)</th>
                    <th>trader</th>
                    <th>what</th>
                    <th className="num">value</th>
                    <th>link</th>
                  </tr>
                </thead>
                <tbody>
                  {view.bets.map((b) => (
                    <WhaleRow
                      key={`${b.txHash}:${b.tradedAt}:${b.proxyWallet}`}
                      b={b}
                      isLargest={`${b.txHash}:${b.tradedAt}` === largestKey}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the live <span className="mono">whale_trades</span> feed (whale-watch Edge tick, every
        minute). Window + threshold are RPC params, ready for the planned filter/per-wallet-rollup expansion. No orders;
        the trading rail is DORMANT.
      </p>
    </div>
  );
}
