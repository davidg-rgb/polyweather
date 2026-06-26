/**
 * / — analytics overview (the product headline since the 2026-06-15 pivot): how good is our calibrated
 * forecast, and can it beat the market? Leads with the house-vs-market skill summary and the measured
 * market-efficiency verdict (composes the existing dash_calibration + dash_events_list RPCs — no new RPC).
 * The trading machinery is dormant, so the operational chrome (mode / halts / jobs from dash_today_overview)
 * is preserved but DEMOTED to a footer strip; the bet ledger lives behind /bets.
 *
 * Styled in the shared ".ams-dash" Terminal-Glass idiom (the same surface as /efficiency, /amsterdam,
 * /sharps, …) so the product's front door matches the rest of the analytics suite.
 */
import type { ReactElement } from 'react';
import { JobHealthTable } from '../../components/JobHealthTable.tsx';
import { ReliabilityDiagram } from '../../components/ReliabilityDiagram.tsx';
import { fmtPct, fmtProb, num } from '../../lib/format.ts';
import { getCalibrationView, getEventsList, getTodayOverview } from '../../lib/loaders.ts';
import { shapeReliability, summarizeForecastSkill } from '../../lib/shapers.ts';
import { serverDb } from '../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function OverviewPage(): Promise<ReactElement> {
  const db = await serverDb();
  const [cal, events, ops] = await Promise.all([getCalibrationView(db), getEventsList(db), getTodayOverview(db)]);
  const skill = summarizeForecastSkill(cal.scores, cal.champion);
  const championReliability = shapeReliability(cal.scores.filter((r) => r.source === cal.champion));
  const beatsMarket = skill.skillVsMarket !== null && skill.skillVsMarket > 0;
  const verdict =
    skill.skillVsMarket === null
      ? { chip: 'amber', text: 'no scored history yet' }
      : beatsMarket
        ? { chip: 'green', text: `we beat the market by ${fmtPct(skill.skillVsMarket, 1)}` }
        : { chip: 'blue', text: 'market efficient — measured' };

  return (
    <div className="ams-dash">
      <h1>
        Forecast skill vs. the market{' '}
        <span className="chip blue">champion: {cal.champion}</span>{' '}
        <span className={`chip ${verdict.chip}`}>{verdict.text}</span>
      </h1>
      <p className="muted small">
        We price daily-max temperature markets for ~46 global airport stations against a calibrated multi-model
        NWP ensemble, and score every forecast against the realized truth and the market. Brier is n-weighted
        across scored stations (lower is better).
      </p>

      {/* ── headline skill strip ─────────────────────────────────────────────────────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="cap">Our forecast (Brier)</div>
          <div className="big">{fmtProb(skill.meanBrier)}</div>
          <div className="sub">lower is better</div>
        </div>
        <div className="tile">
          <div className="cap">The market (Brier)</div>
          <div className="big">{fmtProb(skill.meanBrierMarket)}</div>
          <div className="sub">the bar to clear</div>
        </div>
        <div className="tile">
          <div className="cap">Skill vs. market</div>
          <div className={`big ${beatsMarket ? 'pos' : 'neg'}`}>
            {skill.skillVsMarket === null ? '—' : `${beatsMarket ? '+' : ''}${fmtPct(skill.skillVsMarket, 1)}`}
          </div>
          <div className="sub">{skill.nCells} cells · {num(skill.totalN) ?? 0} obs</div>
        </div>
        <div className="tile">
          <div className="cap">Stations we beat</div>
          <div className="big sky">{skill.beatRate === null ? '—' : fmtPct(skill.beatRate, 0)}</div>
          <div className="sub">share of scored stations</div>
        </div>
        <div className="tile">
          <div className="cap">Calibration error (ECE)</div>
          <div className="big">{fmtProb(skill.meanEce)}</div>
          <div className="sub">predicted vs realized gap</div>
        </div>
      </div>

      {/* ── the verdict ──────────────────────────────────────────────────────────────────────────────── */}
      <h2>Can you beat these markets?</h2>
      <div className="info-banner">
        <strong>Measured answer: no — and we can prove why.</strong> Across an exhaustive R&amp;D program we tried
        every lever to systematically out-forecast the market and rejected each one with large-sample evidence.
      </div>
      <div className="panel">
        <ul className="muted" style={{ marginTop: 0 }}>
          <li>
            The multi-day NWP blend is at its <strong>point-skill ceiling</strong> — four independent levers
            failed (regression MOS, recency/concentration reweighting, regime-conditional weighting, and a
            residual-structure feature search at R²≈0.6%).
          </li>
          <li>
            The one signal that beats <em>our own</em> forecast — the intraday running-max nowcast — is
            <strong> already priced by a faster, more accurate market</strong> (market RMSE ≈ the unrealizable
            oracle by mid-afternoon).
          </li>
          <li>
            The market even <strong>zeroes logically-impossible buckets faster than we can observe</strong>:
            across 754 station-days, the price on temperature buckets below the day&apos;s already-printed running
            max is effectively nil, with no exploitable latency window (WO-5).
          </li>
        </ul>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Conclusion: within free public weather data these markets are <strong>efficient</strong>. The value here
          is the measurement instrument, not a trading edge — live trading is dormant by design. See the full
          proof — every falsified lever, measured at executable depth — on{' '}
          <strong>
            <a href="/efficiency">the verdict page →</a>
          </strong>
          . Live evidence: <a href="/calibration">calibration &amp; reliability →</a> ·{' '}
          <a href="/events">open events &amp; collection health →</a>
        </p>
      </div>

      {/* ── champion reliability ─────────────────────────────────────────────────────────────────────── */}
      <h2>Champion reliability</h2>
      <div className="panel">
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {championReliability.length === 0 ? (
            <p className="muted">No reliability bins yet — run-calibration fills these nightly.</p>
          ) : (
            <ReliabilityDiagram title={cal.champion} points={championReliability} />
          )}
        </div>
      </div>

      {/* ── coverage ─────────────────────────────────────────────────────────────────────────────────── */}
      <h2>Coverage</h2>
      <div className="strip">
        <div className="tile">
          <div className="cap">Open events</div>
          <div className="big sky">{num(events.counts.open) ?? 0}</div>
        </div>
        <div className="tile">
          <div className="cap">With a house distribution</div>
          <div className="big">{num(events.counts.withHouse) ?? 0}</div>
        </div>
        <div className="tile">
          <div className="cap">With a fresh market snapshot</div>
          <div className="big">{num(events.counts.withSnapshot) ?? 0}</div>
        </div>
      </div>

      {/* ── operations (demoted: trading is dormant) ─────────────────────────────────────────────────── */}
      <h2 className="muted">Operations</h2>
      {ops.breakerStates.length > 0 ? (
        <div className="drift-banner">
          ⛔ active halts:{' '}
          {ops.breakerStates.map((b) => (
            <span key={b.key} className="mono" style={{ marginRight: 8 }}>
              {b.key}
            </span>
          ))}
          <a href="/admin" className="small">
            manage on /admin
          </a>
        </div>
      ) : null}
      <div className="panel">
        <p className="small muted" style={{ marginTop: 0 }}>
          trading mode: <span className="mono">{ops.mode}</span> · the bet ledger (dormant) lives at{' '}
          <a href="/bets">/bets</a>
        </p>
        <JobHealthTable jobs={ops.jobHealth} />
        <p className="small">
          <a href="/system">full system health →</a>
        </p>
      </div>
    </div>
  );
}
