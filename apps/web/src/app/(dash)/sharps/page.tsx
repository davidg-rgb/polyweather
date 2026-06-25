/**
 * /sharps — the SPORTS-sharps roster + fingerprint analytics page.
 *
 * Surfaces the SPORTS-TRADERS.md study (9th signal, FINDINGS.md) as a live operator dashboard:
 * named roster of the top Polymarket sports traders + per-trader style fingerprints (entry-odds
 * histogram, sweep/burst %, mid-odds fraction, VWAP entry, sub-sport mix, archetype).
 *
 * The copy-trade rail is DORMANT — this is the INSIGHT product, not a trade signal. Read-only
 * analytics over the daily sharps-snapshot Edge tick (migration 0059, 02:00 UTC).
 */
import type { ReactElement } from 'react';
import { BarChart, type BarDatum } from '../../../components/BarChart.tsx';
import { fmtAgo, fmtDateTime, fmtPct, fmtProb, fmtUsd, num } from '../../../lib/format.ts';
import { getSharps, type SharpTraderRow, type SportsSharpsView } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Compact USD for large values: $2.1M, $450k, $1,234. */
function fmtUsdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

/** Shorten 0x wallet: 0x1234…abcd */
function shortWallet(w: string): string {
  return w.length > 14 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

/** Archetype colour. */
function archetypeColor(a: string | null): string {
  return a === 'volume-machine' ? 'var(--ams-secondary)' : 'var(--ams-amber)';
}

// ─── sub-components ──────────────────────────────────────────────────────────

/** Top-level roster table: one row per trader, ranked by PnL. */
function RosterTable({ rows }: { rows: SharpTraderRow[] }): ReactElement {
  if (rows.length === 0) {
    return <p className="muted">No traders in the latest capture.</p>;
  }
  return (
    <div className="tbl-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>trader</th>
            <th>archetype</th>
            <th className="num">PnL (all)</th>
            <th className="num">volume (all)</th>
            <th className="num">ROI proxy</th>
            <th className="num">fills</th>
            <th className="num">VWAP entry</th>
            <th className="num">sweep %</th>
            <th className="num">mid-odds %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const profileUrl = `https://polymarket.com/profile/${r.wallet}`;
            const traderLabel = r.trader === r.wallet ? shortWallet(r.wallet) : r.trader;
            const roi = num(r.roiProxy);
            const roiColor = roi === null ? undefined : roi >= 0 ? 'var(--ams-tertiary)' : 'var(--ams-red)';
            const pnlColor = (num(r.pnlAllUsd) ?? 0) >= 0 ? 'var(--ams-tertiary)' : 'var(--ams-red)';
            const arc = r.archetype ?? 'high-roi-specialist';
            return (
              <tr key={`${r.wallet}-${i}`}>
                <td className="muted">{r.rank ?? i + 1}</td>
                <td>
                  <a href={profileUrl} target="_blank" rel="noreferrer" className="mono small" title={r.wallet}>
                    {traderLabel} ↗
                  </a>
                </td>
                <td>
                  <span className="chip small" style={{ color: archetypeColor(arc), borderColor: archetypeColor(arc) }}>
                    {arc}
                  </span>
                </td>
                <td className="num" style={{ color: pnlColor }}>
                  {fmtUsd(r.pnlAllUsd, 0)}
                </td>
                <td className="num">{fmtUsd(r.volAllUsd, 0)}</td>
                <td className="num" style={{ color: roiColor }}>
                  {roi !== null ? fmtPct(roi, 1) : '—'}
                </td>
                <td className="num">{num(r.nFills) ?? '—'}</td>
                <td className="num">{fmtProb(r.vwapEntry)}</td>
                <td className="num">{fmtPct(r.sweepFraction)}</td>
                <td className="num">{fmtPct(r.midOddsFraction)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Per-trader fingerprint card: odds histogram + sub-sport mix + style summary. */
function FingerprintCard({ r }: { r: SharpTraderRow }): ReactElement {
  const traderLabel = r.trader === r.wallet ? shortWallet(r.wallet) : r.trader;
  const profileUrl = `https://polymarket.com/profile/${r.wallet}`;
  const arc = r.archetype ?? 'high-roi-specialist';

  // Odds histogram bar data.
  const hist = Array.isArray(r.oddsHistogram) ? r.oddsHistogram : [];
  const barData: BarDatum[] = hist.map((b) => ({
    label: b.label,
    value: b.count,
    tag: b.notionalUsd > 0 ? fmtUsdShort(b.notionalUsd) : undefined,
  }));

  // Sub-sport mix: top 3 sports by fraction.
  const sportsMix = r.sportsMix && typeof r.sportsMix === 'object' ? r.sportsMix : {};
  const topSports = Object.entries(sportsMix as Record<string, number>)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  const roi = num(r.roiProxy);
  const roiColor = roi === null ? undefined : roi >= 0 ? 'var(--ams-tertiary)' : 'var(--ams-red)';
  const pnlColor = (num(r.pnlAllUsd) ?? 0) >= 0 ? 'var(--ams-tertiary)' : 'var(--ams-red)';

  return (
    <div className="panel" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <strong>
          <a href={profileUrl} target="_blank" rel="noreferrer" className="mono" title={r.wallet}>
            {traderLabel} ↗
          </a>
        </strong>
        <span className="chip small" style={{ color: archetypeColor(arc), borderColor: archetypeColor(arc) }}>
          {arc}
        </span>
        {r.rank !== null && r.rank !== undefined ? <span className="muted small">rank #{r.rank}</span> : null}
      </div>

      {/* headline stats strip */}
      <div className="strip" style={{ marginBottom: '0.75rem' }}>
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">PnL (all-time)</div>
          <div className="big" style={{ color: pnlColor }}>{fmtUsd(r.pnlAllUsd, 0)}</div>
          <div className="sub">ROI proxy {roi !== null ? fmtPct(roi, 1) : '—'}</div>
        </div>
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">Volume (all-time)</div>
          <div className="big">{fmtUsd(r.volAllUsd, 0)}</div>
          <div className="sub">{num(r.nFills) ?? '—'} fills sampled</div>
        </div>
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">VWAP entry</div>
          <div className="big">{fmtProb(r.vwapEntry)}</div>
          <div className="sub">vol-wtd avg price</div>
        </div>
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">Sweep / burst %</div>
          <div className="big">{fmtPct(r.sweepFraction)}</div>
          <div className="sub">same-second book-sweep fills</div>
        </div>
        <div className="tile" style={{ minWidth: 0 }}>
          <div className="cap">Mid-odds %</div>
          <div className="big">{fmtPct(r.midOddsFraction)}</div>
          <div className="sub">35¢–65¢ band</div>
        </div>
        {topSports.length > 0 ? (
          <div className="tile" style={{ minWidth: 0 }}>
            <div className="cap">Top sport</div>
            <div className="big">{topSports[0]?.[0] ?? '—'}</div>
            <div className="sub">
              {topSports.map(([s, f]) => `${s} ${fmtPct(f, 0)}`).join(' · ')}
            </div>
          </div>
        ) : null}
      </div>

      {/* entry-odds histogram */}
      {barData.length > 0 ? (
        <>
          <div className="cap" style={{ marginBottom: '0.25rem' }}>Entry-odds distribution (fills count + notional)</div>
          <BarChart
            data={barData}
            width={560}
            height={180}
            color={archetypeColor(arc)}
            ariaLabel={`entry-odds histogram for ${traderLabel}`}
            valueFmt={(v) => String(v)}
            emptyHint="no fills in this capture"
          />
        </>
      ) : null}
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function SharpsPage(): Promise<ReactElement> {
  const db = await serverDb();
  const view: SportsSharpsView | null = await getSharps(db, { limit: 20 });

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>SPORTS sharps — Polymarket sports-trader roster</h1>
        <p className="muted">
          The feed isn&apos;t available yet (the <span className="mono">dash_sharps</span> RPC is deploying or no
          snapshot has been captured yet). Refresh shortly after the daily cron (02:00 UTC) runs.
        </p>
      </div>
    );
  }

  const { latest, roster } = view;
  const hasData = roster.length > 0;
  const nTraders = num(latest?.nTraders) ?? 0;

  // Headline aggregate stats from the roster.
  const topPnl = roster.reduce<SharpTraderRow | null>((m, r) => {
    const v = num(r.pnlAllUsd) ?? -Infinity;
    return (m === null || v > (num(m.pnlAllUsd) ?? -Infinity)) ? r : m;
  }, null);
  const nVolumeM = roster.filter((r) => r.archetype === 'volume-machine').length;
  const nSpecialist = roster.filter((r) => r.archetype === 'high-roi-specialist').length;
  const avgVwap = roster.length > 0
    ? roster.reduce((a, r) => a + (num(r.vwapEntry) ?? 0), 0) / roster.length
    : null;

  return (
    <div className="ams-dash">
      <h1>
        SPORTS sharps <span className="chip soft">analytics · rail DORMANT</span>
      </h1>
      <p className="muted small">
        The top Polymarket sports traders by all-time PnL — named roster + per-trader fingerprints (entry-odds
        histogram, archetype, sweep/burst %, mid-odds %, VWAP, sub-sport mix). The copy-trade thesis is{' '}
        <strong>FALSIFIED</strong> (9th signal — see FINDINGS.md): volume machines&apos; edge regresses to ≈0;
        specialists&apos; apparent edge is survivorship + non-executable book-sweep mark. This is the{' '}
        <strong>insight product</strong>, not a trade signal.
        {latest?.capturedAt ? (
          <>
            {' '}
            Latest snapshot <span className="mono">{fmtAgo(latest.capturedAt)}</span> (
            <span className="mono">{fmtDateTime(latest.capturedAt)}Z</span>).
          </>
        ) : null}
      </p>

      {/* ── verdict banner ─────────────────────────────────────────────────────────────────────────── */}
      <div className="info-banner">
        <strong>SIGNAL 9 — COPY-TRADE SPORTS SHARPS = FAIL.</strong> Named the best Polymarket sports traders
        (SPORTS leaderboard: swisstony, kch123, RN1 = volume machines; mintblade, fishalive, frostrizz = high-ROI
        in-play soccer specialists). Measured copyability via <span className="mono">core/sim/copy-trade.ts</span>:
        volume machines&apos; edge regresses to ≈0 at any follower lag × spread; specialists&apos; ~100% win/PASS is
        survivorship + non-executable book-sweep mark. <strong>NOT copyable.</strong> Rail DORMANT.
        Source: <span className="mono">SPORTS-TRADERS.md §3–4</span>.
      </div>

      {/* ── headline tiles ─────────────────────────────────────────────────────────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Traders captured</span>
            <span className="chip soft">latest</span>
          </div>
          <div className="big sky">{hasData ? nTraders : '—'}</div>
          <div className="sub">unique wallets in the SPORTS leaderboard</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Volume machines</span>
          </div>
          <div className="big" style={{ color: 'var(--ams-secondary)' }}>{hasData ? nVolumeM : '—'}</div>
          <div className="sub">high-fill-count / low-ROI archetype</div>
        </div>
        <div className="tile rec">
          <div className="tile-head">
            <span className="cap">Specialists</span>
          </div>
          <div className="big amber">{hasData ? nSpecialist : '—'}</div>
          <div className="sub">high-ROI in-play archetype</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Top PnL all-time</span>
          </div>
          <div className="big">{topPnl ? fmtUsdShort(num(topPnl.pnlAllUsd) ?? 0) : '—'}</div>
          <div className="sub">{topPnl ? (topPnl.trader === topPnl.wallet ? shortWallet(topPnl.wallet) : topPnl.trader) : 'none yet'}</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Avg VWAP entry</span>
          </div>
          <div className="big">{avgVwap !== null ? fmtProb(avgVwap) : '—'}</div>
          <div className="sub">vol-wtd avg price across roster</div>
        </div>
      </div>

      {/* ── roster table ───────────────────────────────────────────────────────────────────────────── */}
      <h2>Roster — top SPORTS traders by all-time PnL</h2>
      <div className="panel">
        {hasData ? (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {roster.length} traders shown · as of{' '}
              {latest?.capturedAt ? (
                <span className="mono">{fmtDateTime(latest.capturedAt)}Z</span>
              ) : (
                '—'
              )}{' '}
              · snapshot daily at 02:00 UTC. Profile link opens Polymarket. Fills sampled = up to 200 most-recent
              trades (cron wall-time budget).
            </p>
            <RosterTable rows={roster} />
          </>
        ) : (
          <p className="muted">
            No captures yet — the daily <span className="mono">sharps-snapshot</span> cron runs at 02:00 UTC. Refresh
            after the first run.
          </p>
        )}
      </div>

      {/* ── per-trader fingerprint cards ────────────────────────────────────────────────────────────── */}
      {hasData ? (
        <>
          <h2>Fingerprint cards — per-trader style</h2>
          <p className="muted small">
            Each card shows the entry-odds distribution (histogram of fill prices; bar height = fills count, tag =
            notional), sweep/burst % (fills sharing a same-second timestamp — the book-sweep signature), mid-odds % (35¢–65¢ balanced band),
            VWAP entry, and the top sub-sports by notional share.
          </p>
          {roster.slice(0, 10).map((r, i) => (
            <FingerprintCard key={`${r.wallet}-${i}`} r={r} />
          ))}
          {roster.length > 10 ? (
            <p className="muted small">
              Showing top 10 of {roster.length} traders. Expand the{' '}
              <span className="mono">p_limit</span> param in <span className="mono">dash_sharps</span> to show more.
            </p>
          ) : null}
        </>
      ) : null}

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Read-only analytics over the live <span className="mono">sports_sharps</span> feed (sharps-snapshot Edge tick,
        daily 02:00 UTC). Copy-trade rail DORMANT. The signal is falsified; this is the insight deliverable.
        Source: <span className="mono">SPORTS-TRADERS.md</span> · <span className="mono">FINDINGS.md §9</span>.
      </p>
    </div>
  );
}
