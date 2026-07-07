/**
 * /convergence — the GOOGLE-PICKS-BUCKET forward-paper overview (the operator's "Test 2").
 *
 * Surfaces a PURE taker strategy driven only by Google's predicted bucket: across all capture-universe cities,
 * per fresh daily-Tmax market, buy the bucket Google's daily-max forecast points at when its taker ask is cheap
 * (execAsk < 0.15 — the operator-flagged cheap-entry floor), take profit when its execBid re-rates to ≥ tpAbs,
 * NO stop-loss, else HOLD to resolution. The ENTRY is held FIXED and FIVE take-profit exits {0.30..0.50} are
 * compared side-by-side (the operator wants the most-favourable exit). The page shows the logged potential
 * ENTRIES + their EXITS, the exit-variant COMPARISON, per-day CHANCES, Google COVERAGE, a FICTIVE MONEY TRACKER,
 * and the §9R-E gate progress.
 *
 * Read-only analytics over the google-paper-panel snapshot (Edge tick, every 15 min, migration 0086). NOT a
 * trade and NOT capital — the bot rail is paper/DORMANT (FINDINGS.md). Google is a ~1-week FORWARD SEED
 * (35/45 cities, ~7 resolved days), so the gate below reads INSUFFICIENT for weeks — that is expected.
 */
import type { ReactElement } from 'react';
import type { GoogleEntry, GooglePerDay, GoogleTpVariant, GoogleView } from '@weather-edge/core';
import { EquityChart } from '../../../components/EquityChart.tsx';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct, fmtProb, fmtStockholm, fmtUsd, num } from '../../../lib/format.ts';
import { getGooglePaper } from '../../../lib/loaders.ts';
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
  resolution_win: { label: 'resolved · won', color: GREEN },
  resolution_lose: { label: 'resolved · lost', color: RED },
  open_marked: { label: 'open · marked', color: SKY },
};

// ─── sub-components ──────────────────────────────────────────────────────────

/** §9R-E gate progress: the three sufficiency bars toward a verdict. */
function GateBanner({ view }: { view: GoogleView }): ReactElement {
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
      <strong style={{ color: labelColor }}>§9R-E GATE — {g.label}.</strong>{' '}
      Frozen net-profit bar: ≥{g.minMarkets} paper markets · ≥{g.minCities} cities · ≥{g.minDistinctDays} distinct
      days, city-clustered CI &gt; 0, zero-skill MC &lt; 5%. No capital until it PASSes (bot rail paper/DORMANT). {g.reason}
      <div className="sub" style={{ marginTop: '0.4rem' }}>
        <strong>Google is a ~1-week forward SEED</strong> (35/45 cities, ~7 resolved days) — this reads
        INSUFFICIENT for weeks by construction; the sample grows ~1 day/day.
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
function MoneyTiles({ view }: { view: GoogleView }): ReactElement {
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
        <div className="sub">fixed · taker</div>
      </div>
      <div className="tile">
        <div className="cap">Entries logged</div>
        <div className="big sky">{m.nEntries}</div>
        <div className="sub">of {view.nGoogleEvents} Google-covered markets</div>
      </div>
    </div>
  );
}

/** Google coverage: how many fresh markets carried a Google forecast + which cities have no feed yet. */
function CoveragePanel({ view }: { view: GoogleView }): ReactElement {
  return (
    <>
      <div className="strip">
        <div className="tile">
          <div className="cap">Fresh markets</div>
          <div className="big sky">{view.nFreshEvents}</div>
          <div className="sub">considered in the {view.days}d window</div>
        </div>
        <div className="tile">
          <div className="cap">Google-covered</div>
          <div className="big" style={{ color: GREEN }}>{view.nGoogleEvents}</div>
          <div className="sub">had a bucketable Google forecast</div>
        </div>
        <div className="tile">
          <div className="cap">No Google feed</div>
          <div className="big" style={{ color: view.nNoGoogleEvents > 0 ? AMBER : undefined }}>{view.nNoGoogleEvents}</div>
          <div className="sub">forward seed still filling in</div>
        </div>
        {view.excludeFahrenheit ? (
          <div className="tile">
            <div className="cap">°F excluded</div>
            <div className="big" style={{ color: view.nExcludedFahrenheit > 0 ? AMBER : undefined }}>{view.nExcludedFahrenheit}</div>
            <div className="sub">US °F markets · °C-only mode</div>
          </div>
        ) : null}
      </div>
      {view.excludeFahrenheit ? (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          <strong>°C-only mode</strong> (operator-set): US °F markets are excluded from the strategy. In the offline
          buy/sell sweep the °F cohort went 0/6 while °C went 8/18 — dropping °F was the biggest P&amp;L lever.{' '}
          <strong>Root-caused</strong>: not a rounding bug but genuine Google forecast inaccuracy — a systematic
          <strong> cold bias</strong> for US airport highs (~14% bucket accuracy), so the too-cold pick never re-rates
          to the take-profit and decays to $0 (zero °F take-profits). Exclusion is justified on forecast quality.
        </p>
      ) : null}
      {view.citiesNoGoogle.length > 0 ? (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          <strong>No Google data yet</strong> for {view.citiesNoGoogle.length} cit
          {view.citiesNoGoogle.length === 1 ? 'y' : 'ies'} in the window: {view.citiesNoGoogle.join(', ')}. Those
          markets are counted but never traded (Google Weather only started accruing ~1 week ago).
        </p>
      ) : null}
    </>
  );
}

