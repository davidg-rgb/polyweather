/**
 * /operation — the operator's live view of the CONTINUOUS OPERATION (operator-directed 2026-08-09).
 *
 * This is the one page that answers, without a shell: is the lane actually armed · what has it bought · is
 * it up or down · which cities are bleeding · how does it compare to the paper control · and, on a quiet
 * day, WHY nothing fired.
 *
 * REAL MONEY. Unlike /cheap-early (paper) and /paper-trade (sim), every number below is capital that left
 * the wallet. The lane runs the cheap-early cell: house pick, ask in [0.20,0.33], lead [24,36]h, $5/buy,
 * a daily buy cap, hold to resolution. Design + the operator's override of the "no capital before a frozen
 * PASS" rule: docs/ops/CHEAP-EARLY-ENTRY.md §7; weekly prune discipline: docs/ops/EDGE-WATCH-LOOP.md.
 *
 * Read-only over dash_operation (migration 0124). This page never places or cancels anything — the operator
 * funds the wallet, holds the key, and authorizes every live action.
 */
import type { ReactElement } from 'react';
import { EquityChart } from '../../../components/EquityChart.tsx';
import { getOperation, type OperationFeed } from '../../../lib/loaders.ts';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct, fmtUsd } from '../../../lib/format.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';

const pnlColor = (v: number): string => (v >= 0 ? GREEN : RED);
const signedUsd = (v: number, dp = 2): string => `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v), dp)}`;
const signedPct = (v: number | null, dp = 1): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${fmtPct(Math.abs(v), dp)}`;

// ─── 1 · decision strip ──────────────────────────────────────────────────────

function DecisionStrip({ feed }: { feed: OperationFeed }): ReactElement {
  const { lane, money } = feed;
  const ov = lane.override;
  // ARMED is the conjunction the tick actually requires — any false link means nothing can be bought.
  const armed = lane.mode === 'live' && lane.tickEnabled && ov?.active === true && !lane.laneHalted;
  const net = money.realizedUsd + money.atRiskUsd - money.stakedUsd;
  return (
    <>
      <div className="tiles">
        <div className="tile">
          <div className="cap">lane</div>
          <div className="big" style={{ color: armed ? GREEN : RED }}>{armed ? 'ARMED' : 'NOT ARMED'}</div>
          <div className="sub">
            mode {lane.mode ?? '—'} · tick {lane.tickEnabled ? 'on' : 'OFF'}
            {lane.laneHalted ? ' · HALTED' : ''}
          </div>
        </div>
        <div className="tile">
          <div className="cap">override</div>
          <div className="big" style={{ color: ov?.active ? GREEN : RED }}>
            {ov?.active ? `${ov.daysLeft ?? 0}d left` : 'EXPIRED'}
          </div>
          <div className="sub">{ov?.expiresAt ? `expires ${fmtDate(ov.expiresAt)}` : 'no override row'}</div>
        </div>
        <div className="tile">
          <div className="cap">staked</div>
          <div className="big">{fmtUsd(money.stakedUsd)}</div>
          <div className="sub">{money.nFilled} filled / {money.nOrders} orders</div>
        </div>
        <div className="tile">
          <div className="cap">realized</div>
          <div className="big" style={{ color: pnlColor(money.realizedUsd) }}>{signedUsd(money.realizedUsd)}</div>
          <div className="sub">
            {money.nResolved} resolved · win {money.winRate == null ? '—' : fmtPct(money.winRate, 0)}
          </div>
        </div>
        <div className="tile">
          <div className="cap">open at risk</div>
          <div className="big" style={{ color: AMBER }}>{fmtUsd(money.atRiskUsd)}</div>
          <div className="sub">{money.nFilled - money.nResolved} unresolved</div>
        </div>
        <div className="tile">
          <div className="cap">net vs staked</div>
          <div className="big" style={{ color: pnlColor(net) }}>{signedUsd(net)}</div>
          <div className="sub">per $1 resolved {signedPct(money.meanNetPerDollar)}</div>
        </div>
      </div>

      <div className="info-banner">
        <strong>Config the tick is reading:</strong> ask band{' '}
        <span className="mono">[{lane.askFloor.toFixed(2)}, {lane.priceCap.toFixed(2)}]</span> · lead{' '}
        <span className="mono">[{lane.leadMinH}, {lane.leadMaxH}]h</span> · stake{' '}
        <span className="mono">{fmtUsd(lane.stakePerBuyUsd ?? 0, 2)}</span> · day cap{' '}
        <span className="mono">{lane.buysToday}/{lane.maxBuysPerDay || '∞'}</span> · allowlist{' '}
        <span className="mono">{lane.allowlistSize}</span> cities · active until{' '}
        <span className="mono">{fmtDate(lane.activeUntil)}</span>.
        {ov?.reason ? <> Override: <em>{ov.reason}</em></> : null}
        <br />
        <span className="muted">
          ⚠ This strip reflects DATABASE state only. The Edge secret <span className="mono">TRADE_MODE</span>{' '}
          is a third gate that SQL cannot see — a lane that reads ARMED here still posts nothing if{' '}
          <span className="mono">TRADE_MODE</span> is not <span className="mono">live</span> on the deployed
          function. Confirm with a tick log before concluding the lane is live.
        </span>
      </div>
    </>
  );
}

// ─── 2 · equity ──────────────────────────────────────────────────────────────

function Equity({ feed }: { feed: OperationFeed }): ReactElement {
  const pts = feed.equity;
  if (pts.length === 0) return <p className="muted">No entries yet — the curve starts at the first fill.</p>;
  let cum = 0;
  const realizedCum = pts.map((p) => (cum += p.realizedUsd));
  // the open overlay is realized + still-at-risk carried at COST (not marked to mid): the honest floor of
  // where the curve sits if every open position resolves worthless, and its ceiling is realized + payoff.
  const withOpen = pts.map((p, i) => realizedCum[i]! + p.atRiskUsd);
  return (
    <>
      <EquityChart
        dates={pts.map((p) => p.date)}
        series={[
          { label: 'realized P&L', color: pnlColor(realizedCum[realizedCum.length - 1] ?? 0), values: realizedCum },
          { label: 'realized + open at cost', color: AMBER, dash: '4 3', values: withOpen },
        ]}
      />
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Solid = realized only. Dashed = realized plus open positions carried at COST — open bets are shown at
        what they cost, not marked to mid, so the dashed line is what the account is worth if every open
        position loses. Marked-to-mid would flatter a lane whose open bets have not resolved yet.
      </p>
    </>
  );
}

// ─── 3 · attribution ─────────────────────────────────────────────────────────

function Attribution({ feed }: { feed: OperationFeed }): ReactElement {
  const flagged = feed.byCity.filter((r) => r.pruneFlag);
  return (
    <>
      <h2>Attribution — the weekly prune inputs</h2>
      {flagged.length > 0 ? (
        <div className="info-banner" style={{ borderColor: RED }}>
          <strong style={{ color: RED }}>PRUNE RULE MET ({flagged.length}):</strong>{' '}
          {flagged.map((r) => r.city).join(', ')} — ≤20% win on n≥8 resolved. Per the weekly checklist these
          are dropped from <span className="mono">city_allowlist</span> this week. No appeals.
        </div>
      ) : null}
      <div className="grid-2">
        <div>
          <h3>By city</h3>
          {feed.byCity.length === 0 ? (
            <p className="muted">No entries yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>city</th><th>n</th><th>W/L</th><th>win%</th><th>staked</th><th>net</th></tr>
              </thead>
              <tbody>
                {feed.byCity.map((r) => (
                  <tr key={r.city} style={r.pruneFlag ? { background: 'color-mix(in srgb, var(--ams-red) 12%, transparent)' } : undefined}>
                    <td>{r.city}{r.pruneFlag ? ' ⚑' : ''}</td>
                    <td>{r.n}</td>
                    <td>{r.wins}/{r.nResolved - r.wins}</td>
                    <td>{r.winRate == null ? '—' : fmtPct(r.winRate, 0)}</td>
                    <td>{fmtUsd(r.stakedUsd)}</td>
                    <td style={{ color: pnlColor(r.realizedUsd) }}>{signedUsd(r.realizedUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h3>By entry-ask band</h3>
          {feed.byBand.length === 0 ? (
            <p className="muted">No fills yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>band</th><th>n</th><th>W/L</th><th>win%</th><th>staked</th><th>net</th></tr>
              </thead>
              <tbody>
                {feed.byBand.map((r) => (
                  <tr key={r.band}>
                    <td className="mono">{r.band}</td>
                    <td>{r.n}</td>
                    <td>{r.wins}/{r.nResolved - r.wins}</td>
                    <td>{r.winRate == null ? '—' : fmtPct(r.winRate, 0)}</td>
                    <td>{fmtUsd(r.stakedUsd)}</td>
                    <td style={{ color: pnlColor(r.realizedUsd) }}>{signedUsd(r.realizedUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            If either half of the band is negative on n≥15, narrow to the surviving half rather than widening
            elsewhere.
          </p>
        </div>
      </div>
    </>
  );
}

// ─── 4 · benchmark + skip telemetry ──────────────────────────────────────────

function Benchmark({ feed }: { feed: OperationFeed }): ReactElement {
  const b = feed.benchmark;
  const live = feed.money.meanNetPerDollar;
  return (
    <>
      <h2>Benchmark — same cell, paper vs live</h2>
      {b == null ? (
        <p className="muted">No paper snapshot yet (the cheap-early-panel tick has not written one).</p>
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="cap">paper gate</div>
              <div className="big" style={{ color: b.gateLabel === 'PASS' ? GREEN : b.gateLabel === 'KILL' ? RED : AMBER }}>
                {b.gateLabel ?? '—'}
              </div>
              <div className="sub">{b.nMarkets ?? 0} mkts · {b.nCities ?? 0} cities</div>
            </div>
            <div className="tile">
              <div className="cap">paper mean net</div>
              <div className="big">{signedPct(b.meanNetReturn)}</div>
              <div className="sub">realized {b.paperRealizedUsd == null ? '—' : signedUsd(b.paperRealizedUsd)}</div>
            </div>
            <div className="tile">
              <div className="cap">LIVE mean net</div>
              <div className="big" style={{ color: live == null ? undefined : pnlColor(live) }}>{signedPct(live)}</div>
              <div className="sub">per $1 resolved</div>
            </div>
            <div className="tile">
              <div className="cap">paper win rate</div>
              <div className="big">{b.paperWinRate == null ? '—' : fmtPct(b.paperWinRate, 0)}</div>
              <div className="sub">captured {fmtAgo(b.capturedAt)}</div>
            </div>
          </div>
          {b.gateReason ? <p className="muted" style={{ fontSize: '0.85rem' }}>{b.gateReason}</p> : null}
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            EXIT SIGNAL: if the paper gate reaches n and reads KILL while the live lane is also negative,
            clear the override and stop. Do not average down.
          </p>
        </>
      )}
    </>
  );
}

function SkipTelemetry({ feed }: { feed: OperationFeed }): ReactElement {
  const s = feed.skipTelemetry;
  if (s == null) return <p className="muted">No tick run recorded yet.</p>;
  const tags = Object.entries(s.tags ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <h2>Why no buys — last tick {fmtAgo(s.at)}</h2>
      <p className="muted">
        {s.captures ?? 0} markets seen · {s.candidates ?? 0} candidates · {s.skips ?? 0} skipped
        {s.degraded ? ' · ⚠ DEGRADED (reads failed; the tick places nothing when degraded)' : ''}
      </p>
      {tags.length === 0 ? (
        <p className="muted">
          No skip histogram on the last run — either nothing was in scope, or the deployed function predates
          the write-time skip fold.
        </p>
      ) : (
        <table className="tbl">
          <thead><tr><th>skip reason</th><th>markets</th></tr></thead>
          <tbody>
            {tags.map(([tag, n]) => (
              <tr key={tag}><td className="mono">{tag}</td><td>{n}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        <span className="mono">ask_floor</span> dominant = the band is starving and the cell is not firing.{' '}
        <span className="mono">day_cap</span> dominant = the daily cap is binding.{' '}
        <span className="mono">lead_window</span> dominant = normal outside the [24,36]h band.
      </p>
    </>
  );
}

// ─── 5 · daily digest + decision log (the hub layer) ─────────────────────────

function DailyDigest({ feed }: { feed: OperationFeed }): ReactElement {
  const rows = feed.daily;
  if (rows.length === 0) return <p className="muted">No digest yet.</p>;
  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            <th>day</th><th>orders</th><th>fills</th><th>staked</th>
            <th>realized</th><th>cumulative</th><th>ticks</th><th>top skip (last tick)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const quiet = d.nOrders === 0;
            return (
              <tr key={d.date} style={quiet ? { opacity: 0.6 } : undefined}>
                <td>{fmtDate(d.date)}</td>
                <td>{d.nOrders}</td>
                <td>{d.nFills}</td>
                <td>{d.stakedUsd === 0 ? '—' : fmtUsd(d.stakedUsd)}</td>
                <td style={{ color: d.realizedUsd === 0 ? undefined : pnlColor(d.realizedUsd) }}>
                  {d.realizedUsd === 0 ? '—' : signedUsd(d.realizedUsd)}
                </td>
                <td style={{ color: pnlColor(d.cumRealizedUsd) }}>{signedUsd(d.cumRealizedUsd)}</td>
                <td>{d.nTicks}</td>
                <td className="mono">
                  {d.topSkipTag == null ? '—' : `${d.topSkipTag}${d.topSkipN == null ? '' : ` (${d.topSkipN})`}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        &ldquo;Top skip&rdquo; is the day&apos;s LAST tick histogram — a snapshot, not a daily total.
        Candidates and skips are counted per tick, so an unbought market recurs on every one of the day&apos;s
        ticks; summing them would multiply it by the tick rate. <span className="mono">nTicks</span> is the
        honest count of how often the lane looked.
      </p>
    </>
  );
}

