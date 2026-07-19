/**
 * /trading — the LIVE-RAIL activation + risk console (the read side of migration 0082, staged DARK).
 *
 * Read-only analytics over the operator-guarded dash_trading() RPC (TRADING-ACTIVATION.md): the master mode +
 * risk caps, the live-mode INTERLOCK verdict (trade_live_preflight — the gate/override, run-window, ordering
 * and daily-loss-kill checks), today's realized LIVE loss vs the kill threshold, the open LIVE order ledger +
 * per-market positions from the preflight checks payload, the dry-run shadow counts, and the config audit trail.
 *
 * This page NEVER writes — TRADE_MODE / trade_config are display-only here; every mutation is an operator RPC
 * (trade_config_set / trade_gate_override_*). The boundary (CLAUDE.md §9R): Claude builds the software; the
 * operator funds the dedicated wallet, holds the signing key (.env.local), and authorizes every run. No capital
 * before a frozen forward-paper §9R-E PASS — the SQL interlock encodes that gate.
 *
 * STAGED-DARK vs RPC ERROR (#22): while 0082 is unapplied, dash_trading() does not exist → getTrading()
 * returns { kind: 'not-applied' } → the explicit "0082 NOT APPLIED" empty-state. Every OTHER failure
 * (transient/DB-restart/auth) returns { kind: 'error' } → the distinct "console temporarily unavailable"
 * state — never a false "not applied" diagnosis after the migration IS applied. Neither path 500s.
 */
import type { ReactElement } from 'react';
import type {
  BuyTablePositionRow,
  BuyTableSection,
  CityLiveTwin,
  CityLiveView,
  LiveOrder,
  OpenPositionRow,
  OpenPositionsSection,
  TradeAuditRow,
  TradeConfig,
  TradePreflight,
  TradePreflightChecks,
  TradeToday,
  TradingView,
} from '../../../lib/loaders.ts';
import { getCityLive, getTrading } from '../../../lib/loaders.ts';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct, fmtProb, fmtStockholm, fmtUsd, num } from '../../../lib/format.ts';
import { serverDb } from '../../../lib/supabase.ts';
import { BuyTablePriceCapsPanel, CityArmsTable, GateOverridePanel, TradeConfigEditor } from '../../../components/trading-controls.tsx';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';
const SKY = 'var(--ams-secondary)';
const MUTED = 'var(--ams-muted)';

const signedUsd = (v: unknown, dp = 2): string => {
  const n = num(v);
  if (n === null) return '—';
  return `${n >= 0 ? '+' : '−'}${fmtUsd(Math.abs(n), dp)}`;
};
const short = (s: string | null | undefined, n = 12): string =>
  !s ? '—' : s.length > n ? `${s.slice(0, n)}…` : s;

const MODE_META: Record<string, { label: string; color: string; note: string }> = {
  off: { label: 'OFF', color: MUTED, note: 'daemon logs and exits — nothing constructed, no key read' },
  'dry-run': { label: 'DRY-RUN', color: SKY, note: 'builds + records the exact order (shadow), never posts at the venue' },
  live: { label: 'LIVE', color: RED, note: 'posts for real — but only per placement once the interlock PASSes' },
};

const ORDER_STATUS_COLOR: Record<string, string> = {
  intent: MUTED,
  placed: SKY,
  partial: AMBER,
  filled: GREEN,
  canceled: MUTED,
  failed: RED,
};

// ─── sub-components ──────────────────────────────────────────────────────────

/**
 * The RPC-error state (review #22) — dash_trading() EXISTS but the call failed (transient PostgREST error, a
 * DB restart like 07-05's 07:36Z crash, an operator_guard rejection). Deliberately DISTINCT from the
 * "0082 NOT APPLIED" state: telling the operator to re-apply a migration during a DB incident is a false
 * diagnosis with a wrong remediation.
 */
function RpcErrorState({ message }: { message: string }): ReactElement {
  return (
    <div className="ams-dash">
      <h1>
        Trading activation console <span className="chip soft">LIVE-RAIL · RPC error</span>
      </h1>
      <div className="info-banner" style={{ borderLeftColor: RED }}>
        <strong style={{ color: RED }}>Console temporarily unavailable.</strong> The{' '}
        <span className="mono">dash_trading()</span> RPC exists but the call <strong>failed</strong> — a
        transient database/PostgREST error or an auth rejection, <strong>not</strong> the
        &ldquo;0082 not applied&rdquo; staged-dark state. No migration action is needed; retry shortly (the SQL
        interlock, not this page, remains the authoritative gate).
      </div>
      <p className="muted small">
        Error: <span className="mono">{message}</span>
      </p>
    </div>
  );
}

/** The explicit "0082 NOT APPLIED" empty-state — the day-one state until the operator applies migration 0082. */
function NotAppliedState(): ReactElement {
  return (
    <div className="ams-dash">
      <h1>
        Trading activation console <span className="chip soft">LIVE-RAIL · 0082 dark</span>
      </h1>
      <div className="info-banner" style={{ borderLeftColor: AMBER }}>
        <strong style={{ color: AMBER }}>0082 NOT APPLIED.</strong> The{' '}
        <span className="mono">dash_trading()</span> RPC does not exist on this database yet — migration{' '}
        <span className="mono">0082_trading_activation.sql</span> is <strong>merged-dark, not applied</strong>. This
        console lights up the moment the operator applies 0082 (one <span className="mono">apply_migration</span> +
        the §-verify SQL in the migration header, per <span className="mono">LIVE-RAIL-NIGHT-HANDOFF.md</span> §
        &ldquo;Operator morning items&rdquo;). Applying it seeds the config surface DARK (<span className="mono">mode=&apos;off&apos;</span>),
        so nothing trades on apply — it only unlocks the dry-run ledger, this page&apos;s data, and the shadow
        harness.
      </div>
      <p className="muted small">
        Until then there is nothing to show — this is the intended degradation, not an error. Read-only console over{' '}
        <span className="mono">dash_trading()</span>; it never writes. Boundary (CLAUDE.md §9R): Claude builds the
        software; the operator funds the dedicated wallet, holds the signing key, and authorizes every run. No
        capital before a frozen forward-paper §9R-E PASS. Source:{' '}
        <span className="mono">TRADING-ACTIVATION.md</span> · <span className="mono">0082_trading_activation.sql</span>.
      </p>
    </div>
  );
}

