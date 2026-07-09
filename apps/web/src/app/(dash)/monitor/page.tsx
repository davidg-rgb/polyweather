/**
 * /monitor — the forward EFFICIENCY-MONITOR paper loop (operator-requested 2026-07-09).
 *
 * A forward paper loop that trades the two most-recent falsified findings on real, day-before executable
 * prices and lets the frozen §9R-E gate adjudicate them OVER TIME. It is a CONFIRMATION instrument, not a
 * profit engine: every backtest (C19–C24) says the market is efficient, so the honest expectation is that
 * both strategies wash or bleed. Its one high-value outcome is the small chance a signal holds FORWARD —
 * the only thing that could reopen trading (FINDINGS.md). No capital, ever; the rail stays DORMANT.
 *
 *   S1 · regime + forecast cheap-subset (forward-confirms KILL-GATE 2 + C24; the Q4 high-disagreement cell
 *        is the only finding with a positive point estimate, tracked separately)
 *   S2 · ladder-geometry troughs on the day-before ask ladder (forward-confirms C23-T2/T3)
 *
 * Read-only over the efficiency_monitor_panel snapshot (efficiency-monitor-run.ts --record, migration 0091).
 */
import type { ReactElement } from 'react';
import { getEfficiencyMonitor } from '../../../lib/loaders.ts';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct } from '../../../lib/format.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const GREEN = 'var(--ams-tertiary)';
const RED = 'var(--ams-red)';
const AMBER = 'var(--ams-amber)';
const SKY = 'var(--ams-secondary)';

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const pp = (v: unknown): string => (Number.isFinite(num(v)) ? `${num(v) >= 0 ? '+' : '−'}${Math.abs(num(v) * 100).toFixed(2)}pp` : '—');
const labelColor = (l: unknown): string => (l === 'PASS' ? GREEN : l === 'KILL' ? RED : AMBER);
const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);

/** The frozen §9R-E gate progress for one strategy: sufficiency bars + the city-clustered CI. */
function GateBanner({ v, title, sub }: { v: unknown; title: string; sub: string }): ReactElement {
  const label = get(v, 'label');
  const nMarkets = num(get(v, 'nMarkets'));
  const nCities = num(get(v, 'nCities'));
  const nDays = num(get(v, 'nDistinctDays'));
  const winFrac = num(get(v, 'winFrac'));
  const ciLow = num(get(v, 'ciLow'));
  const ciHigh = num(get(v, 'ciHigh'));
  const zsp = num(get(v, 'zeroSkillPassRate'));
  const clears = Number.isFinite(ciLow) && ciLow > 0;
  const bar = (n: number, min: number, l: string): ReactElement => (
    <div className="tile" style={{ minWidth: 0 }}>
      <div className="cap">{l}</div>
      <div className="big" style={{ color: n >= min ? GREEN : undefined }}>{Number.isFinite(n) ? n : '—'}<span className="muted" style={{ fontSize: '0.9rem' }}> / {min}</span></div>
      <div className="sub">{n >= min ? 'met ✓' : `${Math.max(0, min - n)} to go`}</div>
    </div>
  );
  return (
    <div className="info-banner">
      <strong style={{ color: labelColor(label) }}>{title} — {String(label ?? '—')}.</strong> {sub}
      <div className="strip" style={{ marginTop: '0.6rem' }}>
        {bar(nMarkets, 40, 'paper buys')}
        {bar(nCities, 6, 'cities')}
        {bar(nDays, 7, 'distinct days')}
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">win fraction</div>
          <div className="big" style={{ color: winFrac >= 0.5 ? GREEN : RED, fontSize: '1.1rem' }}>{Number.isFinite(winFrac) ? fmtPct(winFrac, 1) : '—'}</div>
          <div className="sub">bar ≥ 50%</div>
        </div>
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">city-clustered 95% CI</div>
          <div className="big" style={{ color: clears ? GREEN : RED, fontSize: '1.05rem' }}>[{pp(ciLow)}, {pp(ciHigh)}]</div>
          <div className="sub">{clears ? 'clears 0 ✓' : 'includes 0'} · zsMC {Number.isFinite(zsp) ? fmtPct(zsp, 1) : '—'}</div>
        </div>
      </div>
    </div>
  );
}

