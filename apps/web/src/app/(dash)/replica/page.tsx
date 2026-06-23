/**
 * /replica — the badatmath-replica paper-trial dashboard (the second analytics-pivot deliverable).
 *
 * A fictional, no-money trial that mimics the #1 WEATHER sharp's revealed buying model (cheap-Yes 0.10–0.25,
 * ~36h before resolution, ~3 buckets/city·day, ~$12/position, $250/day cap, best cities computed) and scores
 * every buy THREE ways — maker-ideal / maker-realistic / taker. The gaps between the curves ARE the story:
 * the spread tax (ideal→taker) and the adverse-selection tax (ideal→realistic) make visible WHY the sharp's
 * maker edge is his and not ours (WALLET-RECON §11/§12/§15). Two scopes: the resolved BACKTEST seed and the
 * growing FORWARD run (the daily local task persists into replica_positions/_runs; this reads dash_replica_sim
 * and scores via the same core engine). NOT trading — the measurement of a known-non-replicable edge.
 */
import type { ReactElement } from 'react';
import type { CityRoi, DailyRow, LegStats, ReplicaSummary } from '@weather-edge/core';
import { EquityChart, type EquitySeries } from '../../../components/EquityChart.tsx';
import { fmtAgo, fmtDate, fmtPct, fmtProb, fmtUsd, num } from '../../../lib/format.ts';
import { getReplicaSim, type ReplicaScopeView } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

/** The three price legs — identity colour ramp (NOT P&L-sign green/red) + dash for colour-blind safety. */
const LEGS = [
  { key: 'makerIdeal', tag: '🟢 maker-ideal', color: 'var(--ams-arm-14)', dash: '', gloss: 'his cheap rested bid, assume filled — the strategy ceiling' },
  { key: 'makerRealistic', tag: '🟡 maker-realistic', color: 'var(--ams-arm-13)', dash: '5 3', gloss: 'rest the bid, fill only if the book touches it (adverse selection)' },
  { key: 'taker', tag: '🔴 taker', color: 'var(--ams-arm-16)', dash: '7 3 1 3', gloss: 'cross to the ask — what we’d pay chasing him as a taker' },
] as const;

const pnlClass = (v: unknown): string => ((num(v) ?? 0) >= 0 ? 'pos' : 'neg');
const legOf = (sm: ReplicaSummary, key: (typeof LEGS)[number]['key']): LegStats => sm[key];