const KIND_COLOR: Record<string, string> = {
  decision: 'var(--ams-secondary)',
  adjudication: AMBER,
  config_change: GREEN,
  evaluation: 'var(--ams-secondary)',
  incident: RED,
  info: 'var(--ams-muted, var(--muted))',
};

function DecisionLog({ feed }: { feed: OperationFeed }): ReactElement {
  if (feed.log.length === 0) {
    return (
      <p className="muted">
        No entries yet. Every operation-affecting decision — config change, prune, override action,
        adjudication, weekly evaluation — is appended here via{' '}
        <span className="mono">operation_log_append</span> in the session that makes it.
      </p>
    );
  }
  return (
    <div className="log-cards">
      {feed.log.map((e) => (
        <article key={e.id} className="tile" style={{ marginBottom: '0.75rem', borderLeft: `3px solid ${KIND_COLOR[e.kind] ?? AMBER}` }}>
          <div className="cap" style={{ color: KIND_COLOR[e.kind] ?? undefined }}>
            {e.kind.replace('_', ' ')} · {fmtDateTime(e.at)}
          </div>
          <div style={{ fontWeight: 600, margin: '0.2rem 0 0.4rem' }}>{e.title}</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.45 }}>{e.body}</div>
        </article>
      ))}
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function OperationPage(): Promise<ReactElement> {
  const db = await serverDb();
  const feed = await getOperation(db);

  if (!feed) {
    return (
      <div className="ams-dash">
        <h1>Operation <span className="chip soft">live · real money</span></h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_operation</span> RPC is deploying
          — migration 0124). Refresh shortly.
        </p>
      </div>
    );
  }

  return (
    <div className="ams-dash">
      <h1>
        Operation <span className="chip soft">live · real money</span>
      </h1>
      <p className="muted">
        The continuous cheap-early operation since {fmtDate(feed.lane.since)}. Every figure is capital that
        left the wallet — this is not paper. Design and the operator override of the &ldquo;no capital before
        a frozen PASS&rdquo; rule: <span className="mono">docs/ops/CHEAP-EARLY-ENTRY.md</span> §7.
      </p>

      <DecisionStrip feed={feed} />

      <h2>Daily digest</h2>
      <DailyDigest feed={feed} />

      <h2>Equity</h2>
      <Equity feed={feed} />

      <Attribution feed={feed} />
      <Benchmark feed={feed} />
      <SkipTelemetry feed={feed} />

      <h2>Ledger</h2>
      {feed.orders.length === 0 ? (
        <p className="muted">
          No live orders since {fmtDate(feed.lane.since)}. If the lane reads ARMED above, this is the expected
          day-1 state — the cell only fires when a market&apos;s ask sits inside the band during the [
          {feed.lane.leadMinH},{feed.lane.leadMaxH}]h window. Check the skip histogram above for why.
        </p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>placed</th><th>city</th><th>target</th><th>bucket</th><th>side</th>
              <th>limit</th><th>avg</th><th>size</th><th>matched</th><th>status</th>
              <th>outcome</th><th>cost</th><th>P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {feed.orders.map((o, i) => (
              <tr key={`${o.createdAt}-${i}`}>
                <td>{fmtDateTime(o.createdAt)}</td>
                <td>{o.city}</td>
                <td>{fmtDate(o.targetDate)}</td>
                <td className="mono">{o.label ?? '—'}</td>
                <td>{o.side}</td>
                <td>{o.price == null ? '—' : o.price.toFixed(3)}</td>
                <td>{o.avgPrice == null ? '—' : o.avgPrice.toFixed(3)}</td>
                <td>{o.size ?? '—'}</td>
                <td>{o.sizeMatched ?? '—'}</td>
                <td>{o.status}</td>
                <td style={{ color: !o.resolved ? AMBER : o.won ? GREEN : RED }}>
                  {!o.resolved ? 'open' : o.won ? 'WON' : 'lost'}
                </td>
                <td>{fmtUsd(o.costUsd)}</td>
                <td style={{ color: o.realizedUsd == null ? undefined : pnlColor(o.realizedUsd) }}>
                  {o.realizedUsd == null ? '—' : signedUsd(o.realizedUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Decision log</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        The narrative record: why the lane is pointed where it is, what was adjudicated, what changed and
        when. This page is the system of record — chat is the exception channel.
      </p>
      <DecisionLog feed={feed} />
    </div>
  );
}
