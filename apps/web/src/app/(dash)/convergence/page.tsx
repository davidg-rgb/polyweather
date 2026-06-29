/**
 * /convergence — the opening-convergence forward-paper overview (the 12th signal, under test).
 *
 * Surfaces the bracket-replay paper measurement as a live operator page: the bot's logged potential ENTRIES,
 * their EXITS, per-day CHANCES, the take-profit TUNING sweep, the §9R-E gate progress, and a FICTIVE MONEY
 * TRACKER (assumes the recommended depth-gated per-position stake per entry, tracks running paper P&L).
 *
 * Read-only analytics over the convergence-panel snapshot (Edge tick, every 15 min, migration 0069). NOT a
 * trade and NOT capital — the bot rail is paper/DORMANT; no GO until the frozen §9R-E gate PASSes (FINDINGS.md).
 */
import type { ReactElement } from 'react';
import type {
  ConvergenceEntry,
  ConvergencePerDay,
  ConvergenceTuningRow,
  ConvergenceView,
} from '@weather-edge/core';
import { EquityChart } from '../../../components/EquityChart.tsx';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct, fmtProb, fmtUsd, num } from '../../../lib/format.ts';
import { getConvergence } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';
const SKY = 'var(--ams-secondary)';

const pnlColor = (v: number): string => (v >= 0 ? GREEN : RED);
const signedUsd = (v: number, dp = 2): string => `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v), dp)}`;
const signedPct = (v: number, dp = 1): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${fmtPct(Math.abs(v), dp)}` : '—');

const EXIT_META: Record<string, { label: string; color: string }> = {
  take_profit: { label: 'take-profit', color: GREEN },
  stop_loss: { label: 'stop-loss', color: RED },
  time_stop: { label: 'noon stop', color: AMBER },
  resolution_win: { label: 'resolved · won', color: GREEN },
  resolution_lose: { label: 'resolved · lost', color: RED },
  open_marked: { label: 'open · marked', color: SKY },
};

// ─── sub-components ──────────────────────────────────────────────────────────

/** §9R-E gate progress: the three sufficiency bars toward a verdict. */
function GateBanner({ view }: { view: ConvergenceView }): ReactElement {
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
  const cityErrors = view.cityErrors ?? 0;
  return (
    <div className="info-banner">
      <strong style={{ color: labelColor }}>§9R-E GATE (indicative) — {g.label}.</strong>{' '}
      Frozen net-profit bar: ≥{g.minMarkets} paper markets · ≥{g.minCities} cities · ≥{g.minDistinctDays} distinct
      days, city-clustered CI &gt; 0, zero-skill MC &lt; 5%. No capital until it PASSes (bot rail paper/DORMANT). {g.reason}
      <div className="sub" style={{ marginTop: '0.4rem' }}>
        <strong>Indicative</strong> — computed on the ~6-min downsampled snapshot; the <em>binding</em> §9R-E verdict
        is the full-fidelity <span className="mono">opening-bracket-score</span> scorer. Treat a PASS here as a hint,
        not the GO.
        {cityErrors > 0 ? (
          <>
            {' '}
            <span className="chip" style={{ color: AMBER }}>⚠ {cityErrors} city fetch error(s) this tick — counts may undercount</span>
          </>
        ) : null}
      </div>
      <div className="strip" style={{ marginTop: '0.6rem' }}>
        {bar(g.nMarkets, g.minMarkets, 'markets')}
        {bar(g.nCities, g.minCities, 'cities')}
        {bar(g.nDistinctDays, g.minDistinctDays, 'distinct days')}
      </div>
    </div>
  );
}

/** The fictive money tracker tiles. */
function MoneyTiles({ view }: { view: ConvergenceView }): ReactElement {
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
function PerDayTable({ rows }: { rows: ConvergencePerDay[] }): ReactElement {
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

/** Take-profit tuning sweep (the headline TP starred; the rest exploratory). */
function TuningTable({ rows, headlineTp, recommended }: {
  rows: ConvergenceTuningRow[];
  headlineTp: number;
  recommended: { tpDeltaPp: number; ruleCaptureRoi: number } | null;
}): ReactElement {
  if (rows.length === 0) return <p className="muted">No tuning sweep yet.</p>;
  return (
    <>
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>
              <th>take-profit</th>
              <th className="num">markets</th>
              <th className="num">exec %</th>
              <th className="num">win frac</th>
              <th className="num">rule ROI (net)</th>
              <th className="num">ceiling (gross pp)</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isRec = recommended !== null && r.tpDeltaPp === recommended.tpDeltaPp;
              return (
                <tr key={r.tpDeltaPp} style={r.isHeadline ? { background: 'rgba(120,170,255,0.06)' } : undefined}>
                  <td className="mono small">
                    +{fmtPct(r.tpDeltaPp, 0)} {r.isHeadline ? <span className="chip soft">headline</span> : null}
                    {isRec && !r.isHeadline ? <span className="chip soft" style={{ color: AMBER }}>best</span> : null}
                  </td>
                  <td className="num">{r.nMarkets}</td>
                  <td className="num">{fmtPct(r.executedFrac, 0)}</td>
                  <td className="num">{Number.isFinite(r.winFrac) ? fmtPct(r.winFrac, 0) : '—'}</td>
                  <td className="num" style={{ color: Number.isFinite(r.ruleCaptureRoi) ? pnlColor(r.ruleCaptureRoi) : undefined }}>
                    {signedPct(r.ruleCaptureRoi)}
                  </td>
                  <td className="num">{signedPct(r.ceiling)}</td>
                  <td className="small">{r.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: '0.5rem' }}>
        <strong>rule ROI</strong> = mean realized net the FIXED bracket rule caught; <strong>ceiling</strong> = the
        look-ahead best sell-back a perfect exit could have caught (NOT a strategy — the gap is unharvested
        re-rating). The headline TP (+{fmtPct(headlineTp, 0)}) is the pre-registered gate; the sweep is{' '}
        <strong>EXPLORATORY</strong> — picking the best-in-sample TP is the winner&apos;s curse, never a GO.
      </p>
    </>
  );
}

/** Logged potential entries + their exits, newest target-day first. */
function EntriesTable({ rows }: { rows: ConvergenceEntry[] }): ReactElement {
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
            <th>fill</th>
            <th>exit</th>
            <th className="num">exit px</th>
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
                <td className="num">{fmtProb(e.entryPrice)}</td>
                <td className="small">{e.isMaker ? 'maker' : 'taker'}</td>
                <td className="small" style={{ color: meta.color }}>{meta.label}</td>
                <td className="num">{fmtProb(e.exitPrice)}</td>
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

export default async function ConvergencePage(): Promise<ReactElement> {
  const db = await serverDb();
  const feed = await getConvergence(db);
  const view = feed?.view ?? null;

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>
          Opening convergence <span className="chip soft">paper · rail DORMANT</span>
        </h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_convergence</span> RPC is deploying, or
          the <span className="mono">convergence-panel</span> Edge tick — every 15 min — hasn&apos;t computed its
          first snapshot). Refresh shortly.
        </p>
      </div>
    );
  }

  const m = view.money;
  const equityDates = m.equity.map((e) => e.date);
  const equitySeries = [
    { label: 'paper P&L', color: pnlColor(m.netPnlUsd), values: m.equity.map((e) => e.cumUsd) },
  ];

  return (
    <div className="ams-dash">
      <h1>
        Opening convergence <span className="chip soft">paper · rail DORMANT</span>
      </h1>
      <p className="muted small">
        The 12th signal under forward test: buy the forecast-center bucket cheap on a freshly-listed daily-Tmax
        market, sell into the convergence on a bracket (take-profit / stop-loss / station-local-noon time-stop).
        This is the <strong>bracket-replay paper measurement</strong> made legible — logged potential entries, their
        exits, per-day chances, the TP tuning sweep, and a <strong>fictive</strong> money tracker (assumes the
        recommended {fmtUsd(m.perEntryStakeUsd, 0)} depth-gated stake per entry). <strong>Not a trade, not capital</strong>{' '}
        — the bot rail is paper/DORMANT; the §9R-E gate governs any GO.
        {feed?.generatedAt ? (
          <>
            {' '}Snapshot <span className="mono">{fmtAgo(feed.generatedAt)}</span> (
            <span className="mono">{fmtDateTime(feed.generatedAt)}</span>) · window {view.days}d ·{' '}
            {view.gate.nCities}/{view.cities.length} cities (with data / allowlist).
          </>
        ) : null}
      </p>

      <GateBanner view={view} />

      <h2>Fictive money tracker</h2>
      <MoneyTiles view={view} />

      <div className="panel" style={{ marginTop: '1rem' }}>
        <div className="cap" style={{ marginBottom: '0.25rem' }}>Cumulative paper P&amp;L by target day (realized + marked-open)</div>
        <EquityChart dates={equityDates} series={equitySeries} width={760} height={240} />
      </div>

      <h2>Per-day chances</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          How many fresh-allowlist markets we considered vs entered each station-local target day, and that
          day&apos;s paper P&amp;L. Fire rate = entered / considered.
        </p>
        <PerDayTable rows={view.perDay} />
      </div>

      <h2>Tuning recommendations — the take-profit sweep</h2>
      <div className="panel">
        <TuningTable rows={view.tuning} headlineTp={view.headlineTpDeltaPp} recommended={view.recommendedTp} />
      </div>

      <h2>Logged potential entries &amp; exits</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          {view.entries.length} entries the bracket rule fired in the window (headline TP +{fmtPct(view.headlineTpDeltaPp, 0)}).
          Each shows the <strong>predicted</strong> bucket (the forecast-center temperature the bet opened on), the
          maker/taker fill, the entry age since listing, the realized (or marked-open) exit, and the net paper P&amp;L
          at the {fmtUsd(m.perEntryStakeUsd, 0)} stake.
        </p>
        <EntriesTable rows={view.entries} />
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the <span className="mono">convergence_panel</span> snapshot (convergence-panel Edge
        tick, every 15 min). Engine: <span className="mono">core/sim/opening-convergence-view</span> — the same
        bracket-replay <em>engine</em> the <span className="mono">opening-bracket-score</span> scorer uses, but run on
        a ~6-min downsampled snapshot, so the gate above is <strong>indicative</strong>; the binding §9R-E verdict is
        the scorer on the full per-tick series. Bot rail paper/DORMANT; no capital until the §9R-E gate PASSes.
        Source: <span className="mono">FINDINGS.md</span> (the 12th signal) ·{' '}
        <span className="mono">OPENING-CONVERGENCE-HANDOFF.md</span>.
      </p>
    </div>
  );
}