/**
 * WS-A #5: true when the interlock's ONLY blocking reason is the gate branch (no forward-paper PASS and no
 * active override) — the exact state the operator was stuck in for two days (C42→C43). One click on the
 * override panel fixes it, so the banner surfaces a primary call-to-action instead of making the operator
 * diagnose which of the eight sections matters. NOT exported (Next rejects unknown page-module exports; the
 * behavior is pinned by the render tests) and NOT imported from trading-controls (calling a function across
 * the 'use client' boundary throws in RSC).
 */
function gateOnlyBlocking(ok: boolean, reasons: string[]): boolean {
  return !ok && reasons.length === 1 && /forward paper gate|trade_gate_override/i.test(reasons[0] ?? '');
}

/** The headline: the master mode + the live-mode interlock verdict (ok + the collected blocking reasons).
 * Sticky on mobile (the `sticky-verdict` class) so the posture stays visible while scrolling the long console. */
function VerdictBanner({ config, preflight }: { config: TradeConfig | null; preflight: TradePreflight | null }): ReactElement {
  const mode = config?.mode ?? preflight?.checks?.mode ?? 'off';
  const m = MODE_META[mode] ?? { label: mode.toUpperCase(), color: MUTED, note: '' };
  const ok = preflight?.ok ?? false;
  const reasons = preflight?.reasons ?? [];
  // ok === true means the interlock would PERMIT a live entry — the "hot" state under a dormant rail; ok === false
  // is the safe resting state (no live entries this tick). Never a green pass/fail — it is a posture readout.
  const verdictColor = ok ? AMBER : SKY;
  const verdictLabel = ok ? 'CLEAR — interlock permits live entries' : 'BLOCKED — no live entries';
  return (
    <div className="info-banner sticky-verdict" style={{ borderLeftColor: m.color }}>
      <strong style={{ color: m.color }}>MODE {m.label}.</strong>{' '}
      {m.note ? <span>{m.note}. </span> : null}
      Live-mode interlock (<span className="mono">trade_live_preflight</span>):{' '}
      <strong style={{ color: verdictColor }}>{verdictLabel}.</strong>{' '}
      A real post needs BOTH the env <span className="mono">TRADE_MODE=live</span> AND this interlock to clear per
      placement.
      {preflight && !ok && reasons.length > 0 ? (
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
          {reasons.map((r, i) => (
            <li key={i} className="small" style={{ color: MUTED }}>
              {r}
            </li>
          ))}
        </ul>
      ) : null}
      {preflight && gateOnlyBlocking(ok, reasons) ? (
        <div style={{ marginTop: '0.5rem' }}>
          <a
            className="pill"
            href="#gate-override"
            style={{ fontSize: '0.78rem', textDecoration: 'none' }}
            title="every other check clears — an active override arms the lane"
          >
            1 click from armed — set the gate override ↓
          </a>
        </div>
      ) : null}
      {preflight && ok ? (
        <div className="sub" style={{ marginTop: '0.4rem', color: AMBER }}>
          Every blocking condition clears — the daemon would place live this tick (subject to the per-placement caps).
        </div>
      ) : null}
    </div>
  );
}

/** The risk caps (read from `config` — authoritative, carries allowlist + kill fraction). The §9R $25 ceiling
 * is a DB CHECK on stake_per_buy / per_position; these tiles just display the current values. */
function CapsStrip({ config }: { config: TradeConfig }): ReactElement {
  const allow = config.city_allowlist;
  const activeUntil = config.active_until;
  const windowOpen = activeUntil != null && fmtDate(activeUntil) >= fmtDate(new Date().toISOString());
  return (
    <div className="strip">
      <div className="tile">
        <div className="cap">Stake / buy</div>
        <div className="big">{fmtUsd(config.stake_per_buy_usd, 0)}</div>
        <div className="sub">§9R ceiling ≤ $25 (DB CHECK)</div>
      </div>
      <div className="tile">
        <div className="cap">Per-position cap</div>
        <div className="big">{fmtUsd(config.per_position_cap_usd, 0)}</div>
        <div className="sub">§9R ceiling ≤ $25 (DB CHECK)</div>
      </div>
      <div className="tile">
        <div className="cap">Per-market cap</div>
        <div className="big">{fmtUsd(config.per_market_cap_usd, 0)}</div>
        <div className="sub">market exposure + stake ≤ this</div>
      </div>
      <div className="tile">
        <div className="cap">Total concurrent cap</div>
        <div className="big">{fmtUsd(config.total_concurrent_cap_usd, 0)}</div>
        <div className="sub">deployable-bankroll ceiling</div>
      </div>
      <div className="tile">
        <div className="cap">Daily-loss kill</div>
        <div className="big">{fmtUsd(config.daily_loss_kill_usd, 0)}</div>
        <div className="sub">or {fmtPct(config.daily_loss_kill_frac, 0)} × concurrent cap</div>
      </div>
      <div className="tile">
        <div className="cap">Run window</div>
        <div className="big" style={{ fontSize: '1.2rem', color: activeUntil ? (windowOpen ? GREEN : RED) : MUTED }}>
          {activeUntil ? `until ${fmtDate(activeUntil)}` : 'off'}
        </div>
        <div className="sub">{activeUntil ? (windowOpen ? 'open' : 'expired — blocks live') : 'active_until not set'}</div>
      </div>
      <div className="tile">
        <div className="cap">City allowlist</div>
        <div className="big" style={{ fontSize: '1.1rem' }}>{allow == null ? 'all cities' : `${allow.length} cities`}</div>
        <div className="sub">{allow == null ? 'null = all enrolled' : short(allow.join(', '), 40)}</div>
      </div>
      <div className="tile">
        <div className="cap">Config updated</div>
        <div className="big" style={{ fontSize: '1.1rem' }}>{config.updated_at ? fmtAgo(config.updated_at) : '—'}</div>
        <div className="sub mono">{config.updated_at ? fmtDateTime(config.updated_at) : '—'}</div>
      </div>
    </div>
  );
}

