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
 * STAGED-DARK: migration 0082 is merged-dark and NOT applied on prod, so dash_trading() does not exist there yet
 * → getTrading() returns null → this page renders its explicit "0082 NOT APPLIED" empty-state. The error path IS
 * the day-one state (it degrades gracefully; it does not 500).
 */
import type { ReactElement } from 'react';
import type {
  LiveOrder,
  TradeAuditRow,
  TradeConfig,
  TradePreflight,
  TradePreflightChecks,
  TradeToday,
  TradingView,
} from '../../../lib/loaders.ts';
import { getTrading } from '../../../lib/loaders.ts';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct, fmtProb, fmtStockholm, fmtUsd, num } from '../../../lib/format.ts';
import { serverDb } from '../../../lib/supabase.ts';

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

/** The headline: the master mode + the live-mode interlock verdict (ok + the collected blocking reasons). */
function VerdictBanner({ config, preflight }: { config: TradeConfig | null; preflight: TradePreflight | null }): ReactElement {
  const mode = config?.mode ?? preflight?.checks?.mode ?? 'off';
  const m = MODE_META[mode] ?? { label: mode.toUpperCase(), color: MUTED, note: '' };
  const ok = preflight?.ok ?? false;
  // ok === true means the interlock would PERMIT a live entry — the "hot" state under a dormant rail; ok === false
  // is the safe resting state (no live entries this tick). Never a green pass/fail — it is a posture readout.
  const verdictColor = ok ? AMBER : SKY;
  const verdictLabel = ok ? 'CLEAR — interlock permits live entries' : 'BLOCKED — no live entries';
  return (
    <div className="info-banner" style={{ borderLeftColor: m.color }}>
      <strong style={{ color: m.color }}>MODE {m.label}.</strong>{' '}
      {m.note ? <span>{m.note}. </span> : null}
      Live-mode interlock (<span className="mono">trade_live_preflight</span>):{' '}
      <strong style={{ color: verdictColor }}>{verdictLabel}.</strong>{' '}
      A real post needs BOTH the env <span className="mono">TRADE_MODE=live</span> AND this interlock to clear per
      placement.
      {preflight && !ok && (preflight.reasons ?? []).length > 0 ? (
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
          {(preflight.reasons ?? []).map((r, i) => (
            <li key={i} className="small" style={{ color: MUTED }}>
              {r}
            </li>
          ))}
        </ul>
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

/** Open LIVE positions from the preflight checks payload: total exposure + per-market cost-basis. */
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

// ─── page ────────────────────────────────────────────────────────────────────

export default async function TradingPage(): Promise<ReactElement> {
  const db = await serverDb();
  const view = await getTrading(db);

  if (!view) return <NotAppliedState />;

  const { config, preflight } = view;

  return (
    <div className="ams-dash">
      <h1>
        Trading activation console <span className="chip soft">LIVE-RAIL · rail DORMANT</span>
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

      <h2>Daily-loss kill</h2>
      {preflight ? (
        <KillSection checks={preflight.checks} today={view.today} />
      ) : (
        <p className="muted">No preflight payload.</p>
      )}

      <h2>Open positions &amp; exposure</h2>
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

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the operator-guarded <span className="mono">dash_trading()</span> RPC (migration
        0082, staged dark). Rail DORMANT; TRADE_MODE / trade_config are display-only here. Source:{' '}
        <span className="mono">TRADING-ACTIVATION.md</span> · <span className="mono">0082_trading_activation.sql</span>{' '}
        · <span className="mono">FINDINGS.md</span> (the 12th signal).
      </p>
    </div>
  );
}
