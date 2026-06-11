/**
 * Intraday observed running max (§5, ADR-17 display): today's METAR-replica
 * max so far — the physical floor under every "or below" bucket. Server
 * component.
 */
import type { ReactElement } from 'react';
import { fmtAgo, fmtTemp, num } from '../lib/format.ts';

export function RunningMaxBadge({
  runningMax,
  unit,
}: {
  runningMax: { maxNative: unknown; nObs: unknown; lastObsAt: string } | null;
  unit: string;
}): ReactElement {
  if (!runningMax || num(runningMax.maxNative) === null) {
    return <span className="chip">no intraday obs yet</span>;
  }
  return (
    <span
      className="chip amber"
      title={`${num(runningMax.nObs) ?? 0} METAR obs · last ${fmtAgo(runningMax.lastObsAt)}`}
    >
      observed max so far: {fmtTemp(runningMax.maxNative, unit)} ({num(runningMax.nObs) ?? 0} obs)
    </span>
  );
}
