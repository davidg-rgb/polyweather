/**
 * /system — job health (§6.21 getSystemHealth): run matrix, 24h failures,
 * recent alerts, the §6.14 forecast gap matrix (missing cells), and storage
 * gauges.
 */
import type { ReactElement } from 'react';
import { fmtAgo, fmtDate, fmtDateTime, num } from '../../../lib/format.ts';
import { getSystemHealth } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function SystemPage(): Promise<ReactElement> {
  const v = await getSystemHealth(await serverDb());
  return (
    <div>
      <h1>System</h1>

      <div className="grid cols-3">
        <div className="panel stat">
          <span className="label">forecast rows</span>
          <span className="value">{(num(v.storage.forecastRows) ?? 0).toLocaleString('en-US')}</span>
        </div>
        <div className="panel stat">
          <span className="label">market snapshots</span>
          <span className="value">{(num(v.storage.snapshotRows) ?? 0).toLocaleString('en-US')}</span>
        </div>
        <div className="panel stat">
          <span className="label">distribution rows</span>
          <span className="value">{(num(v.storage.probRows) ?? 0).toLocaleString('en-US')}</span>
        </div>
      </div>

      {v.failures24h.length > 0 ? (
        <div className="drift-banner">
          ⚠ failures in the last 24h:{' '}
          {v.failures24h.map((f) => (
            <span key={f.job} className="mono" style={{ marginRight: 10 }}>
              {f.job} ×{num(f.failed) ?? '?'}
            </span>
          ))}
        </div>
      ) : null}

      <h2>Recent job runs</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>job</th>
              <th>period</th>
              <th>status</th>
              <th className="num">attempt</th>
              <th>started</th>
              <th className="num">ms</th>
              <th>error / stats</th>
            </tr>
          </thead>
          <tbody>
            {v.jobRuns.map((r, i) => (
              <tr key={i}>
                <td className="mono">{r.job}</td>
                <td className="mono small">{r.periodKey}</td>
                <td>
                  <span className={`chip ${r.status === 'ok' ? 'green' : r.status === 'failed' ? 'red' : 'blue'}`}>{r.status}</span>
                </td>
                <td className="num">{r.attempt}</td>
                <td className="small" title={fmtDateTime(r.startedAt)}>{fmtAgo(r.startedAt)}</td>
                <td className="num">{num(r.durationMs) ?? '—'}</td>
                <td className="small">
                  {r.error ? (
                    <span className="neg">{r.error}</span>
                  ) : r.stats ? (
                    <details className="audit">
                      <summary>stats</summary>
                      <pre>{JSON.stringify(r.stats, null, 2)}</pre>
                    </details>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent alerts</h2>
      <div className="panel">
        {v.alertsRecent.length === 0 ? (
          <p className="muted">No alerts.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>severity</th>
                <th>kind</th>
                <th>title</th>
                <th>sent</th>
              </tr>
            </thead>
            <tbody>
              {v.alertsRecent.map((a, i) => (
                <tr key={i}>
                  <td className="small">{fmtAgo(a.at)}</td>
                  <td>
                    <span className={`chip ${a.severity === 'CRITICAL' ? 'red' : a.severity === 'WARN' ? 'amber' : a.severity === 'ACTION' ? 'blue' : ''}`}>
                      {a.severity}
                    </span>
                  </td>
                  <td className="mono small">{a.kind}</td>
                  <td>{a.title}</td>
                  <td>{a.sent ? '✓' : <span className="neg">unsent</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Forecast gaps (expected vs present, 7 days)</h2>
      <div className="panel">
        {v.dataGaps.length === 0 ? (
          <p className="form-ok">No missing (station × model × day) cells.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>station</th>
                <th>model</th>
                <th>target date</th>
              </tr>
            </thead>
            <tbody>
              {v.dataGaps.map((g, i) => (
                <tr key={i}>
                  <td className="mono">{g.icao}</td>
                  <td className="mono">{g.model}</td>
                  <td>{fmtDate(g.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
