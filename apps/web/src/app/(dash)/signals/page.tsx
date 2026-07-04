/**
 * /signals — THE VERDICT EXPLORER (the product flagship). The definitive, browsable record of every signal
 * this system ever tested against the daily-Tmax weather markets, and the wall each one died on. One
 * question drove the whole R&D program — is there a tradable edge here? — and this page is the exhaustive,
 * falsified answer: the market measured efficient TWELVE ways.
 *
 * Renders the committed static asset core/sim/signals-findings.ts (a faithful, golden-value-tested mirror of
 * FINDINGS.md — copied, never recomputed) as structured rows: the lever, its verdict, the ONE load-bearing
 * number with its CI, the mechanism class it died on, and the doc that proves it. The ONE dynamic row is the
 * live 12th signal (opening convergence / maker-exit) — its §9R-E gate LABEL is read at request time from
 * dash_maker_exit (the /maker-exit loader pattern). Everything else is a settled fact.
 *
 * Read-only analytics; the trading rail is DORMANT by design. Glass idiom per /efficiency + /maker-exit.
 */
import type { ReactElement } from 'react';
import {
  BADATMATH_REPLICA,
  HARDENING_SWEEP,
  MECHANISM_CLASS_META,
  type MechanismClass,
  OPENING_CONVERGENCE_SIGNAL,
  SIGNAL_ARCS,
  SIGNAL_BACKLOG_KILLS,
  SIGNAL_HERO,
  type SignalRow,
  type SignalVerdict,
  TWELVE_WAYS,
} from '@weather-edge/core';
import type { MakerExitView } from '@weather-edge/core';
import { getMakerExit } from '../../../lib/loaders.ts';
import { fmtAgo, fmtDateTime } from '../../../lib/format.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';
const SKY = 'var(--ams-secondary)';

const TONE_COLOR: Record<'red' | 'amber' | 'sky', string> = { red: RED, amber: AMBER, sky: SKY };

/** USD short form: $25.4k, $1.2M. */
function usdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

/** Verdict → chip colour. Settled kills are red; the softer/live states are amber/sky. */
function verdictColor(v: SignalVerdict): string {
  if (v === 'KILL' || v === 'FAIL') return RED;
  if (v === 'UNDER_TEST') return SKY;
  return AMBER; // AMBIGUOUS · NO-GO · INSUFFICIENT_DATA
}

