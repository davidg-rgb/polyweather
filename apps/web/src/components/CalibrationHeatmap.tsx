/**
 * City calibration heatmap (§5): model × lead grid of bias/σ/weight from
 * model_stats, one table per snapshot slot (W3 keeps 10Z/22Z apart). Cell
 * tint scales with σ (wider = hotter). Data shaped by shapeHeatmap
 * (§15-tested). Server component.
 */
import type { ReactElement } from 'react';
import { heatmapKey, type HeatmapGrid } from '../lib/shapers.ts';

export function CalibrationHeatmap({ grid }: { grid: HeatmapGrid }): ReactElement {
  if (grid.models.length === 0) {
    return <p className="muted small">No model_stats for slot {grid.slot} yet (run-calibration fills this).</p>;
  }
  const sigmas = Object.values(grid.cells).map((c) => c.sigma ?? 0);
  const maxSigma = Math.max(0.1, ...sigmas);
  return (
    <div>
      <h3>slot {grid.slot}</h3>
      <table>
        <thead>
          <tr>
            <th>model</th>
            {grid.leads.map((l) => (
              <th key={l} className="num">lead {l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.models.map((m) => (
            <tr key={m}>
              <td className="mono">{m}</td>
              {grid.leads.map((l) => {
                const c = grid.cells[heatmapKey(m, l)];
                if (!c) return <td key={l} className="muted heatcell">—</td>;
                const heat = Math.min(1, (c.sigma ?? 0) / maxSigma);
                return (
                  <td key={l}>
                    <div
                      className="heatcell"
                      style={{ background: `rgba(229, 72, 77, ${(0.08 + 0.5 * heat).toFixed(2)})` }}
                      title={`bias ${c.bias ?? '—'}°C · σ ${c.sigma ?? '—'}°C · n ${c.n} · weight ${c.weight ?? '—'}`}
                    >
                      {c.bias === null ? '—' : c.bias.toFixed(2)} / {c.sigma === null ? '—' : c.sigma.toFixed(2)}
                      <span className="muted"> ·{c.n}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">cell = bias°C / σ°C · n residuals; tint ∝ σ</p>
    </div>
  );
}
