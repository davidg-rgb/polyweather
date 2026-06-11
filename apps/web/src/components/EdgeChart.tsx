/**
 * EdgeChart (§5, §6.21): "one screen tells you the whole opportunity" — per
 * bucket: house q vs executable ask paired bars, pass/fail edge badge,
 * reasons tooltip, AND the §15 no-silent-drift check rendered: the stored
 * hourly edge_evaluations (F-038) side-by-side with a display-side recompute
 * through the SAME core computeBucketEdges over the stored book. Server
 * component.
 */
import type { ReactElement } from 'react';
import type { EdgeRow } from '@weather-edge/core';
import type { EdgeComparison } from '../lib/edge-display.ts';
import { fmtDateTime, fmtProb, num } from '../lib/format.ts';

export function EdgeChart({ comparison }: { comparison: EdgeComparison }): ReactElement {
  const { rows, comparedCount, driftCount } = comparison;
  const anyStored = rows.some((r) => r.stored !== null);
  const latestHour = rows.find((r) => r.stored)?.stored?.hour ?? null;
  const maxBar = Math.max(
    0.01,
    ...rows.map((r) => Math.max(num(r.stored?.q) ?? 0, num(r.stored?.execAsk) ?? 0, r.recomputed?.q ?? 0, r.recomputed?.execAsk ?? 0)),
  );
  const w = (p: number | null): string => `${(((p ?? 0) / maxBar) * 100).toFixed(1)}%`;

  return (
    <div>
      {driftCount > 0 ? (
        <div className="drift-banner">
          ⚠ DRIFT: {driftCount} bucket(s) where the display recompute disagrees with the stored
          engine evaluation beyond storage rounding — engine and UI are not computing the same
          numbers. Investigate before trusting either.
        </div>
      ) : comparedCount > 0 ? (
        <div className="ok-banner">
          ✓ display recompute matches the stored engine rows on {comparedCount} comparable
          bucket(s) — no silent drift (§15).
        </div>
      ) : null}
      {!anyStored ? <p className="muted small">No stored edge evaluations yet (hourly, F-038).</p> : null}
      {latestHour ? (
        <p className="muted small">stored hour: <span className="mono">{fmtDateTime(latestHour)}</span></p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>bucket</th>
            <th>q vs exec ask</th>
            <th className="num">q</th>
            <th className="num">exec ask</th>
            <th className="num">edge</th>
            <th className="num">min edge</th>
            <th>stored</th>
            <th>recomputed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = r.stored;
            const rc = r.recomputed;
            const q = num(s?.q) ?? rc?.q ?? null;
            const ask = num(s?.execAsk) ?? rc?.execAsk ?? null;
            return (
              <tr key={r.bucketIdx} style={r.drift.length > 0 ? { outline: '1px solid var(--red)' } : undefined}>
                <td className="mono">{r.label}</td>
                <td style={{ minWidth: 140 }}>
                  <div className="bar-pair">
                    <div className="bar house" style={{ width: w(q) }} />
                    <div className="bar market" style={{ width: w(ask) }} />
                  </div>
                </td>
                <td className="num">{fmtProb(q)}</td>
                <td className="num">{fmtProb(ask)}</td>
                <td className="num">{fmtProb(num(s?.edge) ?? rc?.edge ?? null)}</td>
                <td className="num">{fmtProb(num(s?.minEdge) ?? rc?.minEdge ?? null)}</td>
                <td>
                  {s ? (
                    <span className={s.pass ? 'badge-pass' : 'badge-fail'} title={s.reasons.join(', ') || 'all criteria met'}>
                      {s.pass ? 'PASS' : `✗ ${s.reasons.join(', ') || 'fail'}`}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{renderRecomputed(r.comparable, r.drift, rc)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderRecomputed(comparable: boolean, drift: string[], rc: EdgeRow | null): ReactElement {
  if (!rc) return <span className="muted">—</span>;
  if (rc.execAsk === null) {
    return <span className="muted small" title={rc.reasons.join(', ')}>{rc.reasons.join(', ') || 'no data'}</span>;
  }
  if (!comparable) {
    return <span className="muted small" title="book_top3 keeps 3 levels — depth differs from the engine's full-book walk">book truncated</span>;
  }
  if (drift.length > 0) {
    return (
      <span className="badge-fail" title={`fields drifting: ${drift.join(', ')} — recomputed edge ${rc.edge?.toFixed(6) ?? '—'}`}>
        DRIFT: {drift.join(', ')}
      </span>
    );
  }
  return <span className="badge-pass" title={`recomputed edge ${rc.edge?.toFixed(6) ?? '—'} == stored`}>match</span>;
}
