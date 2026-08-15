/**
 * /cheap-early — the operator's CHEAP-EARLY-ENTRY forward paper loop (the first cheap-buy variant that isn't
 * obviously killed — CHEAP-EARLY-ENTRY.md).
 *
 * The proposal: buy our house-pick bucket EARLY (the [24,36]h-to-close band, NOT the final [2,12]h lost causes),
 * capped at a cheap ask that pays ≥3× (0.20–0.33), and HOLD TO RESOLUTION. On ~1 month of real book it survives
 * its cheap gates (timing works; spread ~0.3c + depth $130–310 are ample — cost is NOT the wall) but has NOT been
 * shown +EV (the +1.2pp gap sits inside the round-trip cost; the small cells straddle 0). VERDICT: INSUFFICIENT —
 * not KILL, not GO. This page is the forward measurement made legible: the mean net-return + its city-clustered CI
 * (the gate driver), the win rate (informational — a ≥3× bet wins < 50% and is still +EV), the cost/depth
 * confirmation, and the §9R-E gate progress.
 *
 * Read-only analytics over the cheap_early_panel snapshot (cheap-early-panel Edge tick, hourly, migration 0117).
 * NOT a trade and NOT capital — the bot rail is DORMANT; no GO until the frozen §9R-E gate PASSes across ≥2
 * non-overlapping windows + an explicit operator decision (CHEAP-EARLY-ENTRY-FORWARD-HANDOFF.md / FINDINGS.md).
 */
import type { ReactElement } from 'react';
import type { CheapEarlyEntry, CheapEarlyPerDay, CheapEarlyVariantBlock, CheapEarlyView } from '@weather-edge/core';
import { EquityChart } from '../../../components/EquityChart.tsx';
import { getCheapEarly } from '../../../lib/loaders.ts';
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

// ─── sub-components ──────────────────────────────────────────────────────────

/** §9R-E gate progress: the three sufficiency bars + the clustered CI (this bet BINDS on ciLow>0, not winFrac). */
function GateBanner({ view }: { view: CheapEarlyView }): ReactElement {
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
      days, city-clustered mean net-return CI &gt; 0, zero-skill MC &lt; 5%. This is a PRICE-RETURN bet (a cheap ≥3×
      longshot) — it binds on <strong>ciLow &gt; 0</strong>, <strong>NOT</strong> winFrac ≥ 0.5 (a 25%-win panel can
      be strongly +EV). No capital until it PASSes across ≥2 non-overlapping windows + an operator decision (rail
      DORMANT). {g.reason}
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

/** The measured reads the ~1-month backtest could not settle (CHEAP-EARLY-ENTRY.md §4/§5). */
function ReadTiles({ view }: { view: CheapEarlyView }): ReactElement {
  const a = view.assumptions;
  return (
    <div className="strip">
      <div className="tile rec">
        <div className="tile-head">
          <span className="cap">Mean net-return</span>
          <span className="chip soft">running</span>
        </div>
        <div className="big" style={{ color: Number.isFinite(a.meanNetReturn) ? pnlColor(a.meanNetReturn) : undefined }}>
          {signedPct(a.meanNetReturn)}
        </div>
        <div className="sub">
          over {a.nMarkets} realized · the city-clustered CI [{signedPct(a.ciLow)}, {signedPct(a.ciHigh)}] (the gate
          driver — backtest cells straddled 0) populates at the ≥{view.gate.minMarkets}-market floor
        </div>
      </div>
      <div className="tile">
        <div className="cap">Win rate</div>
        <div className="big">{Number.isFinite(a.winRate) ? fmtPct(a.winRate, 0) : '—'}</div>
        <div className="sub">bucket-hit — INFORMATIONAL (a ≥3× bet wins &lt; 50% and is still +EV)</div>
      </div>
      <div className="tile rec">
        <div className="tile-head">
          <span className="cap">Cost — is it the wall?</span>
          <span className="chip soft">§3 confirm</span>
        </div>
        <div className="big" style={{ fontSize: '1.2rem', color: SKY }}>{pp(a.meanObservedSpread)}</div>
        <div className="sub">
          mean top-of-book spread · ask {Number.isFinite(a.meanEntryAsk) ? fmtProb(a.meanEntryAsk) : '—'} ·{' '}
          depth {Number.isFinite(a.meanDepthUsd) ? fmtUsd(a.meanDepthUsd, 0) : '—'} (both were ample on the backtest)
        </div>
      </div>
      <div className="tile">
        <div className="cap">Days accrued</div>
        <div className="big">{a.nDistinctDays}<span className="muted" style={{ fontSize: '0.9rem' }}> / {view.gate.minDistinctDays}</span></div>
        <div className="sub">{a.nMarkets} markets · {a.nCities} cities (the CI narrows as these grow)</div>
      </div>
      <div className="tile">
        <div className="cap">Fire rate</div>
        <div className="big">{Number.isFinite(a.firePct) ? fmtPct(a.firePct, 0) : '—'}</div>
        <div className="sub">entered / considered · ~{a.entriesPerDay.toFixed(1)} entries/day (the powering rate)</div>
      </div>
    </div>
  );
}

/** The fictive money tracker tiles. */
function MoneyTiles({ view }: { view: CheapEarlyView }): ReactElement {
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
        <div className="sub">of {m.nRealized} resolved</div>
      </div>
      <div className="tile">
        <div className="cap">Stake / entry</div>
        <div className="big">{fmtUsd(m.perEntryStakeUsd, 0)}</div>
        <div className="sub">fixed · depth-gated</div>
      </div>
      <div className="tile">
        <div className="cap">Entries logged</div>
        <div className="big sky">{m.nEntries}</div>
        <div className="sub">of {view.nConsidered} considered markets</div>
      </div>
    </div>
  );
}