/** S1's per-disagreement-quartile edge — the C24 split, with Q4 (the only positive point estimate) flagged. */
function QuartileTable({ s1 }: { s1: unknown }): ReactElement {
  const byQ = get(s1, 'byQuartile') as Record<string, Record<string, unknown>> | undefined;
  const q4Day = get(s1, 'q4DayClustered');
  const q4Days = num(get(s1, 'q4DistinctWeatherDays'));
  return (
    <div className="panel">
      <p className="muted small" style={{ marginTop: 0 }}>
        The C24 split: does the day-before edge grow on high-ensemble-disagreement (Q4) days? The backtest said
        no (well-powered null). Q4 is the <strong>only</strong> cell with a positive point estimate, so its
        <strong> day-clustered</strong> CI (the weather-day is the independent unit) is the one to watch.
      </p>
      <div className="tbl-scroll">
        <table>
          <thead><tr><th>disagreement quartile</th><th className="num">paper buys</th><th className="num">edge (won − ask)</th></tr></thead>
          <tbody>
            {[1, 2, 3, 4].map((q) => {
              const s = byQ?.[String(q)];
              const isQ4 = q === 4;
              return (
                <tr key={q} style={isQ4 ? { fontWeight: 600 } : undefined}>
                  <td className="small">Q{q}{isQ4 ? ' · high disagreement' : ''}</td>
                  <td className="num">{s ? num(s.nGraded) : '—'}</td>
                  <td className="num" style={{ color: s && num(s.edge) > 0 ? GREEN : RED }}>{s ? pp(s.edge) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="strip" style={{ marginTop: '0.6rem' }}>
        <div className="tile rec">
          <div className="tile-head"><span className="cap">Q4 day-clustered edge</span><span className="chip soft">the C24 gate</span></div>
          <div className="big" style={{ color: num(get(q4Day, 'lo')) > 0 ? GREEN : SKY }}>{pp(get(q4Day, 'mean'))}</div>
          <div className="sub">CI [{pp(get(q4Day, 'lo'))}, {pp(get(q4Day, 'hi'))}] · {Number.isFinite(q4Days) ? q4Days : '—'} distinct weather-days (≥10 to power the test)</div>
        </div>
      </div>
    </div>
  );
}

export default async function MonitorPage(): Promise<ReactElement> {
  const db = await serverDb();
  const feed = await getEfficiencyMonitor(db);
  const v = feed.view;

  if (!v) {
    return (
      <div className="ams-dash">
        <h1>Efficiency monitor <span className="chip soft">paper · rail DORMANT</span></h1>
        <p className="muted">
          No snapshot yet. Apply migration <span className="mono">0091</span> and run{' '}
          <span className="mono">efficiency-monitor-run.ts --record</span> (daily) to begin accruing. This page renders
          once the first snapshot lands.
        </p>
      </div>
    );
  }

  const s1 = get(v, 's1');
  const s2 = get(v, 's2');
  const s2edge = get(s2, 'edge');
  const nEvents = num(get(v, 'nEvents'));

  return (
    <div className="ams-dash">
      <h1>Efficiency monitor <span className="chip soft">paper · rail DORMANT</span></h1>
      <p className="muted small">
        A forward paper loop that trades the two latest <strong>falsified</strong> findings on real day-before
        executable prices and lets the frozen §9R-E gate adjudicate them over time. It is a{' '}
        <strong>confirmation instrument, not a profit engine</strong> — every backtest (C19–C24) says the market is
        efficient, so the honest expectation is that both strategies wash or bleed. Its one high-value outcome is
        the small chance a signal holds forward against expectation, which is the only thing that could reopen
        trading. <strong>No capital, ever</strong>; the rail stays DORMANT.
        {feed.generatedAt ? (
          <> {' '}Snapshot <span className="mono">{fmtAgo(feed.generatedAt)}</span> (<span className="mono">{fmtDateTime(feed.generatedAt)}</span>) · as-of{' '}
            <span className="mono">{feed.asOf ? fmtDate(feed.asOf) : '—'}</span> · {Number.isFinite(nEvents) ? nEvents : '—'} resolved markets scored.</>
        ) : null}
      </p>

      <h2>S1 · Regime + forecast cheap-subset</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Paper-buy our calibrated forecast&apos;s cheap-longshot subset at the real day-before ask; grade at
        resolution. Forward-confirms KILL-GATE 2 (pooled efficiency) and C24 (the regime split).
      </p>
      <GateBanner v={get(s1, 'verdict')} title="§9R-E gate (S1, pooled)"
        sub="Buying our forecast's cheap longshots as a taker — the backtest KILLs (cheap-longshot overpricing). Watch whether it crosses 0 forward." />
      <QuartileTable s1={s1} />

      <h2 style={{ marginTop: '1.4rem' }}>S2 · Ladder-geometry troughs</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Detect interior price-troughs (a bimodal ladder a single-peaked Tmax distribution shouldn&apos;t price) on
        the day-before ask ladder and buy the trough. Forward-confirms C23 (−8.72pp on the real book). Troughs are
        rare (~1%), so this accrues slowly — an INSUFFICIENT_DATA state is itself the finding that they&apos;re too
        rare to trade.
      </p>
      <GateBanner v={get(s2, 'verdict')} title="§9R-E gate (S2, geometry)"
        sub={`${num(get(s2, 'nTroughs')) || 0} troughs detected · per-buy edge ${pp(get(s2edge, 'edge'))} (top-of-book — depth only worsens it).`} />

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the <span className="mono">efficiency_monitor_panel</span> snapshot
        (<span className="mono">efficiency-monitor-run.ts --record</span>, migration 0091). Engine:{' '}
        <span className="mono">core/sim/efficiency-monitor</span> → the frozen <span className="mono">openingVerdict</span>.
        Rail paper/DORMANT; no capital until a §9R-E PASS + an operator decision. Source:{' '}
        <span className="mono">FINDINGS.md</span> (C23/C24) · <span className="mono">SIGNAL-BACKLOG.md</span>.
      </p>
    </div>
  );
}