/** The interlock gate branch: the forward-paper PASS gate OR an ACTIVE, expiring operator override (0082 §7 4a/4b). */
function GateTiles({ checks }: { checks: TradePreflightChecks }): ReactElement {
  const gatePass = checks.gatePass;
  const override = checks.override;
  const satisfied = gatePass || override;
  return (
    <div className="strip">
      <div className="tile">
        <div className="cap">Forward-paper gate</div>
        <div className="big" style={{ fontSize: '1.4rem', color: gatePass ? GREEN : MUTED }}>
          {gatePass ? 'PASS' : 'no PASS'}
        </div>
        <div className="sub">latest bot_gate_snapshot (paper / forward). A backtest PASS never unlocks capital.</div>
      </div>
      <div className="tile rec">
        <div className="tile-head">
          <span className="cap">Operator override</span>
          <span className="chip soft">{override ? 'ACTIVE' : 'none'}</span>
        </div>
        <div className="big" style={{ fontSize: '1.4rem', color: override ? AMBER : MUTED }}>
          {override ? 'ON' : 'off'}
        </div>
        <div className="sub">
          {override ? (
            <>
              {checks.overrideReason ? <>&ldquo;{short(checks.overrideReason, 44)}&rdquo; · </> : null}
              expires {checks.overrideExpiresAt ? fmtDateTime(checks.overrideExpiresAt) : '—'}
              {checks.overrideExpiresAt ? <> ({fmtStockholm(checks.overrideExpiresAt)})</> : null}
            </>
          ) : (
            'no ACTIVE (unexpired) trade_gate_override row (≤14-day cap)'
          )}
        </div>
      </div>
      <div className="tile">
        <div className="cap">Gate branch</div>
        <div className="big" style={{ fontSize: '1.4rem', color: satisfied ? AMBER : SKY }}>
          {satisfied ? 'satisfied' : 'not satisfied'}
        </div>
        <div className="sub">{satisfied ? (gatePass ? 'via forward-paper PASS' : 'via operator override') : 'blocks live entries'}</div>
      </div>
    </div>
  );
}

/** Today's realized LIVE loss vs the binding kill threshold + today's fill cashflow (0082 §8, N1 realized-at-sell). */
function KillSection({ checks, today }: { checks: TradePreflightChecks; today: TradeToday | null }): ReactElement {
  const loss = num(checks.todayLossUsd) ?? 0;
  const killUsd = num(checks.dailyLossKillUsd);
  const fracBasis = num(checks.dailyLossKillFracBasisUsd);
  const thresholds = [killUsd, fracBasis].filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
  const binding = thresholds[0] ?? null; // the LOWER threshold trips first
  const frac = binding && binding > 0 ? loss / binding : null;
  const tripped = binding != null && loss >= binding;
  const meterColor = tripped ? RED : frac != null && frac >= 0.5 ? AMBER : GREEN;
  const pctWidth = frac != null ? Math.max(0, Math.min(100, frac * 100)) : 0;
  return (
    <>
      <div className="strip">
        <div className="tile rec">
          <div className="tile-head">
            <span className="cap">Today&apos;s realized loss</span>
            <span className="chip soft">{tripped ? 'KILL TRIPPED' : 'live'}</span>
          </div>
          <div className="big" style={{ color: loss > 0 ? RED : GREEN }}>{fmtUsd(loss)}</div>
          <div className="sub">
            binding kill {binding != null ? fmtUsd(binding) : '—'} = min(${killUsd ?? '—'} abs, {fmtUsd(fracBasis)} frac)
          </div>
          <div className="meter" style={{ marginTop: '0.3rem' }}>
            <span style={{ width: `${pctWidth}%`, background: meterColor }} />
          </div>
          <div className="sub">
            {frac != null ? fmtPct(frac, 0) : '—'} of the binding kill · window from{' '}
            <span className="mono">{checks.lossWindowStart ? fmtDateTime(checks.lossWindowStart) : '—'}</span> (UTC midnight)
          </div>
        </div>
        <div className="tile">
          <div className="cap">Kill (absolute)</div>
          <div className="big" style={{ fontSize: '1.4rem', color: killUsd != null && loss >= killUsd ? RED : undefined }}>
            {fmtUsd(killUsd, 0)}
          </div>
          <div className="sub">daily_loss_kill_usd</div>
        </div>
        <div className="tile">
          <div className="cap">Kill (fractional basis)</div>
          <div className="big" style={{ fontSize: '1.4rem', color: fracBasis != null && loss >= fracBasis ? RED : undefined }}>
            {fmtUsd(fracBasis, 2)}
          </div>
          <div className="sub">frac × total_concurrent_cap_usd</div>
        </div>
      </div>
      <div className="strip">
        <div className="tile">
          <div className="cap">Today · bought</div>
          <div className="big" style={{ fontSize: '1.5rem' }}>{fmtUsd(today?.buyUsd ?? 0)}</div>
          <div className="sub">capital deployed (LIVE fills)</div>
        </div>
        <div className="tile">
          <div className="cap">Today · sold</div>
          <div className="big" style={{ fontSize: '1.5rem' }}>{fmtUsd(today?.sellUsd ?? 0)}</div>
          <div className="sub">capital returned (LIVE fills)</div>
        </div>
        <div className="tile">
          <div className="cap">Today · fees</div>
          <div className="big" style={{ fontSize: '1.5rem' }}>{fmtUsd(today?.feeUsd ?? 0)}</div>
          <div className="sub">buy-side fees inside the window</div>
        </div>
        <div className="tile">
          <div className="cap">Today · net cashflow</div>
          <div className="big" style={{ fontSize: '1.5rem', color: (num(today?.netUsd) ?? 0) >= 0 ? GREEN : RED }}>
            {signedUsd(today?.netUsd ?? 0)}
          </div>
          <div className="sub">sell − buy − fees · informational (NOT the kill loss)</div>
        </div>
        <div className="tile">
          <div className="cap">Today · fills</div>
          <div className="big sky" style={{ fontSize: '1.5rem' }}>{num(today?.nFills) ?? 0}</div>
          <div className="sub">count only — no per-fill rows in this payload</div>
        </div>
      </div>
    </>
  );
}

