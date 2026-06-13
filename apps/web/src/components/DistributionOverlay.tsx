/**
 * Ladder distribution comparison (§5, §12 "live market with our overlay"):
 * per-bucket paired bars — house champion q vs market consensus p — with the
 * winning bucket outlined once resolved. Server component.
 */
import type { ReactElement } from 'react';
import { num, fmtProb } from '../lib/format.ts';

export function DistributionOverlay({
  labels,
  houseProbs,
  consensusProbs,
  nowcast,
  winningIdx,
  modelPending,
}: {
  labels: string[];
  houseProbs: unknown[] | null;
  consensusProbs: unknown[] | null;
  nowcast?: boolean;
  winningIdx?: number | null;
  /** WEB-6 — true when consensus is present but the house model isn't built yet. */
  modelPending?: boolean;
}): ReactElement {
  if (!houseProbs && !consensusProbs) {
    return <p className="muted small">No distributions stored yet for this event.</p>;
  }
  const max = Math.max(
    0.01,
    ...(houseProbs ?? []).map((p) => num(p) ?? 0),
    ...(consensusProbs ?? []).map((p) => num(p) ?? 0),
  );
  const widthPct = (p: number): string => `${((p / max) * 100).toFixed(1)}%`;
  return (
    <div>
      {modelPending ? (
        <p className="chip amber">model distribution not built yet — showing market consensus only</p>
      ) : null}
      <div className="legend">
        {houseProbs ? (
          <span><span className="swatch" style={{ background: 'var(--accent)' }} />house q</span>
        ) : null}
        <span><span className="swatch" style={{ background: 'var(--muted)' }} />market p</span>
        {nowcast ? <span className="chip amber">nowcast-constrained</span> : null}
      </div>
      {labels.map((label, i) => {
        const h = houseProbs ? num(houseProbs[i]) ?? 0 : null;
        const m = consensusProbs ? num(consensusProbs[i]) ?? 0 : null;
        const win = winningIdx === i;
        return (
          <div className="bar-row" key={label}>
            <span className="bar-label">{label}{win ? ' ✓' : ''}</span>
            <div className="bar-pair" title={`house ${h === null ? '—' : fmtProb(h)} · market ${m === null ? '—' : fmtProb(m)}`}>
              {h !== null ? <div className={`bar house${win ? ' winner' : ''}`} style={{ width: widthPct(h) }} /> : null}
              {m !== null ? <div className={`bar market${win ? ' winner' : ''}`} style={{ width: widthPct(m) }} /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
