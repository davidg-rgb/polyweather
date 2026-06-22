/**
 * SharpDisagreement — "what the #1 weather sharp is betting" (migration 0049, WALLET-RECON-HANDOFF.md
 * Build #1). An external Polymarket wallet ("badatmath.") trades our exact universe and is verifiably
 * profitable (#1 on the WEATHER leaderboard, +$25k realized). We surface its revealed Amsterdam bet for the
 * soonest upcoming market as an INDEPENDENT third forecaster, set against our house_ensemble call and the
 * market's modal bucket. The signal is DISAGREEMENT — not a copy-trade (the trading thesis stays closed).
 */
import type { ReactElement } from 'react';
import { fmtDate, fmtProb, fmtUsd, num } from '../lib/format.ts';
import type { SharpsView } from '../lib/loaders.ts';

/** One of the three independent calls on the upcoming market. */
function Call({ who, label, tone }: { who: string; label: string | null; tone: string }): ReactElement {
  return (
    <div className="tile" style={{ minWidth: 0 }}>
      <div className="tile-head">
        <span className="cap">{who}</span>
      </div>
      <div className="big" style={{ color: tone }}>{label ?? '—'}</div>
    </div>
  );
}

export function SharpDisagreement({ sharps }: { sharps: SharpsView }): ReactElement {
  const rank = num(sharps.rank);
  const pnl = num(sharps.pnlUsd);
  const idLine = (
    <span className="cap" style={{ color: 'var(--ams-secondary)' }}>
      {rank != null ? `#${rank} WEATHER` : 'tracked'}
      {pnl != null ? ` · ${fmtUsd(pnl)} realized` : ''}
    </span>
  );

  if (!sharps.hasSharp) {
    return (
      <>
        <h2>What the #1 weather sharp is betting</h2>
        <div className="panel">
          <p className="muted small">
            Benchmarking <span className="mono">{sharps.label ?? sharps.address}</span> — the #1 wallet on
            Polymarket&apos;s WEATHER leaderboard (verified +$25k realized on our exact universe). The daily{' '}
            <span className="mono">sharp-wallet-track</span> tick hasn&apos;t recorded an Amsterdam position yet;
            it appears here once it has. Insight benchmark, <strong>not a copy-trade</strong>.
          </p>
        </div>
      </>
    );
  }

  const distinct = num(sharps.disagreement) ?? 0;
  const delta = sharps.signedDeltaIdx;
  const agree = distinct <= 1;
  // sharp vs our call read (delta ≈ °C in the whole-°C interior; sign = warmer/colder than us)
  const vsUs =
    delta == null
      ? 'no comparable forecast'
      : delta === 0
        ? 'same bucket as our forecast'
        : `${Math.abs(delta)}°C ${delta < 0 ? 'colder' : 'warmer'} than our call`;

  return (
    <>
      <h2>
        What the #1 weather sharp is betting{' '}
        <span className="chip blue" title="external Polymarket wallet — analytics benchmark, not a copy-trade">
          {sharps.label ?? sharps.address.slice(0, 10)}
        </span>
      </h2>
      <div className="panel">
        <div className="tile-head" style={{ marginBottom: '0.4rem' }}>
          <span className="muted small">
            Their revealed bet on the soonest upcoming Amsterdam market
            {sharps.targetDate ? ` (${fmtDate(sharps.targetDate)})` : ''}
            {sharps.asOfDate ? ` · pulled ${fmtDate(sharps.asOfDate)}` : ''}.
          </span>
          {idLine}
        </div>

        {/* the three independent calls */}
        <div className="strip" style={{ marginBottom: '0.6rem' }}>
          <Call who="Sharp's bucket" label={sharps.sharpLabel} tone="var(--ams-secondary)" />
          <Call who="Our forecast" label={sharps.ourLabel} tone="var(--ams-violet, var(--ams-secondary))" />
          <Call who="Market modal" label={sharps.marketLabel} tone="var(--ams-sky, var(--ams-secondary))" />
        </div>

        <p className="muted small">
          {agree ? (
            <>
              <strong className="pos">Agreement.</strong> The sharp, our forecast and the market converge on the
              same bucket — a high-confidence read on this market.
            </>
          ) : (
            <>
              <strong>{distinct === 3 ? 'Three-way split.' : 'Disagreement.'}</strong> The sharp&apos;s bucket is{' '}
              <strong>{vsUs}</strong>. A verified-profitable independent forecaster diverging from us is the signal
              worth a second look — they make their edge buying the eventually-correct bucket cheap the day before.
            </>
          )}{' '}
          <span className="mono">Insight benchmark, not a copy-trade.</span>
        </p>

        {sharps.positions.length > 0 ? (
          <details className="detail">
            <summary>Their {sharps.positions.length} Amsterdam position(s)</summary>
            <div className="tbl-scroll">
              <table style={{ width: 'auto' }}>
                <thead>
                  <tr>
                    <th>resolves</th>
                    <th>bucket</th>
                    <th>side</th>
                    <th className="num">shares</th>
                    <th className="num">entry</th>
                    <th className="num">value</th>
                  </tr>
                </thead>
                <tbody>
                  {sharps.positions.map((p, i) => {
                    const title = p.title ?? '';
                    const bucket = /be (.+?) on /.exec(title)?.[1] ?? (p.bucketIdx == null ? '—' : `idx ${p.bucketIdx}`);
                    return (
                      <tr key={`${p.targetDate ?? 'x'}-${p.bucketIdx ?? i}-${p.outcome}`}>
                        <td className="mono">{p.targetDate ? fmtDate(p.targetDate) : '—'}</td>
                        <td>{bucket}</td>
                        <td>
                          <span className={p.outcome === 'Yes' ? 'pos' : 'neg'}>{p.outcome}</span>
                        </td>
                        <td className="num">{num(p.sizeShares)?.toFixed(0) ?? '—'}</td>
                        <td className="num">{p.avgPrice == null ? '—' : fmtProb(num(p.avgPrice)!)}</td>
                        <td className="num">{p.curValueUsd == null ? '—' : fmtUsd(num(p.curValueUsd)!)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              Cheap (&lt;0.25) <span className="pos">Yes</span> legs are the engine of their edge; the{' '}
              <span className="neg">No</span> spray is the bleed. Source: Polymarket public data API.
            </p>
          </details>
        ) : null}
      </div>
    </>
  );
}