function VerdictChip({ v }: { v: SignalVerdict }): ReactElement {
  const color = verdictColor(v);
  return (
    <span className="chip" style={{ color, borderColor: color, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {v.replace(/_/g, ' ')}
    </span>
  );
}

function MechChip({ c }: { c: MechanismClass }): ReactElement {
  const meta = MECHANISM_CLASS_META[c];
  const color = TONE_COLOR[meta.tone];
  return (
    <span className="chip" style={{ color, borderColor: color, whiteSpace: 'nowrap' }}>
      {meta.label}
    </span>
  );
}

/** One row of a proof table. `liveLabel` (when set) overlays the live gate state onto the 12th-signal row. */
function SignalTr({ row, liveLabel }: { row: SignalRow; liveLabel?: ReactElement | null }): ReactElement {
  return (
    <tr className={row.live ? 'rec-row' : undefined}>
      <td>
        <strong>{row.lever}</strong>
        {row.signalLabel ? <span className="chip soft" style={{ marginLeft: 6 }}>{row.signalLabel}</span> : null}
        <div className="muted small" style={{ marginTop: 2 }}>{row.question}</div>
        {liveLabel ? <div style={{ marginTop: 4 }}>{liveLabel}</div> : null}
      </td>
      <td><VerdictChip v={row.verdict} /></td>
      <td className="small">{row.keyNumber}</td>
      <td><MechChip c={row.mechClass} /></td>
      <td className="mono small muted">{row.doc}</td>
    </tr>
  );
}

/** The live §9R-E gate label for the 12th-signal row, read from dash_maker_exit. */
function LiveGateLabel({ view, generatedAt }: { view: MakerExitView | null; generatedAt: string | null }): ReactElement {
  if (!view) {
    return (
      <span className="chip soft" style={{ color: SKY }}>
        ⏳ live gate — dash_maker_exit deploying / first tick pending
      </span>
    );
  }
  const g = view.gate;
  const color = g.label === 'PASS' ? GREEN : g.label === 'KILL' ? RED : AMBER;
  return (
    <span className="small">
      <span className="chip" style={{ color, borderColor: color, fontWeight: 700 }}>
        live §9R-E gate: {g.label}
      </span>{' '}
      <span className="muted">
        {g.nMarkets}/{g.minMarkets} markets · {g.nCities}/{g.minCities} cities · {g.nDistinctDays}/{g.minDistinctDays} days
        {generatedAt ? ` · ${fmtAgo(generatedAt)}` : ''}
      </span>
    </span>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function SignalsPage(): Promise<ReactElement> {
  const db = await serverDb();
  const feed = await getMakerExit(db);
  const liveView = feed?.view ?? null;
  const h = SIGNAL_HERO;

  return (
    <div className="ams-dash">
      <h1>
        The market measured efficient — twelve ways{' '}
        <span className="chip soft">R&amp;D CLOSED · analytics retained</span>{' '}
        <span className="chip blue">{h.measuredWays} ways</span>
      </h1>
      <p className="muted small">
        We built a calibrated multi-model NWP ensemble for ~46 global airport stations and used it to ask one
        question: <strong>is there a tradable edge in these daily-max temperature markets?</strong> Every signal the
        system can see is below — the twelve numbered signals and the major prior angles — each with its verdict, the
        ONE load-bearing number, the mechanism class it died on, and the doc that proves it. The answer is{' '}
        <strong>no</strong>, and this is the browsable proof. Source: <span className="mono">FINDINGS.md</span> (figures
        copied verbatim, never recomputed). The trading rail is <strong>DORMANT</strong> by design.
      </p>

      {/* ── bottom line up front ── */}
      <div className="info-banner">
        <strong>Bottom line:</strong> on every distinct lever, the measured edge was zero-or-negative with the
        confidence interval excluding a tradable margin. The one edge that demonstrably exists in this universe — an
        external sharp at {usdShort(h.sharpRealizedUsd)} realized — is <strong>pure microstructure</strong> (resting
        cheap maker bids, collecting the rebate, across enormous breadth) and is{' '}
        <strong>non-followable and non-replicable</strong> from where we sit. One signal (the 12th) is still under a live
        forward paper test; the other eleven are settled.
      </div>

      {/* ── headline tiles ── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Measured efficient</span>
            <span className="chip soft">verdicts</span>
          </div>
          <div className="big sky">{h.measuredWays} ways</div>
          <div className="sub">{h.signalsFalsified} orthogonal signals + the hardening sweep + the flat-open NO-GO</div>
        </div>
        <div className="tile">
          <div className="cap">Signal rows on file</div>
          <div className="big">{h.totalRows}</div>
          <div className="sub">across 3 arcs · + {SIGNAL_BACKLOG_KILLS.length} pre-registered backlog kills</div>
        </div>
        <div className="tile">
          <div className="cap">Forecast skill</div>
          <div className="big">{h.forecastRmseLead1C.toFixed(2)}°C</div>
          <div className="sub">lead-1 RMSE — beats every single model ({h.bestSingleModel})</div>
        </div>
        <div className="tile">
          <div className="cap">The one real edge</div>
          <div className="big" style={{ color: AMBER }}>{usdShort(h.sharpRealizedUsd)}</div>
          <div className="sub">a sharp’s microstructure — non-replicable</div>
        </div>
        <div className="tile rec">
          <div className="tile-head">
            <span className="cap">The live signal (12th)</span>
            <span className="chip soft">/maker-exit</span>
          </div>
          <div className="big" style={{ fontSize: '1.15rem', color: liveView ? undefined : SKY }}>
            {liveView ? `§9R-E ${liveView.gate.label}` : 'pending'}
          </div>
          <div className="sub">
            {liveView
              ? `${liveView.gate.nMarkets}/${liveView.gate.minMarkets} markets · forward paper`
              : 'dash_maker_exit — first tick pending'}
          </div>
        </div>
      </div>

      {/* ── the twelve ways ── */}
      <h2>The twelve ways, at a glance</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        The canonical tally: the {h.signalsFalsified} orthogonal signals, the executable-depth hardening sweep (the
        11th way), and the opening-convergence flat-open premise the Phase-0.5 spike gate falsified (the 12th).
      </p>
      <div className="panel">
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr><th className="num">#</th><th>Way the market proved efficient</th><th>Verdict</th><th className="mono">Where</th></tr>
            </thead>
            <tbody>
              {TWELVE_WAYS.map((w) => (
                <tr key={w.n}>
                  <td className="num mono">{w.n}</td>
                  <td className="small">{w.way}</td>
                  <td><VerdictChip v={w.verdict} /></td>
                  <td className="mono small muted">{w.ref}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── the proof: every signal, per arc ── */}
      <h2>The proof — every signal, falsified</h2>
      <p className="muted small">
        The whole R&amp;D program is the systematic falsification of “we have an edge,” in three arcs — forecasting,
        the sharp wallet, then the forecast-free / structural front. Each row is a distinct lever: its verdict, the
        load-bearing number (with CI), and the wall it died on.
      </p>
      {SIGNAL_ARCS.map((arc) => (
        <div key={arc.key} style={{ marginTop: '1.1rem' }}>
          <h3 style={{ color: 'var(--ams-text)' }}>{arc.title}</h3>
          <p className="muted small" style={{ margin: '0.1rem 0 0.4rem' }}>{arc.blurb}</p>
          <div className="panel">
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr><th>Lever / question</th><th>Verdict</th><th>The one number</th><th>Mechanism</th><th>Proof</th></tr>
                </thead>
                <tbody>
                  {arc.rows.map((r) => <SignalTr key={r.id} row={r} />)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}

      {/* ── the one live signal (12th) ── */}
      <h2>The one live signal — the 12th, under forward test</h2>
      <p className="muted small">
        Every signal that died at its gate is dead. The 12th — opening convergence — is the one lever that survived its
        cheap gate: the edge would live in the flat-open window this system never measured. Its flat-open premise was
        then falsified (Phase-0.5 spike NO-GO), and the surviving <strong>maker-exit</strong> variant PASSes the
        backtest gate only marginally — so it is measured forward on the real book. The gate LABEL below is{' '}
        <strong>live</strong> from <span className="mono">dash_maker_exit</span>; everything else on this page is a
        settled fact. <strong>No capital before a frozen forward paper PASS</strong> — rail paper/DORMANT.
      </p>
      <div className="panel">
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr><th>Lever / question</th><th>Verdict</th><th>The one number</th><th>Mechanism</th><th>Proof</th></tr>
            </thead>
            <tbody>
              <SignalTr
                row={OPENING_CONVERGENCE_SIGNAL}
                liveLabel={<LiveGateLabel view={liveView} generatedAt={feed?.generatedAt ?? null} />}
              />
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          The forward measurement lives on <a href="/maker-exit">the maker-exit paper loop →</a> ·{' '}
          <a href="/convergence">the convergence overview →</a>
          {feed?.generatedAt ? (
            <> · snapshot <span className="mono">{fmtDateTime(feed.generatedAt)}</span></>
          ) : null}
        </p>
      </div>

      {/* ── the concrete confirmation — the badatmath replica ── */}
      <h2>The concrete confirmation — the sharp’s edge, made tangible</h2>
      <p className="muted small">
        To make “non-replicable” concrete, the sharp’s buying model was recreated as a fictional, no-money paper-trial
        and tracked three ways ({BADATMATH_REPLICA.nSeed}-position seed). At this n all three CIs straddle 0 — the
        durable finding is the <strong>structure</strong>: the adverse-selection tax dwarfs the spread tax.{' '}
        <span className="mono">{BADATMATH_REPLICA.doc}</span>.
      </p>
      <div className="strip">
        {BADATMATH_REPLICA.curves.map((c) => (
          <div className="tile" key={c.key}>
            <div className="cap">{c.label}</div>
            <div className="big" style={{ color: c.roiPct >= 0 ? GREEN : RED }}>
              {c.roiPct >= 0 ? '+' : '−'}{Math.abs(c.roiPct).toFixed(1)}%
            </div>
            <div className="sub">win {c.winPct.toFixed(1)}% · CI [{c.ci[0]}%, {c.ci[1]}%]</div>
          </div>
        ))}
        <div className="tile">
          <div className="cap">Spread tax (ideal → taker)</div>
          <div className="big neg">{BADATMATH_REPLICA.spreadTaxPp}pp</div>
          <div className="sub">what crossing to the ask costs</div>
        </div>
        <div className="tile rec">
          <div className="cap">Adverse-selection tax (ideal → realistic)</div>
          <div className="big neg">{BADATMATH_REPLICA.adverseSelTaxPp}pp</div>
          <div className="sub">the book only touches your rest when you’re wrong — it dwarfs the spread tax</div>
        </div>
      </div>

      {/* ── the eleventh way — hardening sweep ── */}
      <h2>The eleventh way — hardened at executable depth ({HARDENING_SWEEP.date})</h2>
      <p className="muted small">{HARDENING_SWEEP.blurb}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
        {HARDENING_SWEEP.lanes.map((ln) => (
          <div className="panel" key={ln.lane} style={{ margin: 0 }}>
            <div className="tile-head">
              <span className="cap">Lane {ln.lane} — {ln.title}</span>
              <VerdictChip v="KILL" />
            </div>
            <p className="small" style={{ margin: '0.4rem 0 0' }}>{ln.result}</p>
          </div>
        ))}
      </div>

      {/* ── the 2026-07-03 backlog sweep ── */}
      <h2>The pre-registered backlog — every remaining stone, turned</h2>
      <p className="muted small">
        The priority-ordered signal backlog, each item pre-registered with a kill-gate before measuring, all
        adjudicated 2026-07-03. Two produced analytics candidates (no capital); the rest are settled nulls or kills.
      </p>
      <div className="panel">
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr><th className="num">item</th><th>Lever</th><th>Verdict</th><th>What settles it</th><th className="mono">Proof</th></tr>
            </thead>
            <tbody>
              {SIGNAL_BACKLOG_KILLS.map((b) => (
                <tr key={b.item}>
                  <td className="num mono">{b.item}</td>
                  <td className="small"><strong>{b.lever}</strong></td>
                  <td><VerdictChip v={b.verdict} /></td>
                  <td className="small">{b.keyNumber}</td>
                  <td className="mono small muted">{b.doc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted small" style={{ marginTop: '1.25rem' }}>
        Read-only analytics — <strong>{h.investigationStatus}</strong>. This is a measurement instrument and a
        defensible, reproducible proof of market efficiency, not trading advice. Full record:{' '}
        <span className="mono">FINDINGS.md</span> and its deep docs. Related:{' '}
        <a href="/efficiency">the efficiency verdict →</a> · <a href="/maker-exit">the live maker-exit loop →</a> ·{' '}
        <a href="/paper-trade">the 45-city scan →</a>
      </p>
    </div>
  );
}