/** Signed percent (a fraction → ±%), '—' when not finite. */
const fmtPctSigned = (v: unknown, dp = 1): string => {
  const n = num(v);
  return n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(dp)}%`;
};

/** Build the three cumulative-equity series for a scope from its daily ledger. */
function equitySeries(daily: DailyRow[]): EquitySeries[] {
  return LEGS.map((l) => ({
    label: l.tag.replace(/^.. /, ''),
    color: l.color,
    dash: l.dash,
    values: daily.map((d) =>
      l.key === 'makerIdeal' ? d.makerIdealCum : l.key === 'makerRealistic' ? d.makerRealisticCum : d.takerCum,
    ),
  }));
}

/** The three-curve table for one scope (the headline read). */
function CurveTable({ sm }: { sm: ReplicaSummary }): ReactElement {
  return (
    <div className="tbl-scroll">
      <table style={{ width: 'auto' }}>
        <thead>
          <tr>
            <th>curve</th>
            <th>what it is</th>
            <th className="num">resolved</th>
            <th className="num">stake</th>
            <th className="num">gross P&amp;L</th>
            <th className="num">ROI</th>
            <th className="num">win%</th>
            <th className="num">EV/$1 (95% CI)</th>
          </tr>
        </thead>
        <tbody>
          {LEGS.map((l) => {
            const s = legOf(sm, l.key);
            return (
              <tr key={l.key}>
                <td className="mono">
                  <span className="swatch" style={{ background: l.color, display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 6 }} />
                  {l.tag}
                </td>
                <td className="muted small">{l.gloss}</td>
                <td className="num">{s.nResolved}</td>
                <td className="num">{fmtUsd(s.stakeUsd, 0)}</td>
                <td className={`num ${pnlClass(s.grossPnlUsd)}`}>{fmtUsd(s.grossPnlUsd, 0)}</td>
                <td className={`num ${pnlClass(s.roiGross)}`}>{fmtPctSigned(s.roiGross)}</td>
                <td className="num">{fmtPct(s.hitRate, 1)}</td>
                <td className="num">
                  {fmtPctSigned(s.ev, 2)}
                  <br />
                  <span className="muted small">
                    [{fmtPctSigned(s.evCiLo, 2)}, {fmtPctSigned(s.evCiHi, 2)}]
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The two tax deltas + the maker fill rate — the whole point of the trial. */
function TaxLines({ sm }: { sm: ReplicaSummary }): ReactElement {
  return (
    <p className="muted small" style={{ margin: '0.5rem 0 0' }}>
      <strong>Spread tax</strong> (ideal→taker):{' '}
      <span className={pnlClass(-(num(sm.spreadTaxRoi) ?? 0))}>{fmtPctSigned(sm.spreadTaxRoi)} ROI</span> — the cost of
      crossing to the ask instead of resting his cheap bid.{' '}
      <strong>Adverse-selection tax</strong> (ideal→realistic):{' '}
      <span className={pnlClass(-(num(sm.adverseSelTaxRoi) ?? 0))}>{fmtPctSigned(sm.adverseSelTaxRoi)} ROI</span> — the
      cost of REAL maker fills (only {fmtPct(sm.makerFillRate, 0)} of rested bids fill, and they fill on the losers).
    </p>
  );
}

/** Cumulative-P&L chart + its legend for a scope. */
function EquityBlock({ daily }: { daily: DailyRow[] }): ReactElement {
  const series = equitySeries(daily);
  const dates = daily.map((d) => d.date);
  return (
    <>
      <EquityChart dates={dates} series={series} />
      <div className="legend">
        {series.map((s) => (
          <span key={s.label}>
            <svg width={20} height={6} style={{ marginRight: 4, verticalAlign: 'middle' }} aria-hidden="true">
              <line x1={0} y1={3} x2={20} y2={3} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash || undefined} />
            </svg>
            {s.label}
          </span>
        ))}
      </div>
    </>
  );
}

/** The day-by-day ledger table (gross hold-to-resolution P&L, cumulative). */
function DailyTable({ daily }: { daily: DailyRow[] }): ReactElement {
  if (daily.length === 0) return <p className="muted">No resolved positions yet — the curve fills in as buys resolve.</p>;
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>date</th>
            <th className="num">resolved</th>
            <th className="num">maker-ideal</th>
            <th className="num">cum</th>
            <th className="num">maker-realistic</th>
            <th className="num">cum</th>
            <th className="num">taker</th>
            <th className="num">cum</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((r) => (
            <tr key={r.date}>
              <td>{fmtDate(r.date)}</td>
              <td className="num">{r.nResolved}</td>
              <td className={`num ${pnlClass(r.makerIdealPnl)}`}>{fmtUsd(r.makerIdealPnl, 0)}</td>
              <td className={`num ${pnlClass(r.makerIdealCum)}`}>{fmtUsd(r.makerIdealCum, 0)}</td>
              <td className={`num ${pnlClass(r.makerRealisticPnl)}`}>{fmtUsd(r.makerRealisticPnl, 0)}</td>
              <td className={`num ${pnlClass(r.makerRealisticCum)}`}>{fmtUsd(r.makerRealisticCum, 0)}</td>
              <td className={`num ${pnlClass(r.takerPnl)}`}>{fmtUsd(r.takerPnl, 0)}</td>
              <td className={`num ${pnlClass(r.takerCum)}`}>{fmtUsd(r.takerCum, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Best-performing cities by maker-ideal ROI. */
function CitiesTable({ cities }: { cities: CityRoi[] }): ReactElement {
  if (cities.length === 0) return <p className="muted">Not enough resolved positions per city yet.</p>;
  return (
    <div className="tbl-scroll">
      <table style={{ width: 'auto' }}>
        <thead>
          <tr>
            <th>city</th>
            <th>region</th>
            <th className="num">resolved</th>
            <th className="num">stake</th>
            <th className="num">gross P&amp;L</th>
            <th className="num">ROI</th>
            <th className="num">win%</th>
          </tr>
        </thead>
        <tbody>
          {cities.map((c) => (
            <tr key={c.city}>
              <td className="mono">{c.city}</td>
              <td className="muted small">{c.region}</td>
              <td className="num">{c.nResolved}</td>
              <td className="num">{fmtUsd(c.stakeUsd, 0)}</td>
              <td className={`num ${pnlClass(c.grossPnlUsd)}`}>{fmtUsd(c.grossPnlUsd, 0)}</td>
              <td className={`num ${pnlClass(c.roiGross)}`}>{fmtPctSigned(c.roiGross)}</td>
              <td className="num">{fmtPct(c.hitRate, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A scope's full detail (equity + daily + cities), folded behind a disclosure. */
function ScopeDetail({ scope, label }: { scope: ReplicaScopeView; label: string }): ReactElement {
  return (
    <details className="detail">
      <summary>{label} — equity curve, day-by-day ledger &amp; best cities</summary>
      <div className="panel">
        <EquityBlock daily={scope.daily} />
      </div>
      <h3 style={{ marginTop: '0.75rem' }}>Day by day (gross hold-to-resolution, cumulative)</h3>
      <DailyTable daily={scope.daily} />
      <h3 style={{ marginTop: '0.75rem' }}>Best cities (by maker-ideal ROI)</h3>
      <CitiesTable cities={scope.cities} />
    </details>
  );
}

export default async function ReplicaPage(): Promise<ReactElement> {
  const db = await serverDb();
  const view = await getReplicaSim(db);

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>badatmath replica — paper-trial</h1>
        <p className="muted">
          The trial isn&apos;t available yet (the <span className="mono">dash_replica_sim</span> RPC is deploying).
          Refresh shortly.
        </p>
      </div>
    );
  }

  const { strat, backtest, forward, open } = view;
  const bSm = backtest.summary;
  const fSm = forward.summary;
  const fwdLive = forward.daily.length > 0;
  const openStake = open.reduce((a, p) => a + p.stakeUsd, 0);

  return (
    <div className="ams-dash">
      <h1>
        badatmath replica — paper-trial <span className="chip blue">fictional · no money</span>
      </h1>
      <p className="muted small">
        Mimics the #1 WEATHER sharp&apos;s revealed buying model — cheap-Yes{' '}
        <span className="mono">{strat.cheapBandLo}–{strat.cheapBandHi}</span>, entry{' '}
        <span className="mono">{strat.entryLeadHours}h</span> before resolution,{' '}
        <span className="mono">{strat.breadthPerCityDay}</span> buckets/city·day,{' '}
        <span className="mono">${strat.positionStakeUsd}</span>/position,{' '}
        <span className="mono">${strat.dailyBankrollCapUsd}</span>/day cap — scored three ways. Insight value,{' '}
        <strong>not trading</strong>.
      </p>

      {/* ── decision strip: backtest seed ROIs + forward track record + last run ─────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Backtest seed · maker-ideal</span>
            <span className="chip soft">{view.backtestResolved}n</span>
          </div>
          <div className={`big ${pnlClass(bSm.makerIdeal.roiGross)}`}>{fmtPctSigned(bSm.makerIdeal.roiGross)}</div>
          <div className="sub">his cheap bid, assume filled — the strategy ceiling</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Backtest · maker-realistic</span>
          </div>
          <div className={`big ${pnlClass(bSm.makerRealistic.roiGross)}`}>{fmtPctSigned(bSm.makerRealistic.roiGross)}</div>
          <div className="sub">if WE rested the bids (adverse selection)</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Backtest · taker</span>
          </div>
          <div className={`big ${pnlClass(bSm.taker.roiGross)}`}>{fmtPctSigned(bSm.taker.roiGross)}</div>
          <div className="sub">what we&apos;d net chasing him as a taker</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Forward track record</span>
            <span className="chip soft" title="small sample — accruing">live</span>
          </div>
          <div className="big sky">
            {view.forwardResolved}<span className="muted" style={{ fontSize: '0.9rem' }}> / {view.forwardPlaced}</span>
          </div>
          <div className="sub">
            resolved / placed · {view.forwardOpen} open
            {fwdLive ? ` · maker-ideal ${fmtPctSigned(fSm.makerIdeal.roiGross)}` : ''}
          </div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Last forward run</span>
          </div>
          <div className="big" style={{ fontSize: '1.2rem' }}>{view.lastForwardRunAt ? fmtAgo(view.lastForwardRunAt) : '—'}</div>
          <div className="sub">
            whitelist {view.whitelist.length} cities{view.whitelist.length ? `: ${view.whitelist.slice(0, 4).join(', ')}${view.whitelist.length > 4 ? '…' : ''}` : ''}
          </div>
        </div>
      </div>

      {/* ── the spread/adverse-selection story (banner) ──────────────────────────────────────────────── */}
      <div className="info-banner">
        <strong>Why three curves?</strong> badatmath&apos;s edge is a MAKER edge (rests cheap bids, collects the rebate
        + breadth). It is non-followable as a taker and non-replicable as a maker on our own selection — so a copycat&apos;s
        realised P&amp;L depends entirely on WHICH price it transacts at. The gaps between the curves are the tax we&apos;d pay.
      </div>

      {/* ── FORWARD (the live tracking the operator asked for) ───────────────────────────────────────── */}
      <h2>Forward run — live track record</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          {view.forwardPlaced} positions placed → <strong>{view.forwardResolved} resolved</strong> ·{' '}
          <strong>{view.forwardOpen} open</strong> (awaiting resolution). The daily local task reconciles + places, then
          persists here. {view.lastForwardRunAt ? `Last run ${fmtAgo(view.lastForwardRunAt)}.` : 'No forward run recorded yet.'}
        </p>
        {fwdLive ? (
          <>
            <CurveTable sm={fSm} />
            <TaxLines sm={fSm} />
            <h3 style={{ marginTop: '0.9rem' }}>Cumulative P&amp;L</h3>
            <EquityBlock daily={forward.daily} />
            <h3 style={{ marginTop: '0.9rem' }}>Day by day</h3>
            <DailyTable daily={forward.daily} />
          </>
        ) : (
          <p className="muted">
            No forward positions have resolved yet — the three curves fill in as today&apos;s buys settle over the next
            day or two.
          </p>
        )}
      </div>

      {/* open positions */}
      <h2>Currently open — placed, awaiting resolution</h2>
      <div className="panel">
        {open.length === 0 ? (
          <p className="muted">No open positions.</p>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {open.length} open · {fmtUsd(openStake, 0)} at risk (maker-ideal basis).
            </p>
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>placed</th>
                    <th>city</th>
                    <th>target</th>
                    <th>bucket</th>
                    <th className="num">maker px</th>
                    <th className="num">taker px</th>
                    <th className="num">stake</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((p, i) => (
                    <tr key={`${p.citySlug}-${p.targetDate}-${p.bucketLabel}-${i}`}>
                      <td>{p.placedAtUtc ? fmtDate(p.placedAtUtc) : '—'}</td>
                      <td className="mono">{p.citySlug}</td>
                      <td>{fmtDate(p.targetDate)}</td>
                      <td>{p.bucketLabel}</td>
                      <td className="num">{fmtProb(p.makerPrice)}</td>
                      <td className="num">{fmtProb(p.takerPrice)}</td>
                      <td className="num">{fmtUsd(p.stakeUsd, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── BACKTEST seed (the headline story, with its full detail folded) ──────────────────────────── */}
      <h2>Backtest seed — the headline</h2>
      <div className="panel">
        {view.backtestFunnel ? (
          <p className="muted small" style={{ marginTop: 0 }}>
            {view.backtestFunnel.nCandidates} candidate buckets → {view.backtestFunnel.nBand} band-eligible →{' '}
            {view.backtestFunnel.nSelected} breadth-selected → <strong>{view.backtestFunnel.nAllocated} bought</strong> →{' '}
            {bSm.nResolved} resolved. {view.lastBacktestRunAt ? `Seeded ${fmtAgo(view.lastBacktestRunAt)}.` : ''}
          </p>
        ) : null}
        {bSm.nResolved > 0 ? (
          <>
            <CurveTable sm={bSm} />
            <TaxLines sm={bSm} />
            <ScopeDetail scope={backtest} label="Backtest seed" />
          </>
        ) : (
          <p className="muted">No backtest seed persisted yet — run the backtest with <span className="mono">--persist</span>.</p>
        )}
      </div>

      {!view.hasData ? (
        <div className="panel">
          <p className="muted">
            No positions persisted yet. Run <span className="mono">pnpm tsx scripts/research/badatmath-replica.ts --persist</span>{' '}
            (backtest seed) and the daily <span className="mono">--mode forward --persist</span> task to populate this dashboard.
          </p>
        </div>
      ) : null}

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Three curves because the sharp&apos;s edge is a MAKER edge that is non-followable as a taker and non-replicable as
        a maker on our forecast. This trial watches the spread tax and adverse-selection tax in real time. Not trading; no
        money; read-only.
      </p>
    </div>
  );
}
