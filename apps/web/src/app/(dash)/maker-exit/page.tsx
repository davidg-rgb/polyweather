/**
 * /maker-exit — the forward MAKER-EXIT paper loop (the first +EV config across twelve signals, under test).
 *
 * MAKER-EXIT-SIM.md found the maker exit FLIPS the convergence edge positive (−3.0% taker → +1.8%/+5.1% maker),
 * but the §9R-E gate KILLs on a 17-day clustered CI whose lower bound sits just below 0 — and the result rests on
 * THREE assumptions a backtest cannot resolve. This page is the forward measurement of those three made legible:
 * the realized MAKER-FILL RATE (#1, the §12 adverse-selection read), the realized REBATE (#2), and the DAYS /
 * cities / markets accrued (#3) — plus the logged entries/exits, a fictive money tracker, and the §9R-E gate.
 *
 * Read-only analytics over the maker_exit_panel snapshot (maker-exit-panel Edge tick, every 15 min, migration
 * 0073). NOT a trade and NOT capital — the bot rail is paper/DORMANT; no GO until the frozen §9R-E gate PASSes
 * (MAKER-EXIT-PAPER-LOOP-HANDOFF.md / FINDINGS.md).
 */
import type { ReactElement } from 'react';
import type { MakerExitEntry, MakerExitPerDay, MakerExitView } from '@weather-edge/core';
import { EquityChart } from '../../../components/EquityChart.tsx';
import { getMakerExit } from '../../../lib/loaders.ts';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct, fmtProb, fmtStockholm, fmtUsd, num } from '../../../lib/format.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';
const SKY = 'var(--ams-secondary)';

const pnlColor = (v: number): string => (v >= 0 ? GREEN : RED);
const signedUsd = (v: number, dp = 2): string => `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v), dp)}`;
const signedPct = (v: number, dp = 1): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${fmtPct(Math.abs(v), dp)}` : '—');
const pp = (v: number, dp = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(dp)}pp` : '—');

const EXIT_META: Record<string, { label: string; color: string }> = {
  maker_take_profit: { label: 'maker take-profit', color: GREEN },
  taker_stop_loss: { label: 'taker stop-loss', color: RED },
  taker_time_stop: { label: 'taker time-stop', color: AMBER },
  resolution_win: { label: 'resolved · won', color: GREEN },
  resolution_lose: { label: 'resolved · lost', color: RED },
  open_marked: { label: 'open · marked', color: SKY },
};

// ─── sub-components ──────────────────────────────────────────────────────────