// ─── OPEN POSITIONS (0112) — held shares marked to the latest captured book ──────────────────────────────

/** Mark age → color: fresh (≤20m) muted, aging amber, stale (>60m) red — the capture cadence is ~15m. */
const markAgeColor = (markAt: string | null, nowMs: number): string => {
  if (!markAt) return RED;
  const ageMin = (nowMs - Date.parse(markAt)) / 60_000;
  return ageMin <= 20 ? MUTED : ageMin <= 60 ? AMBER : RED;
};

/** One held-position row: identity → basis → current mark → unrealized verdict. */
function OpenPositionRowTr({ r, nowMs }: { r: OpenPositionRow; nowMs: number }): ReactElement {
  const shares = num(r.shares) ?? 0;
  const cost = num(r.costUsd) ?? 0;
  const unrealMid = num(r.unrealizedMidUsd);
  const unrealBid = num(r.unrealizedBidUsd);
  const pct = unrealMid != null && cost > 0 ? unrealMid / cost : null;
  const bid = num(r.curBid);
  const ask = num(r.curAsk);
  return (
    <tr>
      <td className="small">
        {r.cityName ?? r.city ?? <span className="mono">{short(r.marketId, 14)}</span>}
        {r.city && r.cityName ? <span className="muted small"> {r.city}</span> : null}
      </td>
      <td className="small">{r.label ?? '—'}</td>
      <td className="mono small">{r.targetDate ?? '—'}</td>
      <td className="num">{shares}</td>
      <td className="num" title="venue-truth average BUY fill price (ex-fee)">{fmtProb(r.avgPrice)}</td>
      <td className="num" title={`bid ${bid != null ? fmtProb(bid) : '—'} · ask ${ask != null ? fmtProb(ask) : '—'}`}>
        {r.curMid == null ? <span className="muted">no mark</span> : fmtProb(r.curMid)}
        {bid != null || ask != null ? (
          <div className="muted small">{bid != null ? fmtProb(bid) : '—'} / {ask != null ? fmtProb(ask) : '—'}</div>
        ) : null}
      </td>
      <td className="num">{fmtUsd(r.costUsd)}</td>
      <td className="num">{r.valueMidUsd == null ? '—' : fmtUsd(r.valueMidUsd)}</td>
      <td className="num" style={{ color: unrealMid == null ? undefined : unrealMid >= 0 ? GREEN : RED }}>
        {unrealMid == null ? '—' : signedUsd(unrealMid)}
        {pct != null ? <span className="muted small"> {pct >= 0 ? '+' : '−'}{fmtPct(Math.abs(pct), 0)}</span> : null}
        {unrealBid != null ? (
          <div className="muted small" title="what selling into the current best bid would realize vs cost">
            {signedUsd(unrealBid)} @bid
          </div>
        ) : null}
      </td>
      <td className="num small" style={{ color: markAgeColor(r.markAt, nowMs) }}>
        {r.markAt ? fmtAgo(r.markAt) : 'no mark'}
      </td>
    </tr>
  );
}

/**
 * The 0112 held-position ledger — what was bought (temperature bucket), the entry price, the CURRENT
 * bid/mid from the newest opening_captures tick, and the unrealized win/loss per position + in total.
 * Positions are held to close (no exits by design) — the mark is informational, not an exit plan.
 */