/** Per-day chances table: markets considered vs entered + the day's paper P&L. */
function PerDayTable({ rows }: { rows: GooglePerDay[] }): ReactElement {
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

/** Logged potential entries + their exits, newest target-day first. */
function EntriesTable({ rows }: { rows: GoogleEntry[] }): ReactElement {
  if (rows.length === 0) return <p className="muted">No entries logged in the window yet.</p>;
  const ordered = [...rows].sort((a, b) => (a.targetDate < b.targetDate ? 1 : a.targetDate > b.targetDate ? -1 : a.city.localeCompare(b.city)));
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>city</th>
            <th>target day</th>
            <th>Google °C</th>
            <th>predicted bucket</th>
            <th className="num">entry age</th>
            <th className="num">entry</th>
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
                <td className="mono small">{Number.isFinite(e.googleTmaxC) ? `${e.googleTmaxC.toFixed(1)}°C` : '—'}</td>
                <td className="mono small">{e.entryLabel || '—'}</td>
                <td className="num">{age !== null ? `${age.toFixed(1)}h` : '—'}</td>
                <td className="num">{fmtProb(e.entryPrice)}</td>
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

/** Exit-variant comparison: five TP levels over the SAME fixed entry — the operator's "most-favourable exit" read. */
function TpComparisonTable({ view }: { view: GoogleView }): ReactElement {
  const variants: GoogleTpVariant[] = view.tpComparison?.variants ?? [];
  if (variants.length === 0) return <p className="muted">No exit-variant data yet.</p>;
  // flag the most-favourable variant by total net paper P&L (ties resolve to the lowest TP level).
  let bestIdx = -1;
  let bestNet = Number.NEGATIVE_INFINITY;
  variants.forEach((v, i) => {
    if (v.nTrades > 0 && v.netPnlUsd > bestNet) {
      bestNet = v.netPnlUsd;
      bestIdx = i;
    }
  });
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>take-profit</th>
            <th className="num">trades</th>
            <th className="num">TP-hit</th>
            <th className="num">held</th>
            <th className="num">net P&amp;L</th>
            <th className="num">mean return</th>
            <th className="num">win%</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v, i) => (
            <tr key={v.tpAbs}>
              <td className="mono small">
                {fmtProb(v.tpAbs)}
                {i === bestIdx ? (
                  <span className="chip small" style={{ marginLeft: '0.4rem', color: GREEN }}>★ best</span>
                ) : null}
              </td>
              <td className="num">{v.nTrades}</td>
              <td className="num">{v.nTpHit}</td>
              <td className="num">{v.nHeldToResolution}</td>
              <td className="num" style={{ color: pnlColor(v.netPnlUsd) }}>{signedUsd(v.netPnlUsd)}</td>
              <td className="num" style={{ color: pnlColor(v.meanNetReturn) }}>{signedPct(v.meanNetReturn)}</td>
              <td className="num">{v.nTrades > 0 ? fmtPct(v.winRate, 0) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function ConvergencePage(): Promise<ReactElement> {
  const db = await serverDb();
  const feed = await getGooglePaper(db);
  const view = feed?.view ?? null;

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>
          Google picks bucket <span className="chip soft">paper · forward seed · rail DORMANT</span>
        </h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_google_paper</span> RPC is deploying, or
          the <span className="mono">google-paper-panel</span> Edge tick — every 15 min — hasn&apos;t computed its
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
        Google picks bucket <span className="chip soft">paper · forward seed · rail DORMANT</span>
      </h1>
      <p className="muted small">
        The operator&apos;s &ldquo;Test 2&rdquo;: a <strong>pure taker</strong> strategy driven only by Google
        Weather&apos;s predicted bucket. Across the <strong>°C</strong> capture cities{view.excludeFahrenheit ? ' (US °F markets excluded — °C-only)' : ''}, per fresh daily-Tmax market: buy the
        Google-predicted bucket when its ask is cheap (<span className="mono">{fmtProb(view.askMin)} ≤ execAsk ≤ {fmtProb(view.askMax)}</span>),
        then compare <strong>five take-profit exits</strong> (<span className="mono">bid ≥ 0.30 … 0.50</span>) over that
        same fixed entry — <strong>no stop-loss</strong>, HOLD to resolution as the floor. This is the forward{' '}
        <strong>paper measurement</strong> made legible — logged potential entries, their exits, per-day chances,
        Google coverage, and a <strong>fictive</strong> money tracker (fixed {fmtUsd(m.perEntryStakeUsd, 0)} stake per
        entry). <strong>Not a trade, not capital</strong> — the bot rail is paper/DORMANT; the §9R-E gate governs any GO.
        {feed?.generatedAt ? (
          <>
            {' '}Snapshot <span className="mono">{fmtAgo(feed.generatedAt)}</span> (
            <span className="mono">{fmtDateTime(feed.generatedAt)}</span>) · window {view.days}d ·{' '}
            {view.gate.nCities}/{view.cities.length} cities (scored / universe).
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

      <h2>Exit-variant comparison</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          The SAME fixed cheap entry (buy <span className="mono">execAsk &lt; {fmtProb(view.askMax)}</span>, no
          stop-loss), compared across five take-profit exits. The entry population is identical across variants by
          construction — <strong>{view.tpComparison?.nEntered ?? 0} entered</strong> markets each — so only the exit
          mix and P&amp;L differ. <span className="mono">held</span> = settled at resolution (the hold-to-resolution
          floor when TP never hits). The <span style={{ color: GREEN }}>★ best</span> row is the highest net paper
          P&amp;L. <strong>Fictive</strong>, not a trade.
        </p>
        <TpComparisonTable view={view} />
      </div>

      <h2>Google coverage</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          How many fresh markets carried a bucketable Google forecast this window. Google Weather is a{' '}
          <strong>forward-only</strong> source that started accruing ~1 week ago — ~10 of 45 cities have no feed yet,
          and those markets are counted but never traded.
        </p>
        <CoveragePanel view={view} />
      </div>

      <h2>Per-day chances</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          How many fresh markets we considered vs entered each station-local target day, and that day&apos;s paper
          P&amp;L. Fire rate = entered / considered (Google-covered markets whose predicted bucket was cheap enough to buy).
        </p>
        <PerDayTable rows={view.perDay} />
      </div>

      <h2>Logged potential entries &amp; exits</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          {view.entries.length} entries the Google-bucket rule fired in the window. Each shows the{' '}
          <strong>Google °C</strong> forecast, the <strong>predicted bucket</strong> it picked (the temperature the
          bet opened on), the taker entry, the <strong>canonical</strong> take-profit exit (TP {fmtProb(view.tpAbs)},
          no SL — see the exit-variant comparison above for all five), and the net paper P&amp;L at the{' '}
          {fmtUsd(m.perEntryStakeUsd, 0)} stake.
        </p>
        {feed?.generatedAt ? (
          <p className="muted small" style={{ marginTop: '-0.25rem' }}>
            Latest data refreshed <strong>{fmtStockholm(feed.generatedAt)}</strong> (Stockholm) ·{' '}
            {fmtAgo(feed.generatedAt)}. Recomputes every 15 min on the <span className="mono">google-paper-panel</span> Edge tick.
          </p>
        ) : null}
        <EntriesTable rows={view.entries} />
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the <span className="mono">google_paper_panel</span> snapshot (google-paper-panel
        Edge tick, every 15 min). Engine: <span className="mono">core/sim/google-bucket-view</span> — a pure taker
        replay on the bucket Google&apos;s daily-max forecast points at (buy execAsk &lt; {fmtProb(view.askMax)}, five
        take-profit exits 0.30–0.50 over that fixed entry, no stop-loss, else hold-to-resolution). Bot rail
        paper/DORMANT; no capital until the §9R-E gate PASSes. Source: <span className="mono">FINDINGS.md</span>.
      </p>
    </div>
  );
}