/** §9R-E gate progress: the three sufficiency bars + the clustered CI (the KILL driver was ciLow ≤ 0). */
function GateBanner({ view }: { view: MakerExitView }): ReactElement {
  const g = view.gate;
  const bar = (n: number, min: number, label: string): ReactElement => {
    const ok = n >= min;
    return (
      <div className="tile" style={{ minWidth: 0 }}>
        <div className="cap">{label}</div>
        <div className="big" style={{ color: ok ? GREEN : undefined }}>
          {n}
          <span className="muted" style={{ fontSize: '0.9rem' }}> / {min}</span>
        </div>
        <div className="sub">{ok ? 'met ✓' : `${min - n} to go`}</div>
      </div>
    );
  };
  const labelColor = g.label === 'PASS' ? GREEN : g.label === 'KILL' ? RED : AMBER;
  const ciClearsZero = Number.isFinite(g.ciLow) && g.ciLow > 0;
  const cityErrors = view.cityErrors ?? 0;
  return (
    <div className="info-banner">
      <strong style={{ color: labelColor }}>§9R-E GATE (indicative) — {g.label}.</strong>{' '}
      Frozen net-profit bar: ≥{g.minMarkets} paper markets · ≥{g.minCities} cities · ≥{g.minDistinctDays} distinct
      days, city-clustered CI &gt; 0, zero-skill MC &lt; 5%. The backtest&apos;s lone miss was <strong>ciLow ≤ 0</strong> —
      the forward run&apos;s job is to show it crosses 0 as days accrue. No capital until it PASSes (rail paper/DORMANT). {g.reason}
      <div className="strip" style={{ marginTop: '0.6rem' }}>
        {bar(g.nMarkets, g.minMarkets, 'markets')}
        {bar(g.nCities, g.minCities, 'cities')}
        {bar(g.nDistinctDays, g.minDistinctDays, 'distinct days')}
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">city-clustered 95% CI</div>
          <div className="big" style={{ color: ciClearsZero ? GREEN : RED, fontSize: '1.1rem' }}>
            [{signedPct(g.ciLow)}, {signedPct(g.ciHigh)}]
          </div>
          <div className="sub">mean {signedPct(g.meanNetReturn)} · {ciClearsZero ? 'clears 0 ✓' : 'ciLow ≤ 0'}</div>
        </div>
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">zero-skill MC</div>
          <div className="big" style={{ fontSize: '1.1rem', color: Number.isFinite(g.zeroSkillPassRate) && g.zeroSkillPassRate < 0.05 ? GREEN : RED }}>
            {Number.isFinite(g.zeroSkillPassRate) ? fmtPct(g.zeroSkillPassRate, 1) : '—'}
          </div>
          <div className="sub">&lt; 5% required</div>
        </div>
      </div>
      <div className="sub" style={{ marginTop: '0.4rem' }}>
        <strong>Indicative</strong> — computed on the ~6-min downsampled snapshot; the binding §9R-E verdict is the
        full-fidelity scorer. Treat a PASS here as a hint, not the GO.
        {cityErrors > 0 ? (
          <>
            {' '}
            <span className="chip" style={{ color: AMBER }}>⚠ {cityErrors} city fetch error(s) this tick — counts may undercount</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The headline: the THREE measured assumptions the 708-event backtest could not resolve (handoff §1). */
function AssumptionTiles({ view }: { view: MakerExitView }): ReactElement {
  const a = view.assumptions;
  return (
    <div className="strip">
      <div className="tile rec">
        <div className="tile-head">
          <span className="cap">#1 · Maker-fill rate</span>
          <span className="chip soft">§12 adverse selection</span>
        </div>
        <div className="big" style={{ color: SKY }}>{Number.isFinite(a.makerFillRate) ? fmtPct(a.makerFillRate, 0) : '—'}</div>
        <div className="sub">
          of realized exits filled as a maker TP
          {Number.isFinite(a.meanMakerFillLatencyTicks) ? ` · ${a.meanMakerFillLatencyTicks.toFixed(1)} ticks to fill` : ''}
        </div>
      </div>
      <div className="tile">
        <div className="cap">#2 · Realized rebate</div>
        <div className="big" style={{ color: a.realizedRebateUsd > 0 ? GREEN : undefined }}>{fmtUsd(a.realizedRebateUsd)}</div>
        <div className="sub">at rate {fmtPct(a.rebateRateUsed, 0)} · {a.rebateRateUsed === 0 ? 'fee-saving floor' : 'configured tier'}</div>
      </div>
      <div className="tile">
        <div className="cap">#3 · Days accrued</div>
        <div className="big">{a.nDistinctDays}<span className="muted" style={{ fontSize: '0.9rem' }}> / {view.gate.minDistinctDays}</span></div>
        <div className="sub">{a.nMarkets} markets · {a.nCities} cities (the CI narrows as these grow)</div>
      </div>
      <div className="tile rec">
        <div className="tile-head">
          <span className="cap">#4 · Reward-qualifying ticks</span>
          <span className="chip soft">pool SHARE unmeasured</span>
        </div>
        <div className="big" style={{ color: SKY }}>{Number.isFinite(a.qualifyingTickFrac) ? fmtPct(a.qualifyingTickFrac, 0) : '—'}</div>
        <div className="sub">
          of {a.nRestingTicks} resting ticks in Polymarket&apos;s reward band ({a.nQualifyingRestingTicks} qualifying)
          — the pool $ / competition share stays an explicit unknown, never assumed here
        </div>
      </div>
      <div className="tile">
        <div className="cap">Observed spread</div>
        <div className="big" style={{ fontSize: '1.2rem' }}>{pp(a.meanObservedEntrySpread)} / {pp(a.meanObservedExitSpread)}</div>
        <div className="sub">entry / exit top-of-book — the round-trip cost the maker exit recovers</div>
      </div>
    </div>
  );
}

/** The fictive money tracker tiles. */
function MoneyTiles({ view }: { view: MakerExitView }): ReactElement {
  const m = view.money;
  return (
    <div className="strip">
      <div className="tile rec">
        <div className="tile-head">
          <span className="cap">Net paper P&amp;L</span>
          <span className="chip soft">fictive</span>
        </div>
        <div className="big" style={{ color: pnlColor(m.netPnlUsd) }}>{signedUsd(m.netPnlUsd)}</div>
        <div className="sub">on {fmtUsd(m.deployedUsd, 0)} deployed · ROI {signedPct(m.roi)}</div>
      </div>
      <div className="tile">
        <div className="cap">Realized</div>
        <div className="big" style={{ color: pnlColor(m.realizedPnlUsd) }}>{signedUsd(m.realizedPnlUsd)}</div>
        <div className="sub">{m.nRealized} closed · {m.nWins}W / {m.nLosses}L</div>
      </div>
      <div className="tile">
        <div className="cap">Open (marked)</div>
        <div className="big" style={{ color: pnlColor(m.openMarkedPnlUsd) }}>{signedUsd(m.openMarkedPnlUsd)}</div>
        <div className="sub">{m.nOpen} positions held to mark</div>
      </div>
      <div className="tile">
        <div className="cap">Win rate</div>
        <div className="big">{m.nRealized > 0 ? fmtPct(m.winRate, 0) : '—'}</div>
        <div className="sub">of {m.nRealized} resolved/closed</div>
      </div>
      <div className="tile">
        <div className="cap">Stake / entry</div>
        <div className="big">{fmtUsd(m.perEntryStakeUsd, 0)}</div>
        <div className="sub">recommended · depth-gated</div>
      </div>
      <div className="tile">
        <div className="cap">Entries logged</div>
        <div className="big sky">{m.nEntries}</div>
        <div className="sub">of {view.nFreshEvents} fresh markets</div>
      </div>
    </div>
  );
}

/** Per-day chances table: markets considered vs entered + the day's paper P&L. */
function PerDayTable({ rows }: { rows: MakerExitPerDay[] }): ReactElement {
  if (rows.length === 0) return <p className="muted">No per-day data yet.</p>;
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>target day</th>
            <th className="num">considered</th>
            <th className="num">entered</th>
            <th className="num">fire rate</th>
            <th className="num">staked</th>
            <th className="num">net P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((d) => (
            <tr key={d.date}>
              <td className="mono small">{fmtDate(d.date)}</td>
              <td className="num">{d.considered}</td>
              <td className="num">{d.entered}</td>
              <td className="num">{fmtPct(d.firePct, 0)}</td>
              <td className="num">{fmtUsd(d.stakeUsd, 0)}</td>
              <td className="num" style={{ color: pnlColor(d.netPnlUsd) }}>{signedUsd(d.netPnlUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Logged potential entries + their maker/taker exits, with the measurement diagnostics, newest target-day first. */
function EntriesTable({ rows }: { rows: MakerExitEntry[] }): ReactElement {
  if (rows.length === 0) return <p className="muted">No entries logged in the window yet.</p>;
  const ordered = [...rows].sort((a, b) => (a.targetDate < b.targetDate ? 1 : a.targetDate > b.targetDate ? -1 : a.city.localeCompare(b.city)));
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>city</th>
            <th>target day</th>
            <th>predicted</th>
            <th className="num">entry age</th>
            <th className="num">entry</th>
            <th>exit</th>
            <th className="num">exit px</th>
            <th className="num">fill lag</th>
            <th className="num">spread in/out</th>
            <th className="num">rebate</th>
            <th className="num">net P&amp;L</th>
            <th className="num">return</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((e) => {
            const meta = EXIT_META[e.exitKind] ?? { label: e.exitKind, color: undefined as unknown as string };
            const age = num(e.entryAgeH);
            return (
              <tr key={`${e.eventId}-${e.city}`}>
                <td className="small">{e.city}</td>
                <td className="mono small">{fmtDate(e.targetDate)}</td>
                <td className="mono small">{e.entryLabel || '—'}</td>
                <td className="num">{age !== null ? `${age.toFixed(1)}h` : '—'}</td>
                <td className="num">{fmtProb(e.entryPrice)} <span className="muted small">{e.isMakerEntry ? 'M' : 'T'}</span></td>
                <td className="small" style={{ color: meta.color }}>{meta.label}</td>
                <td className="num">{fmtProb(e.exitPrice)} <span className="muted small">{e.isMakerExit ? 'M' : 'T'}</span></td>
                <td className="num">{e.makerFillLatencyTicks != null ? `${e.makerFillLatencyTicks}t` : '—'}</td>
                <td className="num small">{pp(e.observedEntrySpread)} / {pp(e.observedExitSpread)}</td>
                <td className="num" style={{ color: e.rebateUsd > 0 ? GREEN : undefined }}>{e.rebateUsd > 0 ? fmtUsd(e.rebateUsd) : '—'}</td>
                <td className="num" style={{ color: pnlColor(e.netPnlUsd) }}>{signedUsd(e.netPnlUsd)}</td>
                <td className="num" style={{ color: pnlColor(e.netReturn) }}>{signedPct(e.netReturn)}</td>
                <td className="small">
                  <span className="chip small" style={{ color: e.status === 'open' ? SKY : undefined }}>{e.status}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function MakerExitPage(): Promise<ReactElement> {
  const db = await serverDb();
  const feed = await getMakerExit(db);
  const view = feed?.view ?? null;

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>
          Maker-exit convergence <span className="chip soft">paper · rail DORMANT</span>
        </h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_maker_exit</span> RPC is deploying, or the{' '}
          <span className="mono">maker-exit-panel</span> Edge tick — every 15 min — hasn&apos;t computed its first
          snapshot). Refresh shortly.
        </p>
      </div>
    );
  }

  const m = view.money;
  const equityDates = m.equity.map((e) => e.date);
  const equitySeries = [{ label: 'paper P&L', color: pnlColor(m.netPnlUsd), values: m.equity.map((e) => e.cumUsd) }];

  return (
    <div className="ams-dash">
      <h1>
        Maker-exit convergence <span className="chip soft">paper · rail DORMANT</span>
      </h1>
      <p className="muted small">
        The maker-exit variant of the 12th signal — the <strong>first +EV config across twelve signals</strong>: buy
        the forecast-center bucket cheap, then TAKE PROFIT AS A MAKER (rest a sell at entry +{fmtPct(view.tpDeltaPp, 0)},
        let a buyer lift it for $0 taker fee + the rebate), with a taker stop-loss and a hard time-stop{' '}
        {view.tstopHoursBeforeResolve}h before resolution. It flips the taker bracket&apos;s −3.0% positive — but the
        §9R-E gate KILLs on a 17-day CI whose lower bound sits just below 0. This loop <strong>measures the three
        assumptions a backtest can&apos;t</strong> (maker-fill rate, rebate, days) forward on the real book.{' '}
        <strong>Not a trade, not capital</strong> — rail paper/DORMANT; the §9R-E gate governs any GO.
        {feed?.generatedAt ? (
          <>
            {' '}Snapshot <span className="mono">{fmtAgo(feed.generatedAt)}</span> (
            <span className="mono">{fmtDateTime(feed.generatedAt)}</span>) · window {view.days}d ·{' '}
            {view.gate.nCities}/{view.cities.length} cities (with data / allowlist) · tuned tp {view.tpDeltaPp} / sl{' '}
            {view.slDeltaPp} / tstop {view.tstopHoursBeforeResolve}h / rebate {fmtPct(view.makerRebateRate, 0)}.
          </>
        ) : null}
      </p>

      <GateBanner view={view} />

      <h2>The three measured assumptions</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        What the 708-event backtest assumed but could not resolve — now measured forward on the real{' '}
        <span className="mono">opening_captures</span> book. If the maker-fill rate craters (#1, §12 adverse
        selection), the edge dies; if it holds and the CI clears 0 as days accrue (#3), the gate flips.
      </p>
      <AssumptionTiles view={view} />

      <h2>Fictive money tracker</h2>
      <MoneyTiles view={view} />

      <div className="panel" style={{ marginTop: '1rem' }}>
        <div className="cap" style={{ marginBottom: '0.25rem' }}>Cumulative paper P&amp;L by target day (realized + marked-open)</div>
        <EquityChart dates={equityDates} series={equitySeries} width={760} height={240} />
      </div>

      <h2>Per-day chances</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          Fresh-allowlist markets considered vs entered each station-local target day, and that day&apos;s paper P&amp;L.
          Fire rate = entered / considered.
        </p>
        <PerDayTable rows={view.perDay} />
      </div>

      <h2>Logged potential entries &amp; maker/taker exits</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          {view.entries.length} entries the rule fired in the window. Each shows the <strong>predicted</strong> bucket,
          the maker/taker entry fill, the exit kind, the <strong>fill lag</strong> (ticks the resting maker sell waited
          — the §12 read), the observed top-of-book <strong>spread</strong> in/out (the round-trip cost the maker exit
          recovers), the rebate credited, and the net paper P&amp;L at the {fmtUsd(m.perEntryStakeUsd, 0)} stake.
        </p>
        {feed?.generatedAt ? (
          <p className="muted small" style={{ marginTop: '-0.25rem' }}>
            Latest data refreshed <strong>{fmtStockholm(feed.generatedAt)}</strong> (Stockholm) · {fmtAgo(feed.generatedAt)}.
            Recomputes every 15 min on the <span className="mono">maker-exit-panel</span> Edge tick.
          </p>
        ) : null}
        <EntriesTable rows={view.entries} />
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the <span className="mono">maker_exit_panel</span> snapshot (maker-exit-panel Edge
        tick, every 15 min). Engine: <span className="mono">core/sim/opening-maker-exit-view</span> → the tested{' '}
        <span className="mono">replayMakerExitPanel</span>, run on a ~6-min downsampled snapshot, so the gate above is{' '}
        <strong>indicative</strong>. Bot rail paper/DORMANT; no capital until the §9R-E gate PASSes + an operator
        decision. Source: <span className="mono">MAKER-EXIT-SIM.md</span> ·{' '}
        <span className="mono">MAKER-EXIT-PAPER-LOOP-HANDOFF.md</span> · <span className="mono">FINDINGS.md</span> (the 12th signal).
      </p>
    </div>
  );
}
