/**
 * /calibration — Brier/ECE/reliability across sources (§6.21
 * getCalibrationView): score table with the pooled gate row highlighted,
 * reliability diagrams per source, and the F-019 promotion flow (the server
 * re-checks the thresholds; the button just asks).
 */
import type { ReactElement } from 'react';
import { ReliabilityDiagram } from '../../../components/ReliabilityDiagram.tsx';
import { PromoteButton } from '../../../components/controls.tsx';
import { fmtProb, num } from '../../../lib/format.ts';
import { getCalibrationView } from '../../../lib/loaders.ts';
import { shapeReliability } from '../../../lib/shapers.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function CalibrationPage(): Promise<ReactElement> {
  const v = await getCalibrationView(await serverDb());
  const bySource = (s: string) => v.scores.filter((r) => r.source === s);
  // WEB-5 — derive the source list from the actually-scored rows instead of a
  // hardcoded house-only const, so the 45 scored market_consensus reliability
  // rows surface (they were hidden before). PROMOTABLE preserves the F-019
  // invariant: market_consensus is the BASELINE, never a promotion target — only
  // house_* challengers get a promote button.
  const sources = [...new Set(v.scores.map((r) => r.source))].sort();
  const PROMOTABLE = new Set(['house_gaussian', 'house_ensemble']);

  return (
    <div>
      <h1>
        Calibration <span className="chip blue">champion: {v.champion}</span>
      </h1>

      <h2>Reliability (stored reliability bins, n-weighted)</h2>
      <div className="panel grid cols-2">
        {sources.length === 0 ? (
          <p className="muted">No scored sources yet — run-calibration fills this nightly.</p>
        ) : (
          sources.map((s) => (
            <ReliabilityDiagram key={s} title={s} points={shapeReliability(bySource(s))} />
          ))
        )}
      </div>

      <h2>Champion promotion (F-019)</h2>
      <div className="panel">
        <p className="muted small">
          Promotion requires ≥60 out-of-sample days, paired bootstrap p &lt; 0.05 vs
          market_consensus, and a ≥5% better point estimate — re-checked server-side on click.
        </p>
        {sources.filter((s) => s !== v.champion && PROMOTABLE.has(s)).map((s) => (
          <PromoteButton key={s} source={s} />
        ))}
      </div>

      <h2>Scores</h2>
      <div className="panel">
        {v.scores.length === 0 ? (
          <p className="muted">No calibration scores yet — run-calibration fills this nightly.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>city</th>
                <th>source</th>
                <th className="num">lead</th>
                <th>window</th>
                <th className="num">brier</th>
                <th className="num">market</th>
                <th className="num">bootstrap p</th>
                <th className="num">ece</th>
                <th className="num">sharpness</th>
                <th className="num">n</th>
              </tr>
            </thead>
            <tbody>
              {[...v.scores]
                .sort((a, b) => (a.city ?? '').localeCompare(b.city ?? '') || a.source.localeCompare(b.source) || a.lead - b.lead)
                .map((r, i) => {
                  const pooled = r.city === null;
                  const b = num(r.brier);
                  const m = num(r.brierMarket);
                  const better = b !== null && m !== null && b < m;
                  return (
                    <tr key={i} style={pooled ? { background: 'rgba(76,194,255,0.06)' } : undefined}>
                      <td>{r.city ?? <span className="chip blue" title="the pooled zero-UUID gate row (§7.14)">POOLED</span>}</td>
                      <td className="mono">{r.source}</td>
                      <td className="num">{r.lead === -1 ? 'all' : r.lead}</td>
                      <td>{r.window}</td>
                      <td className={`num ${better ? 'pos' : ''}`}>{fmtProb(r.brier)}</td>
                      <td className="num">{fmtProb(r.brierMarket)}</td>
                      <td className="num">{fmtProb(r.bootstrapP)}</td>
                      <td className="num">{fmtProb(r.ece)}</td>
                      <td className="num">{fmtProb(r.sharpness)}</td>
                      <td className="num">{num(r.n) ?? '—'}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