function OpenPositionsPanel({ section }: { section: OpenPositionsSection }): ReactElement {
  const t = section.totals;
  const rows = section.rows;
  const nowMs = Date.now();
  const cost = num(t?.costUsd) ?? 0;
  const unrealMid = num(t?.unrealizedMidUsd);
  const unrealBid = num(t?.unrealizedBidUsd);
  const pctMid = unrealMid != null && cost > 0 ? unrealMid / cost : null;
  const nPos = num(t?.nPositions) ?? rows.length;
  const nMarked = num(t?.nMarked) ?? 0;
  return (
    <div className="panel">
      <div className="cap" style={{ marginBottom: '0.25rem' }}>
        Open positions — {nPos} held · marked to the latest captured book
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        One row per held (market, token) across every live lane: net shares, the venue-truth average entry
        price, and the <strong>current</strong> price (mid, with bid/ask beneath) from the newest{' '}
        <span className="mono">opening_captures</span> tick. Win/loss is <strong>unrealized</strong> at the
        mid mark (the <span className="mono">@bid</span> figure is what selling into the book right now would
        realize — a book with <strong>no bid</strong> marks that at $0, and its mid falls back to the visible
        side&apos;s midpoint) — positions are held to close, so resolution settles each at $1 or $0 regardless.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No open positions.</p>
      ) : (
        <>
          <div className="strip">
            <div className="tile">
              <div className="cap">Positions</div>
              <div className="big sky" style={{ fontSize: '1.5rem' }}>{nPos}</div>
              <div className="sub">{nMarked} of {nPos} with a live mark</div>
            </div>
            <div className="tile">
              <div className="cap">Cost deployed</div>
              <div className="big" style={{ fontSize: '1.5rem' }}>{fmtUsd(t?.costUsd ?? 0)}</div>
              <div className="sub">all-in fills + fees, sells netted</div>
            </div>
            <div className="tile">
              <div className="cap">Market value</div>
              <div className="big" style={{ fontSize: '1.5rem' }}>{fmtUsd(t?.valueMidUsd ?? 0)}</div>
              <div className="sub">at mid · {fmtUsd(t?.valueBidUsd ?? 0)} at bid</div>
            </div>
            <div className="tile rec">
              <div className="tile-head">
                <span className="cap">Unrealized win/loss</span>
                <span className="chip soft">{pctMid != null ? `${pctMid >= 0 ? '+' : '−'}${fmtPct(Math.abs(pctMid), 0)}` : '—'}</span>
              </div>
              <div className="big" style={{ fontSize: '1.5rem', color: (unrealMid ?? 0) >= 0 ? GREEN : RED }}>
                {unrealMid == null ? '—' : signedUsd(unrealMid)}
              </div>
              <div className="sub">at mid · {unrealBid == null ? '—' : signedUsd(unrealBid)} @bid (marked rows only)</div>
            </div>
          </div>
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>city</th>
                  <th>bought</th>
                  <th>date</th>
                  <th className="num">shares</th>
                  <th className="num">buy px</th>
                  <th className="num">cur px</th>
                  <th className="num">cost</th>
                  <th className="num">value</th>
                  <th className="num">win/loss</th>
                  <th className="num">mark</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <OpenPositionRowTr key={`${r.marketId}:${r.tokenId ?? ''}`} r={r} nowMs={nowMs} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** The cap-enforcement view: total exposure + per-market cost-basis from the preflight checks payload
 * (also counts unfilled resting commitments, so it can legitimately exceed the held-position cost above). */
function ExposureSection({ checks, openExposureUsd }: { checks: TradePreflightChecks; openExposureUsd: unknown }): ReactElement {
  const perMarket = Object.entries(checks.perMarketExposureUsd ?? {}).sort((a, b) => (num(b[1]) ?? 0) - (num(a[1]) ?? 0));
  const total = num(openExposureUsd) ?? num(checks.openExposureUsd) ?? 0;
  return (
    <div className="panel">
      <div className="cap" style={{ marginBottom: '0.25rem' }}>
        Open LIVE exposure — {fmtUsd(total)} total · {perMarket.length} market{perMarket.length === 1 ? '' : 's'}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Buy-side cost-basis over open rows (status intent/placed/partial) — the per-market map the runner enforces
        the per-market + total-concurrent caps against, straight from <span className="mono">preflight.checks</span>.
      </p>
      {perMarket.length === 0 ? (
        <p className="muted">No open LIVE positions.</p>
      ) : (
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>market</th>
                <th className="num">exposure</th>
                <th className="num">vs per-market cap</th>
              </tr>
            </thead>
            <tbody>
              {perMarket.map(([market, usd]) => {
                const cap = num(checks.perMarketCapUsd);
                const e = num(usd) ?? 0;
                const frac = cap && cap > 0 ? e / cap : null;
                return (
                  <tr key={market}>
                    <td className="mono small">{short(market, 22)}</td>
                    <td className="num">{fmtUsd(usd)}</td>
                    <td className="num" style={{ color: frac != null && frac >= 1 ? RED : undefined }}>
                      {frac != null ? fmtPct(frac, 0) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The open LIVE order ledger (dash_trading.openOrders — open rows only; terminal/filled + dry-run not enumerated). */
function OrdersTable({ orders }: { orders: LiveOrder[] }): ReactElement {
  if (orders.length === 0) return <p className="muted">No open LIVE orders.</p>;
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th className="num">age</th>
            <th>market</th>
            <th>side</th>
            <th>purpose</th>
            <th>type</th>
            <th className="num">price</th>
            <th className="num">size</th>
            <th className="num">filled</th>
            <th className="num">avg px</th>
            <th>status</th>
            <th>order id</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const size = num(o.size) ?? 0;
            const matched = num(o.size_matched) ?? 0;
            const fillPct = size > 0 ? matched / size : null;
            return (
              <tr key={o.id}>
                <td className="num small">{fmtAgo(o.created_at)}</td>
                <td className="mono small">{short(o.market_id, 16)}</td>
                <td className="small" style={{ color: o.side === 'BUY' ? SKY : AMBER }}>{o.side}</td>
                <td className="small">{o.purpose}</td>
                <td className="small mono">{o.order_type}</td>
                <td className="num">{fmtProb(o.price)}</td>
                <td className="num">{size}</td>
                <td className="num">{matched}{fillPct != null ? <span className="muted small"> {fmtPct(fillPct, 0)}</span> : null}</td>
                <td className="num">{o.avg_price != null ? fmtProb(o.avg_price) : '—'}</td>
                <td className="small">
                  <span className="chip small" style={{ color: ORDER_STATUS_COLOR[o.status] ?? undefined }}>{o.status}</span>
                </td>
                <td className="mono small">{short(o.order_id, 12)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── BUY-TABLE positions (0096) — the lane's ANY-status ledger + per-position outcome ─────────────────────

const BUY_TABLE_PRICE_CAP = 0.15; // the 0095 buy_table.price_cap default — display reference only

const OUTCOME_COLOR: Record<string, string> = {
  won: GREEN,
  lost: RED,
  open: SKY,
  unfilled: MUTED,
  failed: RED,
};

/** The lane totals strip (dash_trading.buyTable.totals) — cost deployed, resolved P&L, outcome counts. */
function BuyTableTotalsStrip({ section }: { section: BuyTableSection }): ReactElement {
  const t = section.totals;
  const pnl = num(t?.resolvedPnlUsd) ?? 0;
  return (
    <div className="strip">
      <div className="tile">
        <div className="cap">Lane cost</div>
        <div className="big" style={{ fontSize: '1.5rem' }}>{fmtUsd(t?.costUsd ?? 0)}</div>
        <div className="sub">all-in cost of matched shares (fills + fees)</div>
      </div>
      <div className="tile">
        <div className="cap">Resolved P&amp;L</div>
        <div className="big" style={{ fontSize: '1.5rem', color: pnl >= 0 ? GREEN : RED }}>
          {signedUsd(t?.resolvedPnlUsd ?? 0)}
        </div>
        <div className="sub">won + lost positions only — open positions not marked</div>
      </div>
      <div className="tile">
        <div className="cap">Won / lost</div>
        <div className="big" style={{ fontSize: '1.5rem' }}>
          <span style={{ color: GREEN }}>{num(t?.nWon) ?? 0}</span>
          <span className="muted"> / </span>
          <span style={{ color: RED }}>{num(t?.nLost) ?? 0}</span>
        </div>
        <div className="sub">resolved against the market_events winner</div>
      </div>
      <div className="tile">
        <div className="cap">Open</div>
        <div className="big sky" style={{ fontSize: '1.5rem' }}>{num(t?.nOpen) ?? 0}</div>
        <div className="sub">held to close — no exits by design</div>
      </div>
      <div className="tile">
        <div className="cap">Rows</div>
        <div className="big" style={{ fontSize: '1.5rem' }}>{num(t?.nRows) ?? 0}</div>
        <div className="sub">every lane row, ANY status (newest 200)</div>
      </div>
    </div>
  );
}

/** The lane position table (dash_trading.buyTable.rows) — ANY-status rows the open-order ledger drops. */
function BuyTablePositionsTable({ rows }: { rows: BuyTablePositionRow[] }): ReactElement {
  if (rows.length === 0) return <p className="muted">No buy-table positions yet.</p>;
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th className="num">age</th>
            <th>city</th>
            <th>date</th>
            <th>label / market</th>
            <th className="num">entry px</th>
            <th className="num">shares</th>
            <th className="num">cost</th>
            <th>status</th>
            <th>outcome</th>
            <th className="num">resolved P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const px = num(r.avgPrice) ?? num(r.price);
            const overCap = px != null && px > BUY_TABLE_PRICE_CAP + 1e-9;
            const pnl = num(r.resolvedPnlUsd);
            return (
              <tr key={r.id}>
                <td className="num small">{r.createdAt ? fmtAgo(r.createdAt) : '—'}</td>
                <td className="small">{r.city ?? '—'}</td>
                <td className="mono small">{r.targetDate ?? r.tradeDate ?? '—'}</td>
                <td className="small">
                  {r.label ?? <span className="mono">{short(r.marketId, 16)}</span>}
                </td>
                <td
                  className="num"
                  style={{ color: overCap ? AMBER : undefined }}
                  title={`entry vs the ${BUY_TABLE_PRICE_CAP.toFixed(2)} price cap (buy_table.price_cap)`}
                >
                  {fmtProb(px)}
                </td>
                <td className="num">{num(r.sizeMatched) ?? 0}<span className="muted small"> / {num(r.size) ?? 0}</span></td>
                <td className="num">{fmtUsd(r.costUsd)}</td>
                <td className="small">
                  <span className="chip small" style={{ color: ORDER_STATUS_COLOR[r.status] ?? undefined }}>{r.status}</span>
                </td>
                <td className="small">
                  <span className="chip small" style={{ color: OUTCOME_COLOR[r.outcome] ?? undefined }}>{r.outcome}</span>
                </td>
                <td className="num" style={{ color: pnl == null ? undefined : pnl >= 0 ? GREEN : RED }}>
                  {pnl == null ? '—' : signedUsd(pnl)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Dry-run shadow-rail counts (dash_trading.dryRun — count only; the shadow-diff harness reads the rows). */
function DryRunTiles({ dryRun }: { dryRun: TradingView['dryRun'] }): ReactElement {
  return (
    <div className="strip">
      <div className="tile">
        <div className="cap">Dry-run · open</div>
        <div className="big sky" style={{ fontSize: '1.6rem' }}>{num(dryRun?.openOrders) ?? 0}</div>
        <div className="sub">shadow orders working (intent/placed/partial)</div>
      </div>
      <div className="tile">
        <div className="cap">Dry-run · total</div>
        <div className="big" style={{ fontSize: '1.6rem' }}>{num(dryRun?.total) ?? 0}</div>
        <div className="sub">all shadow rows ever recorded — never count toward caps/loss</div>
      </div>
    </div>
  );
}

const auditMode = (v: Record<string, unknown> | null): string => (v && typeof v['mode'] === 'string' ? (v['mode'] as string) : '—');

/** The config change log (dash_trading.recentAudit — append-only whole-config old→new, last 20). */
function AuditTable({ rows }: { rows: TradeAuditRow[] }): ReactElement {
  if (rows.length === 0) return <p className="muted">No config changes recorded.</p>;
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>when</th>
            <th>by (role)</th>
            <th>mode</th>
            <th className="num">stake</th>
            <th className="num">concurrent cap</th>
            <th className="num">daily kill</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const oldMode = auditMode(a.old_value);
            const newMode = auditMode(a.new_value);
            const nv: Record<string, unknown> = a.new_value ?? {};
            return (
              <tr key={String(a.id)}>
                <td className="mono small" title={fmtStockholm(a.changed_at)}>{fmtDateTime(a.changed_at)}</td>
                <td className="small mono">{a.changed_by}</td>
                <td className="small">{oldMode === newMode ? newMode : `${oldMode} → ${newMode}`}</td>
                <td className="num">{fmtUsd(nv['stake_per_buy_usd'], 0)}</td>
                <td className="num">{fmtUsd(nv['total_concurrent_cap_usd'], 0)}</td>
                <td className="num">{fmtUsd(nv['daily_loss_kill_usd'], 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── CITY-LIVE (lane W) — winners board + staged-dark degradation (dash_city_live, 0085) ──────────────────

const CITY_STATUS_COLOR: Record<string, string> = {
  PROMOTED: GREEN,
  WATCH: AMBER,
  INSUFFICIENT: MUTED,
  DEMOTED: RED,
};

/** The "front the winners" board (dash_city_live.board) — ranked promotion rows + the taker-vs-maker paper twin. */
function WinnersBoard({ board, twin }: { board: CityLiveView['board']; twin: CityLiveTwin[] }): ReactElement {
  const rows = board.rows;
  if (rows.length === 0) {
    return (
      <p className="muted">
        No promotion board yet — the engine fronts ranked winners once the multi-city paper-trade ledger accrues
        (floors: ≥20 graded bets AND ≥10 distinct days per city).
      </p>
    );
  }
  const twinByCity = new Map(twin.map((t) => [t.cityId, t]));
  return (
    <div className="panel">
      <p className="muted small" style={{ marginTop: 0 }}>
        Ranked by the recommended arm&apos;s edge lower-bound (<span className="mono">edgeCiLo</span>) — PROMOTED
        first. Promotion is <strong>advisory</strong> (the Live toggle below is the authorization; Karachi is a
        point-estimate winner of a 45-city race — the live toggle test is the real gate). The taker-vs-maker twin
        columns are the longitudinal paper differential (maker fill is a conservative lower bound).
        {board.asOf ? (
          <>
            {' '}Board <span className="mono">{fmtDateTime(board.asOf)}</span>.
          </>
        ) : null}
      </p>
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>
              <th>city</th>
              <th>status</th>
              <th className="num">edge</th>
              <th className="num">edge CI</th>
              <th className="num">nBets</th>
              <th className="num">nDays</th>
              <th className="num">rec hour</th>
              <th className="num">twin fills</th>
              <th className="num">taker P&amp;L</th>
              <th className="num">maker twin P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = twinByCity.get(r.cityId);
              const color = CITY_STATUS_COLOR[r.status] ?? MUTED;
              return (
                <tr key={r.cityId}>
                  <td>
                    {r.slug} <span className="muted small mono">{r.icao}</span>
                  </td>
                  <td>
                    <span className="chip small" style={{ color }} title={(r.reasons ?? []).join(' · ')}>
                      {r.status}
                    </span>
                  </td>
                  <td className="num" style={{ color: (r.edge ?? 0) >= 0 ? GREEN : RED }}>{fmtPct(r.edge)}</td>
                  <td className="num small">
                    {r.edgeCiLo != null && r.edgeCiHi != null ? `[${fmtPct(r.edgeCiLo)}, ${fmtPct(r.edgeCiHi)}]` : '—'}
                  </td>
                  <td className="num">{num(r.nBets) ?? 0}</td>
                  <td className="num">{num(r.nDays) ?? 0}</td>
                  <td className="num">{r.recommendedHour == null ? '—' : `${r.recommendedHour}:00`}</td>
                  <td className="num">
                    {t ? fmtPct(t.twinFilledFrac, 0) : '—'}
                    {t ? <span className="muted small"> ({num(t.nPlacements) ?? 0})</span> : null}
                  </td>
                  <td className="num" style={{ color: (num(t?.takerPnlUsd) ?? 0) >= 0 ? GREEN : RED }}>
                    {t ? signedUsd(t.takerPnlUsd) : '—'}
                  </td>
                  <td className="num" style={{ color: (num(t?.makerTwinPnlUsd) ?? 0) >= 0 ? GREEN : RED }}>
                    {t ? signedUsd(t.makerTwinPnlUsd) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The CITY-LIVE staged-dark state — dash_city_live() (migration 0085) not applied yet. Distinct from an error. */
function CityLiveNotApplied(): ReactElement {
  return (
    <div className="info-banner" style={{ borderLeftColor: AMBER }}>
      <strong style={{ color: AMBER }}>0085 NOT APPLIED.</strong> The{' '}
      <span className="mono">dash_city_live()</span> RPC does not exist on this database yet — migration{' '}
      <span className="mono">0085_city_live.sql</span> is <strong>merged-dark, not applied</strong>. The winners board
      and the per-city Live arms light up the moment the operator applies 0085. Applying it seeds the arms surface
      DARK (nothing enabled), so nothing arms on apply.
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function TradingPage(): Promise<ReactElement> {
  const db = await serverDb();
  const load = await getTrading(db);

  // #22: only the undefined-function class renders "0082 NOT APPLIED"; every other failure is an RPC error.
  if (load.kind === 'not-applied') return <NotAppliedState />;
  if (load.kind === 'error') return <RpcErrorState message={load.message} />;

  const view = load.view;
  const { config, preflight } = view;
  // The CITY-LIVE surface (0085) degrades INDEPENDENTLY of 0082 — its own staged-dark / error split, so applying
  // 0082 first (already true on prod) still renders the full console with a "0085 not applied" note for the
  // promotion sections until 0085 lands.
  const cityLive = await getCityLive(db);

  // The valid slug domain for the allowlist picker AND the buy-table price-cap table (0094: the FULL
  // cities.slug domain trade_config_set / buy_table_city_cap_set validate against — enrolled (racing)
  // cities flagged in the label; pre-0094 payloads degrade to the enrolled arms, the old narrower set).
  const cityOptions: { slug: string; label: string }[] =
    cityLive.kind === 'ok'
      ? cityLive.view.allCities.length > 0
        ? cityLive.view.allCities.map((c) => ({
            slug: c.slug,
            label: c.enrolled ? `${c.displayName} · enrolled` : c.displayName,
          }))
        : cityLive.view.arms.map((arm) => ({ slug: arm.slug, label: arm.displayName }))
      : [];

  return (
    <div className="ams-dash">
      <h1>
        {/* the badge tracks trade_config.mode — a static "rail DORMANT" chip misled remote check-ins once
            the operator armed the 07-11 live lane */}
        Trading activation console{' '}
        <span className="chip soft">
          LIVE-RAIL · {config?.mode === 'live' ? 'mode LIVE' : config?.mode === 'dry-run' ? 'mode dry-run' : 'rail DORMANT'}
        </span>
      </h1>
      <p className="muted small">
        The read side of the <strong>0082 activation + risk console</strong> — the master mode, the risk caps, the
        live-mode <strong>interlock</strong> verdict (<span className="mono">trade_live_preflight</span>), today&apos;s
        realized LIVE loss vs the kill threshold, the open LIVE order ledger + per-market positions, the dry-run
        shadow counts, and the config audit trail. <strong>Display-only</strong> — this page never writes; every
        mutation is an operator RPC. Boundary (CLAUDE.md §9R): Claude builds the software; the operator funds the
        dedicated wallet, holds the signing key, and authorizes every run. <strong>No capital</strong> before a
        frozen forward-paper §9R-E PASS.
        {view.generatedAt ? (
          <>
            {' '}Snapshot <span className="mono">{fmtAgo(view.generatedAt)}</span> (
            <span className="mono">{fmtDateTime(view.generatedAt)}</span> · {fmtStockholm(view.generatedAt)}).
          </>
        ) : null}
      </p>

      <VerdictBanner config={config} preflight={preflight} />

      <h2>Risk caps</h2>
      {config ? <CapsStrip config={config} /> : <p className="muted">No config row.</p>}

      <h2>Interlock gate</h2>
      {preflight ? <GateTiles checks={preflight.checks} /> : <p className="muted">No preflight payload.</p>}
      {/* The override set/renew/clear control (2026-07-12): the gate branch's operator escape hatch was
          display-only — an expiring override could not be renewed remotely. Rendered even without a
          preflight payload (state degrades to "none") so a failed dash read never hides the control. */}
      <GateOverridePanel
        active={preflight?.checks.override ?? false}
        reason={preflight?.checks.overrideReason ?? null}
        expiresAt={preflight?.checks.overrideExpiresAt ?? null}
      />

      <h2>Daily-loss kill</h2>
      {preflight ? (
        <KillSection checks={preflight.checks} today={view.today} />
      ) : (
        <p className="muted">No preflight payload.</p>
      )}

      <h2>Open positions &amp; exposure</h2>
      {/* 0112: the held-position ledger marked to the latest captured book (what was bought, entry vs
          current price, unrealized win/loss). Degrades to its own staged-dark note while openPositions is
          absent; the per-market cap-enforcement table below renders in BOTH states. */}
      {view.openPositions ? (
        <OpenPositionsPanel section={view.openPositions} />
      ) : (
        <p className="muted small">
          <strong style={{ color: AMBER }}>0112 not applied</strong> — the{' '}
          <span className="mono">dash_trading()</span> payload carries no{' '}
          <span className="mono">openPositions</span> key yet. The marked position ledger (entry vs current
          price + unrealized win/loss) lights up the moment the operator applies migration{' '}
          <span className="mono">0112_trading_open_positions.sql</span> (read-only — nothing else changes on
          apply). Until then the cap-enforcement exposure map below is the only positions view.
        </p>
      )}
      {preflight ? (
        <ExposureSection checks={preflight.checks} openExposureUsd={view.openExposureUsd} />
      ) : (
        <p className="muted">No preflight payload.</p>
      )}

      <h2>Open LIVE order ledger</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          Open live orders only (status intent/placed/partial). Terminal/filled orders and ALL dry-run rows are not
          enumerated in <span className="mono">dash_trading()</span> — fills appear only as today&apos;s aggregate
          counts above.
        </p>
        <OrdersTable orders={view.openOrders} />
      </div>

      <h2>Buy-table positions</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          The <strong>BUY-TABLE live lane</strong> (migration 0095, <span className="mono">buy-table-tick</span>):
          every <span className="mono">strategy=&apos;buy-table&apos;</span> LIVE row of <strong>ANY status</strong> — a
          filled taker FAK leaves the open-order ledger above instantly, so this is where the lane&apos;s held
          positions live. Outcome grades against the market winner
          (<span className="mono">market_events</span>); positions are held to close (no exits by design).
        </p>
        {view.buyTable ? (
          <>
            <BuyTableTotalsStrip section={view.buyTable} />
            <BuyTablePositionsTable rows={view.buyTable.rows} />
          </>
        ) : (
          <p className="muted small">
            <strong style={{ color: AMBER }}>0096 not applied</strong> — the{' '}
            <span className="mono">dash_trading()</span> payload carries no{' '}
            <span className="mono">buyTable</span> key yet. The lane position ledger lights up the moment the
            operator applies migration <span className="mono">0096_buy_table_positions.sql</span> (read-only —
            nothing else changes on apply).
          </p>
        )}
      </div>

      <h2>Dry-run shadow rail</h2>
      <DryRunTiles dryRun={view.dryRun} />

      <h2>Config change log</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          Append-only whole-config audit trail (last 20 changes). <span className="mono">by (role)</span> is the
          effective DB role at write time (service_role for a direct write; the definer owner for an operator RPC),
          not a person.
        </p>
        <AuditTable rows={view.recentAudit} />
      </div>

      <h2>Trade config control</h2>
      {config ? (
        <TradeConfigEditor config={config} cityOptions={cityOptions} />
      ) : (
        <p className="muted">No config row to edit.</p>
      )}
      {/* 0109 (max-only — the 0097 min bound was removed by operator directive): the BUY-TABLE purchase-price
          caps — the global cap + per-city MAX overrides the tick trades by; the lane buys whenever the ask is
          at or below the effective cap. Degrades to its own "not applied" note while priceConfig is absent.
          0099/0100 add the live-cycle lo/hi date columns via the separate fail-soft buy_table_live_cycles()
          RPC — a slow or absent cycles read drops ONLY the columns (the 0098 inline read timed the console out). */}
      <BuyTablePriceCapsPanel
        priceConfig={view.buyTable?.priceConfig ?? null}
        allowlist={config?.city_allowlist ?? null}
        cityOptions={cityOptions}
        liveCycles={view.buyTable?.liveCycles ?? null}
      />

      <h2>Winners board — front the winners</h2>
      {cityLive.kind === 'ok' ? (
        <WinnersBoard board={cityLive.view.board} twin={cityLive.view.twin} />
      ) : cityLive.kind === 'not-applied' ? (
        <CityLiveNotApplied />
      ) : (
        <div className="info-banner" style={{ borderLeftColor: RED }}>
          <strong style={{ color: RED }}>City-live console temporarily unavailable.</strong> The{' '}
          <span className="mono">dash_city_live()</span> RPC exists but the call failed —{' '}
          <span className="mono">{cityLive.message}</span>. Not the &ldquo;0085 not applied&rdquo; state; retry shortly.
        </div>
      )}

      <h2>City Live arms</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Manual per-city Live toggle (envelope: <strong>$5/day per city, max 2 enabled</strong>, both SQL-enforced).
        The toggle is the authorization — nothing trades until the daemon runs live AND{' '}
        <span className="mono">trade_live_preflight(&apos;city-taker&apos;)</span> passes.
      </p>
      {cityLive.kind === 'ok' ? (
        <CityArmsTable arms={cityLive.view.arms} />
      ) : cityLive.kind === 'not-applied' ? (
        <p className="muted small">City Live arms unlock when migration 0085 is applied.</p>
      ) : (
        <p className="muted small">City Live arms temporarily unavailable — retry shortly.</p>
      )}

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the operator-guarded <span className="mono">dash_trading()</span> RPC (migration
        0082, staged dark). Rail DORMANT; TRADE_MODE / trade_config are display-only here. Source:{' '}
        <span className="mono">TRADING-ACTIVATION.md</span> · <span className="mono">0082_trading_activation.sql</span>{' '}
        · <span className="mono">FINDINGS.md</span> (the 12th signal).
      </p>
    </div>
  );
}