/** Per-day chances table: markets considered vs entered + the day's paper P&L. */
function PerDayTable({ rows }: { rows: CheapEarlyPerDay[] }): ReactElement {
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

/**
 * The PRE-REGISTERED variant sweep (CHEAP-EARLY-IMPROVE.md §8) — every variant scored forward on the same
 * ticks as the canonical rule, beside the backtest cell it was registered from. Measurement only: no variant
 * verdict is ever written to the gate of record, so nothing here is a capital path.
 */
function VariantsTable({ view }: { view: CheapEarlyView }): ReactElement {
  const rows = view.variants ?? [];
  if (rows.length === 0) return <p className="muted">No variant sweep in this snapshot (pre-0127 tick).</p>;
  const canonical = rows.find((v) => v.id === 'canonical') ?? null;
  const verdictColor = (v: CheapEarlyVariantBlock['verdict']): string =>
    v === 'PASS' ? GREEN : v === 'DEAD' || v === 'KILL' ? RED : AMBER;
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>variant</th>
            <th>rule</th>
            <th className="num">n (exec / realized)</th>
            <th className="num">win%</th>
            <th className="num">mean ask</th>
            <th className="num">net / $1</th>
            <th className="num">city-clustered CI</th>
            <th>verdict</th>
            <th className="num">backtest net / $1 (CI · n)</th>
            <th className="num">Δ vs canonical</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const isCanonical = v.id === canonical?.id;
            const delta =
              isCanonical || !canonical || !Number.isFinite(v.meanNetReturn) || !Number.isFinite(canonical.meanNetReturn)
                ? null
                : v.meanNetReturn - canonical.meanNetReturn;
            const band = `[${fmtProb(v.cfg.askBandLo)},${fmtProb(v.cfg.askBandHi)}]`;
            const topK = v.cfg.cityFilter.kind === 'topK' ? v.cfg.cityFilter : null;
            return (
              <tr key={v.id}>
                <td className="small">
                  <span className="mono">{v.id}</span>
                  {isCanonical ? <span className="chip small" style={{ marginLeft: '0.35rem' }}>gate of record</span> : null}
                  <div className="muted small">{v.label}</div>
                </td>
                <td className="small mono">
                  {v.cfg.entryRule}-in-window · [{v.cfg.windowLoH},{v.cfg.windowHiH}]h · {band}
                  {v.cfg.minEdge > 0 ? ` · m≥${pp(v.cfg.minEdge, 0)}` : ''}
                  {topK ? ` · top-${topK.k} (${v.cfg.scoredCities.length} eligible)` : ''}
                </td>
                <td className="num">{v.nExecuted} / {v.nRealized}</td>
                <td className="num">{Number.isFinite(v.money.winRate) ? fmtPct(v.money.winRate, 0) : '—'}</td>
                <td className="num">{Number.isFinite(v.meanEntryAsk) ? fmtProb(v.meanEntryAsk) : '—'}</td>
                <td className="num" style={{ color: Number.isFinite(v.meanNetReturn) ? pnlColor(v.meanNetReturn) : undefined }}>
                  {signedPct(v.meanNetReturn)}
                </td>
                <td className="num small">
                  {Number.isFinite(v.ciLow) ? `[${signedPct(v.ciLow)}, ${signedPct(v.ciHigh)}]` : <span className="muted">below floor</span>}
                </td>
                <td className="small">
                  <span
                    className="chip small"
                    style={{ color: verdictColor(v.verdict), fontWeight: v.verdict === 'DEAD' ? 700 : undefined }}
                  >
                    {v.verdict}
                  </span>
                </td>
                <td className="num small muted">
                  {signedPct(v.backtestRef.netRet)} [{signedPct(v.backtestRef.ciLow)}, {signedPct(v.backtestRef.ciHigh)}] · n={v.backtestRef.n}
                </td>
                <td className="num" style={{ color: delta == null ? undefined : pnlColor(delta) }}>
                  {delta == null ? '—' : signedPct(delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Logged potential entries + their hold-to-resolution outcomes, newest target-day first. */
function EntriesTable({ rows }: { rows: CheapEarlyEntry[] }): ReactElement {
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
            <th className="num">entry (h-to-close)</th>
            <th className="num">ask</th>
            <th className="num">depth</th>
            <th className="num">spread</th>
            <th className="num">winner</th>
            <th>result</th>
            <th className="num">net P&amp;L</th>
            <th className="num">return</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((e) => {
            const htc = num(e.htcAtEntry);
            const resultLabel = e.won == null ? '—' : e.won ? 'won' : 'lost';
            const resultColor = e.won == null ? SKY : e.won ? GREEN : RED;
            return (
              <tr key={`${e.eventId}-${e.city}`}>
                <td className="small">{e.city}</td>
                <td className="mono small">{fmtDate(e.targetDate)}</td>
                <td className="mono small">{e.entryLabel || '—'}</td>
                <td className="num">{htc !== null ? `${htc.toFixed(1)}h` : '—'}</td>
                <td className="num">{fmtProb(e.entryAsk)}</td>
                <td className="num small">{fmtUsd(e.depthUsd, 0)}</td>
                <td className="num small">{pp(e.observedSpread)}</td>
                <td className="num mono small">{e.winnerTemp != null ? `${e.winnerTemp}°` : '—'}</td>
                <td className="small" style={{ color: resultColor }}>{resultLabel}</td>
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

export default async function CheapEarlyPage(): Promise<ReactElement> {
  const db = await serverDb();
  const feed = await getCheapEarly(db);
  const view = feed?.view ?? null;

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>
          Cheap-early entry <span className="chip soft">paper · rail DORMANT</span>
        </h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_cheap_early</span> RPC is deploying, or the{' '}
          <span className="mono">cheap-early-panel</span> Edge tick — hourly — hasn&apos;t computed its first snapshot).
          Refresh shortly.
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
        Cheap-early entry <span className="chip soft">paper · rail DORMANT</span>
      </h1>
      <p className="muted small">
        The operator&apos;s <strong>buy-early / cap-at-3× / occasional-buy</strong> proposal — the first cheap-buy
        variant that isn&apos;t obviously killed. Buy our house-pick bucket in the{' '}
        <strong>[{view.windowLoH},{view.windowHiH}]h-to-close</strong> band (not the final lost-causes hours), capped
        at a cheap ask of <strong>{fmtProb(view.askBandLo)}–{fmtProb(view.askBandHi)}</strong> (pays ≥3×), and{' '}
        <strong>HOLD TO RESOLUTION</strong>. On ~1 month of real book it survives its cheap gates (timing works;
        spread + depth are ample — cost is NOT the wall) but has NOT been shown +EV (the gap sits inside the cost).
        This loop <strong>measures it forward</strong> so the §9R-E gate can adjudicate as days accrue.{' '}
        <strong>Not a trade, not capital</strong> — rail DORMANT.
        {feed?.generatedAt ? (
          <>
            {' '}Snapshot <span className="mono">{fmtAgo(feed.generatedAt)}</span> (
            <span className="mono">{fmtDateTime(feed.generatedAt)}</span>) · window {view.days}d ·{' '}
            {view.gate.nCities}/{view.cities.length} cities (with data / allowlist) · ${view.stakeUsd} stake.
          </>
        ) : null}
      </p>

      <GateBanner view={view} />

      <h2>The measured reads</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        What the ~1-month backtest could not settle — now measured forward on the real{' '}
        <span className="mono">opening_captures</span> book. The <strong>mean net-return CI</strong> is the gate
        driver (the backtest cells straddled 0 by ±100%); the <strong>cost</strong> read confirms whether the tight
        spread + ample depth hold live (they were never the wall on the backtest).
      </p>
      <ReadTiles view={view} />

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
          Fire rate = entered / considered (the strategy is selective by design — &quot;occasional buy&quot;).
        </p>
        <PerDayTable rows={view.perDay} />
      </div>

      <h2>Variants (pre-registered 2026-08-15)</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          The six rules the 3,960-cell real-book sweep (<span className="mono">CHEAP-EARLY-IMPROVE.md</span> §8)
          registered for a forward read — scored on the <strong>same ticks</strong> as the canonical rule every hour,
          beside the backtest cell each came from. <strong>Not editable</strong>: the set is pinned in code, because a
          variant you can re-tune after seeing the forward number is not a forward test.
        </p>
        <VariantsTable view={view} />
        <p className="muted small" style={{ marginTop: '0.6rem' }}>
          <strong>How to read it.</strong> The decision metric is the <strong>city-clustered 95% CI on net per $1</strong>,
          and it only exists once a variant clears the §9R-E floor (n ≥ {view.gate.minMarkets} markets · ≥{view.gate.minCities}{' '}
          cities · ≥{view.gate.minDistinctDays} distinct days). A variant <strong>improves</strong> on the canonical rule only
          if its CI <strong>excludes 0</strong> AND its net exceeds canonical&apos;s — a higher point estimate with a CI
          straddling 0 is noise, which is exactly what the backtest column shows for every cell but{' '}
          <span className="mono">survivor</span> (the one positive cell of 3,960 — registered here to be killed or confirmed,
          not believed). <strong style={{ color: RED }}>DEAD</strong> = n ≥ {view.gate.minMarkets} with the CI wholly
          negative: the pre-registered prune. <strong>No variant verdict touches the gate of record</strong> — the
          §9R-E snapshot is written from the canonical block alone, so there is no capital path off this table.
          {view.variantsCommon ? (
            <>
              {Array.isArray(view.variantsCommon.windowSet) && view.variantsCommon.windowSet.length ? (
                <>
                  {' '}Entry windows pulled this tick:{' '}
                  {view.variantsCommon.windowSet.map((w) => `[${w.loH},${w.hiH}]`).join(' ∪ ')}h ·
                </>
              ) : null}{' '}
              engine{' '}
              <span className="mono">{view.variantsCommon.engineVersion}</span>
              {view.variantsCommon.cityHitRatesAvailable ? null : (
                <>
                  {' '}
                  <span className="chip" style={{ color: AMBER }}>⚠ no city hit rates this tick — top-K variants scored nothing</span>
                </>
              )}
              .
            </>
          ) : null}
        </p>
      </div>

      <h2>Logged potential entries &amp; hold-to-resolution outcomes</h2>
      <div className="panel">
        <p className="muted small" style={{ marginTop: 0 }}>
          {view.entries.length} entries the rule fired in the window. Each shows the <strong>predicted</strong> bucket,
          the <strong>hours-to-close</strong> at the (latest-allowable) entry, the ask paid, the executable{' '}
          <strong>depth</strong>, the observed top-of-book <strong>spread</strong>, the winning temperature, and the
          net paper P&amp;L at the {fmtUsd(m.perEntryStakeUsd, 0)} stake — graded by temperature label (never the
          bucket index).
        </p>
        {feed?.generatedAt ? (
          <p className="muted small" style={{ marginTop: '-0.25rem' }}>
            Latest data refreshed <strong>{fmtStockholm(feed.generatedAt)}</strong> (Stockholm) · {fmtAgo(feed.generatedAt)}.
            Recomputes hourly on the <span className="mono">cheap-early-panel</span> Edge tick.
          </p>
        ) : null}
        <EntriesTable rows={view.entries} />
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the <span className="mono">cheap_early_panel</span> snapshot (cheap-early-panel Edge
        tick, hourly). Engine: <span className="mono">core/sim/cheap-early-entry-view</span> → the tested{' '}
        <span className="mono">replayCheapEarlyPanel</span>, run on a ~6-min downsampled snapshot, so the gate above
        is <strong>indicative</strong>. Bot rail DORMANT; no capital until the §9R-E gate PASSes across ≥2 windows +
        an operator decision. Source: <span className="mono">CHEAP-EARLY-ENTRY.md</span> ·{' '}
        <span className="mono">CHEAP-EARLY-ENTRY-FORWARD-HANDOFF.md</span> · <span className="mono">FINDINGS.md</span>.
      </p>
    </div>
  );
}
