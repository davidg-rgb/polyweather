/**
 * /efficiency — THE VERDICT. The product's definitive headline: a calibrated forecasting instrument,
 * used to ask one question — is there a tradable edge in these daily-Tmax weather markets? — and the
 * exhaustive, falsified answer. Every lever tried, every wall it died on, with the load-bearing number.
 *
 * The overview (/) carries the concise skill-vs-market summary; THIS page is the deep proof: the full
 * falsified-lever table (the settled record from FINDINGS.md), the LIVE calibration that grounds it
 * (the instrument doing the measuring is itself calibrated), the one real edge and why it doesn't
 * transfer, and the methodology that makes this a proof rather than a null result.
 *
 * Composes the existing dash_calibration + dash_amsterdam_sim RPCs + the static efficiency-findings
 * record — NO new RPC, NO migration. Read-only analytics; the trading rail is DORMANT.
 */
import type { ReactElement } from 'react';
import { ReliabilityDiagram } from '../../../components/ReliabilityDiagram.tsx';
import {
  EFFICIENCY_HEADLINE,
  FINDINGS_ARCS,
  type FalsifiedLever,
  HARDENING_SWEEP,
  METHODOLOGY,
  type Verdict,
} from '../../../lib/efficiency-findings.ts';
import { fmtPct, fmtProb, num } from '../../../lib/format.ts';
import { getAmsterdamSim, getCalibrationView } from '../../../lib/loaders.ts';
import { shapeReliability, summarizeForecastSkill } from '../../../lib/shapers.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

// ─── helpers ───────────────────────────────────────────────────────────────────

/** USD short form: $25.4k, $1.2M. */
function usdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

/** Verdict chip — KILL/FAIL are "lever is dead" (red); AMBIGUOUS is amber. */
function VerdictChip({ v }: { v: Verdict }): ReactElement {
  const color = v === 'AMBIGUOUS' ? 'var(--ams-amber)' : 'var(--ams-red)';
  return (
    <span className="chip" style={{ color, borderColor: color, fontWeight: 700 }}>
      {v}
    </span>
  );
}

/** One row of the proof table. */
function LeverRow({ lever }: { lever: FalsifiedLever }): ReactElement {
  return (
    <tr>
      <td style={{ minWidth: 200 }}>
        <strong>{lever.lever}</strong>
        <div className="muted small" style={{ marginTop: 2 }}>
          {lever.question}
        </div>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <VerdictChip v={lever.verdict} />
      </td>
      <td className="small">{lever.evidence}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <span className="chip soft">{lever.wall}</span>
      </td>
      <td className="mono small muted" style={{ whiteSpace: 'nowrap' }}>
        {lever.doc}
      </td>
    </tr>
  );
}

// ─── page ──────────────────────────────────────────────────────────────────────

