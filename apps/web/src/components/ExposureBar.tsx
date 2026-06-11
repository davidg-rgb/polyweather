/**
 * Caps utilization (§5): open exposure vs the §6.8 cap ladder — per event,
 * per cluster, per day — each as a utilization bar against its cap. Server
 * component.
 */
import type { ReactElement } from 'react';
import { fmtUsd } from '../lib/format.ts';
import type { ExposureSlice } from '../lib/loaders.ts';

function Bars({ title, slices, capUsd }: { title: string; slices: ExposureSlice[]; capUsd: number }): ReactElement {
  return (
    <div>
      <h3>{title} <span className="muted small">cap {fmtUsd(capUsd)}</span></h3>
      {slices.length === 0 ? (
        <p className="muted small">no open exposure</p>
      ) : (
        slices.map((s) => {
          const ratio = capUsd > 0 ? s.usd / capUsd : 0;
          const cls = ratio >= 1 ? 'fill over' : ratio >= 0.8 ? 'fill hot' : 'fill';
          return (
            <div key={s.key} className="bar-row">
              <span className="bar-label" title={s.key}>{s.key.length > 14 ? `${s.key.slice(0, 13)}…` : s.key}</span>
              <div className="util" title={`${fmtUsd(s.usd)} of ${fmtUsd(capUsd)} (${(ratio * 100).toFixed(0)}%)`}>
                <div className={cls} style={{ width: `${Math.min(100, ratio * 100).toFixed(1)}%` }} />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export function ExposureBar({
  exposures,
  caps,
}: {
  exposures: { byEvent: ExposureSlice[]; byCluster: ExposureSlice[]; byDay: ExposureSlice[] };
  caps: { perEventCapUsd: number; clusterCapUsd: number; dailyCapUsd: number };
}): ReactElement {
  return (
    <div className="grid cols-3">
      <Bars title="by event" slices={exposures.byEvent} capUsd={caps.perEventCapUsd} />
      <Bars title="by cluster" slices={exposures.byCluster} capUsd={caps.clusterCapUsd} />
      <Bars title="by day" slices={exposures.byDay} capUsd={caps.dailyCapUsd} />
    </div>
  );
}
