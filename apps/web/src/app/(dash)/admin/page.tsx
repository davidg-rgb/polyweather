/**
 * /admin — halts, config, verification, go-live readout (§6.21
 * getAdminState): the goLiveGate checklist rendered verbatim (§15 9.9 — the
 * wallet-key row carries the §8.3 'checked at execution' caveat because the
 * web tier cannot read Edge Function secrets), halt/resume with typed
 * confirmation, the audited config editor, station verification, manual job
 * triggers, the F-035 manual-bet form, and the K4 CSV export.
 */
import type { ReactElement } from 'react';
import {
  ConfigEditor,
  ExportForm,
  HaltForm,
  ManualBetForm,
  ResumeForm,
  TriggerJobs,
  VerifyStationButton,
} from '../../../components/controls.tsx';
import { fmtAgo, fmtDate } from '../../../lib/format.ts';
import { getAdminState } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function AdminPage(): Promise<ReactElement> {
  const v = await getAdminState(await serverDb());
  return (
    <div>
      <h1>
        Admin{' '}
        <span className={`chip ${v.tradingMode === 'paper' ? 'blue' : 'red'}`}>{v.tradingMode}</span>{' '}
        <span className="chip">champion: {v.championSource}</span>
      </h1>

      <h2>Go-live gate (readout — execute-bet re-runs this authoritatively)</h2>
      <div className="panel">
        {v.goLiveChecklist.error ? (
          <p className="form-error">{v.goLiveChecklist.error}</p>
        ) : v.goLiveChecklist.pass ? (
          <div className="ok-banner">✓ every C5 condition green — live placement would pass the gate.</div>
        ) : (
          <>
            <p className="badge-fail">✗ gate closed — {v.goLiveChecklist.reasons.length} condition(s) failing:</p>
            <table>
              <tbody>
                {v.goLiveChecklist.reasons.map((r, i) => (
                  <tr key={i}>
                    <td className="neg">✗ {r.text}</td>
                    <td className="muted small">
                      {r.webCaveat
                        ? 're-checked from execute-bet’s own secrets at execution time — the web tier cannot read function secrets (§8.3)'
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <h2>Halts</h2>
      <div className="panel">
        {v.halts.length === 0 ? (
          <p className="form-ok">No active halts.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>halt key</th>
                <th>detail</th>
                <th>resume (typed confirmation)</th>
              </tr>
            </thead>
            <tbody>
              {v.halts.map((h) => (
                <tr key={h.key}>
                  <td className="mono neg">{h.key}</td>
                  <td className="small">{h.value}</td>
                  <td>
                    <ResumeForm haltKey={h.key} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>apply a halt</h3>
        <HaltForm />
      </div>

      <h2>Unverified stations</h2>
      <div className="panel">
        {v.unverifiedStations.length === 0 ? (
          <p className="form-ok">All current stations verified.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>city</th>
                <th>icao</th>
                <th>since</th>
                <th>action</th>
              </tr>
            </thead>
            <tbody>
              {v.unverifiedStations.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={`/city/${s.city}`}>{s.city}</a>
                  </td>
                  <td className="mono">{s.icao}</td>
                  <td>{fmtDate(s.validFrom)}</td>
                  <td>
                    <VerifyStationButton cityStationId={s.id} icao={s.icao} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Trigger a job manually</h2>
      <div className="panel">
        <TriggerJobs />
      </div>

      <h2>Manual bet (F-035)</h2>
      <div className="panel">
        <ManualBetForm />
      </div>

      <h2>Export (K4 / Skatteverket, R-16)</h2>
      <div className="panel">
        <ExportForm />
      </div>

      <h2>Config (validated against the schema; every change audited)</h2>
      <div className="panel">
        <ConfigEditor rows={v.config} />
      </div>

      <h2>Config audit (latest 50)</h2>
      <div className="panel">
        {v.audit.length === 0 ? (
          <p className="muted">No config changes yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>key</th>
                <th>old → new</th>
                <th>actor</th>
              </tr>
            </thead>
            <tbody>
              {v.audit.map((a, i) => (
                <tr key={i}>
                  <td className="small">{fmtAgo(a.at)}</td>
                  <td className="mono">{a.key}</td>
                  <td className="mono small">
                    {a.old ?? '∅'} → {a.new ?? '∅'}
                  </td>
                  <td>{a.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