export default async function EfficiencyPage(): Promise<ReactElement> {
  const db = await serverDb();
  const [cal, ams] = await Promise.all([getCalibrationView(db), getAmsterdamSim(db)]);
  const skill = summarizeForecastSkill(cal.scores, cal.champion);
  const championReliability = shapeReliability(cal.scores.filter((r) => r.source === cal.champion));

  // Live model-vs-market read (skillVsMarket ≤ 0 is the measured-efficiency finding).
  const sv = skill.skillVsMarket;
  const marketSharper = sv !== null && sv <= 0;
  const skillText = sv === null ? '—' : `${sv > 0 ? '+' : ''}${fmtPct(sv, 1)}`;

  const hitRate = ams?.overall.marketHitRate ?? null;
  const nGraded = ams?.overall.nGradedAll ?? 0;

  const h = EFFICIENCY_HEADLINE;

  return (
    <div className="ams-dash">
      <h1>
        The verdict — this market is efficient{' '}
        <span className="chip soft">R&amp;D CLOSED · analytics retained</span>{' '}
        <span className="chip blue">{h.signalsFalsified} signals falsified</span>
      </h1>
      <p className="muted small">
        We built a calibrated multi-model NWP ensemble for ~46 global airport stations and used it to ask one
        question: <strong>is there a tradable edge in these daily-max temperature markets?</strong> Across an
        exhaustive R&amp;D program we falsified every lever the system can see — <strong>measured eleven ways</strong>,
        at executable depth. This page is the proof. The trading rail is DORMANT by design; the value is the
        instrument and the measurement.
      </p>

      {/* ── bottom line up front ──────────────────────────────────────────────────────────────────── */}
      <div className="info-banner">
        <strong>Bottom line:</strong> on every distinct lever, the measured edge was zero-or-negative with the
        confidence interval excluding a tradable margin. The one edge that demonstrably exists in this universe —
        an external sharp at {usdShort(h.sharpRealizedUsd)} realized — is <strong>pure microstructure</strong>{' '}
        (resting cheap maker bids, collecting the rebate, across enormous breadth) and is{' '}
        <strong>non-followable and non-replicable</strong> from where we sit.
      </div>

      {/* ── headline tiles ────────────────────────────────────────────────────────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Signals falsified</span>
            <span className="chip soft">10 / 10</span>
          </div>
          <div className="big sky">{h.signalsFalsified}</div>
          <div className="sub">{h.leversFalsified} levers · measured {h.measuredWays} ways</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Forecast skill</span>
          </div>
          <div className="big">{h.forecastRmseLead1C.toFixed(2)}°C</div>
          <div className="sub">lead-1 RMSE — beats every single model ({h.bestSingleModel})</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Model vs market</span>
            <span className="chip soft">live</span>
          </div>
          <div className={`big ${marketSharper ? 'neg' : 'pos'}`}>{skillText}</div>
          <div className="sub">
            {sv === null ? 'no scored history yet' : marketSharper ? 'the market is the sharper forecaster' : 'we edge the market'}
            {skill.nCells > 0 ? ` · ${skill.nCells} cells` : ''}
          </div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">The one real edge</span>
          </div>
          <div className="big" style={{ color: 'var(--ams-amber)' }}>{usdShort(h.sharpRealizedUsd)}</div>
          <div className="sub">a sharp’s microstructure — non-replicable</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Live paper-trade</span>
            <span className="chip soft">/amsterdam</span>
          </div>
          <div className="big sky">{hitRate === null ? '—' : fmtPct(hitRate, 0)}</div>
          <div className="sub">exact-bucket hit rate{nGraded > 0 ? ` · n=${nGraded}` : ''}</div>
        </div>
      </div>

      {/* ── the proof: three arcs ─────────────────────────────────────────────────────────────────── */}
      <h2>The proof — every lever, falsified</h2>
      <p className="muted small">
        The whole R&amp;D program is the systematic falsification of “we have an edge.” It ran in three arcs;
        each row is a distinct lever, its verdict, the load-bearing number, and the wall it died on. Source:{' '}
        <span className="mono">FINDINGS.md</span>.
      </p>
      {FINDINGS_ARCS.map((arc) => (
        <div key={arc.key} style={{ marginTop: '1.1rem' }}>
          <h3 style={{ color: 'var(--ams-text)' }}>{arc.title}</h3>
          <p className="muted small" style={{ margin: '0.1rem 0 0.4rem' }}>
            {arc.blurb}
          </p>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Lever / question</th>
                  <th>Verdict</th>
                  <th>What settles it</th>
                  <th>Wall</th>
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {arc.levers.map((l) => (
                  <LeverRow key={l.id} lever={l} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* ── the instrument is real (live grounding) ───────────────────────────────────────────────── */}
      <h2>The instrument that did the measuring is itself calibrated</h2>
      <p className="muted small">
        This is a measurement, not sour grapes. Our forecast genuinely works — it is a calibrated multi-model
        ensemble at its point-skill ceiling. It simply isn’t sharper than the market. Live, n-weighted across
        every scored station-cell (champion <span className="mono">{cal.champion}</span>):
      </p>
      <div className="bento">
        <div className="glass hero">
          <div className="cap" style={{ marginBottom: '0.4rem' }}>
            Champion reliability — predicted probability vs realized frequency
          </div>
          {championReliability.length === 0 ? (
            <p className="muted">No reliability bins yet — run-calibration fills these nightly.</p>
          ) : (
            <ReliabilityDiagram title={cal.champion} points={championReliability} />
          )}
          <p className="muted small" style={{ marginTop: '0.5rem' }}>
            Points on the diagonal = perfectly calibrated. The instrument’s honesty is what makes the
            efficiency verdict trustworthy.
          </p>
        </div>
        <div className="metric-col">
          <div className="tile">
            <div className="cap">Our forecast (Brier)</div>
            <div className="big">{fmtProb(skill.meanBrier)}</div>
            <div className="sub">lower is better</div>
          </div>
          <div className="tile">
            <div className="cap">The market (Brier)</div>
            <div className="big">{fmtProb(skill.meanBrierMarket)}</div>
            <div className="sub">the bar we could not clear</div>
          </div>
          <div className="tile">
            <div className="cap">Calibration error (ECE)</div>
            <div className="big">{fmtProb(skill.meanEce)}</div>
            <div className="sub">
              stations we beat the market: {skill.beatRate === null ? '—' : fmtPct(skill.beatRate, 0)}
            </div>
          </div>
        </div>
      </div>

      {/* ── the one edge that exists ──────────────────────────────────────────────────────────────── */}
      <h2>The one edge that exists — and why it doesn’t transfer</h2>
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          A Polymarket wallet (“badatmath”) trades our exact universe and went to{' '}
          <strong>{usdShort(h.sharpRealizedUsd)} realized</strong> — #1 on the WEATHER leaderboard, a thin-margin
          high-volume grinder. The edge is real (40.6% win rate net of 5,436 losers; cheap-Yes 0.10–0.25 entered
          24–72h out). But it is a <strong>maker</strong> edge — resting cheap bids below the ask, collecting the
          rebate and breadth — so it is structurally non-followable as a taker.
        </p>
        <div className="strip">
          <div className="tile">
            <div className="cap">Spread tax (ideal → taker)</div>
            <div className="big neg">{h.spreadTaxPp}pp</div>
            <div className="sub">what crossing to the ask costs</div>
          </div>
          <div className="tile rec">
            <div className="cap">Adverse-selection tax (ideal → realistic)</div>
            <div className="big neg">{h.adverseSelTaxPp}pp</div>
            <div className="sub">the book only touches your rest when you’re wrong</div>
          </div>
          <div className="tile">
            <div className="cap">Why it doesn’t transfer</div>
            <div className="big" style={{ fontSize: '1.1rem' }}>adverse-sel ≫ spread</div>
            <div className="sub">the §12 wall, made visible in a live P&amp;L</div>
          </div>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          The adverse-selection tax <em>dwarfs</em> the spread tax — that is the entire reason the sharp’s edge
          doesn’t transfer. Live benchmarks: <a href="/sharps">the SPORTS-sharps roster →</a> ·{' '}
          <a href="/replica">the three-curve replica P&amp;L →</a>
        </p>
      </div>

      {/* ── the eleventh way: executable-depth hardening sweep ─────────────────────────────────────── */}
      <h2>The eleventh way — hardened at executable depth ({HARDENING_SWEEP.date})</h2>
      <p className="muted small">{HARDENING_SWEEP.blurb}</p>
      <div className="grid cols-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
        {HARDENING_SWEEP.lanes.map((ln) => (
          <div className="panel" key={ln.lane} style={{ margin: 0 }}>
            <div className="tile-head">
              <span className="cap">
                Lane {ln.lane} — {ln.title}
              </span>
              <VerdictChip v="KILL" />
            </div>
            <p className="small" style={{ margin: '0.4rem 0 0' }}>
              {ln.result}
            </p>
          </div>
        ))}
      </div>

      {/* ── methodology (why these hold up) ───────────────────────────────────────────────────────── */}
      <h2>Why these findings hold up</h2>
      <p className="muted small">
        The verdicts are defensible because of the discipline behind them, not the volume of them:
      </p>
      <div className="grid cols-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
        {METHODOLOGY.map((m) => (
          <div className="panel" key={m.title} style={{ margin: 0 }}>
            <div className="cap">{m.title}</div>
            <p className="small muted" style={{ margin: '0.35rem 0 0' }}>
              {m.body}
            </p>
          </div>
        ))}
      </div>

      <p className="muted small" style={{ marginTop: '1.25rem' }}>
        Read-only analytics. The live trading rail is <strong>DORMANT</strong> — this is a measurement instrument
        and a defensible, reproducible proof of market efficiency, not trading advice. Full record:{' '}
        <span className="mono">FINDINGS.md</span> and its deep docs. Live evidence:{' '}
        <a href="/">forecast skill overview →</a> · <a href="/calibration">calibration &amp; reliability →</a> ·{' '}
        <a href="/amsterdam">the Amsterdam paper-trade →</a>
      </p>
    </div>
  );
}
