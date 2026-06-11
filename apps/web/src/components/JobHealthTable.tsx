/**
 * Job health (§5): last-ok freshness per job against the §6.19 W7 staleness
 * matrix thresholds — red when a job is past its limit (the same numbers
 * health-monitor alerts on; display only here). Server component.
 */
import type { ReactElement } from 'react';
import { fmtAgo } from '../lib/format.ts';

/** §6.19 W7 staleness limits, minutes (display twin of health-monitor's). */
const STALE_LIMIT_MIN: Record<string, number> = {
  'poll-markets': 15,
  'metar-nowcast': 45,
  'fetch-actuals': 120,
  'snapshot-forecasts': 840,
  'snapshot-ensembles': 840,
  'build-distributions': 840,
  'run-calibration': 1560,
  'discover-markets': 600,
};

export function JobHealthTable({
  jobs,
  now = new Date(),
}: {
  jobs: { job: string; lastOk: string | null; running: string | null }[];
  now?: Date;
}): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          <th>job</th>
          <th>last ok</th>
          <th>state</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const limit = STALE_LIMIT_MIN[j.job];
          const ageMin = j.lastOk ? (now.getTime() - new Date(j.lastOk).getTime()) / 60_000 : Infinity;
          const stale = limit !== undefined && ageMin > limit;
          return (
            <tr key={j.job}>
              <td className="mono">{j.job}</td>
              <td className={stale ? 'neg' : undefined}>{fmtAgo(j.lastOk, now)}</td>
              <td>
                {j.running ? (
                  <span className="chip blue">running</span>
                ) : stale ? (
                  <span className="chip red">stale</span>
                ) : j.lastOk ? (
                  <span className="chip green">ok</span>
                ) : (
                  <span className="chip">never ran</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
