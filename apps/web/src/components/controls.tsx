'use client';
/**
 * Operator control widgets (§6.21) — every mutating flow on /admin,
 * /calibration and /city, each a thin client form over its §8.2 route.
 * Errors are rendered verbatim (the routes return the full damage report).
 */
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { errText, postJson } from './post.ts';

function useAction(): {
  busy: boolean;
  msg: string | null;
  ok: boolean;
  run: (fn: () => Promise<{ ok: boolean; msg: string }>) => Promise<void>;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; msg: string }>): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setOk(r.ok);
      setMsg(r.msg);
      if (r.ok) router.refresh();
    } catch (e) {
      setOk(false);
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, ok, run };
}

const Status = ({ msg, ok }: { msg: string | null; ok: boolean }): ReactElement | null =>
  msg ? <span className={ok ? 'form-ok' : 'form-error'}>{msg}</span> : null;

// --- halt / resume (typed confirmation) ---------------------------------------

export function HaltForm(): ReactElement {
  const a = useAction();
  const [scope, setScope] = useState<'global' | 'city' | 'city_lead'>('global');
  const [city, setCity] = useState('');
  const [lead, setLead] = useState('0');
  const [reason, setReason] = useState('');
  return (
    <div>
      <div className="form-row">
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="global">global</option>
          <option value="city">city</option>
          <option value="city_lead">city_lead</option>
        </select>
        {scope !== 'global' ? (
          <input placeholder="city slug" value={city} onChange={(e) => setCity(e.target.value)} />
        ) : null}
        {scope === 'city_lead' ? (
          <input style={{ width: 64 }} placeholder="lead" value={lead} onChange={(e) => setLead(e.target.value)} />
        ) : null}
        <input placeholder="reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button
          className="danger"
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              const body: Record<string, unknown> = { scope, reason };
              if (scope !== 'global') body['city'] = city;
              if (scope === 'city_lead') body['lead'] = Number(lead);
              const r = await postJson('/api/admin/halt', body);
              return r.status === 200
                ? { ok: true, msg: `halted: ${String(r.body['haltKey'])}` }
                : { ok: false, msg: errText(r) };
            })
          }
        >
          HALT
        </button>
        <Status msg={a.msg} ok={a.ok} />
      </div>
    </div>
  );
}

export function ResumeForm({ haltKey }: { haltKey: string }): ReactElement {
  const a = useAction();
  const [confirm, setConfirm] = useState('');
  return (
    <span className="form-row">
      <input
        placeholder={`type "${haltKey}" to confirm`}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        style={{ width: 260 }}
      />
      <button
        disabled={a.busy || confirm !== haltKey}
        onClick={() =>
          void a.run(async () => {
            const r = await postJson('/api/admin/resume', { haltKey, confirm });
            return r.status === 200 ? { ok: true, msg: 'resumed' } : { ok: false, msg: errText(r) };
          })
        }
      >
        resume
      </button>
      <Status msg={a.msg} ok={a.ok} />
    </span>
  );
}

// --- config editor --------------------------------------------------------------

export function ConfigEditor({ rows }: { rows: { key: string; value: string }[] }): ReactElement {
  const a = useAction();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const changed = Object.entries(edits).filter(([k, v]) => v !== rows.find((r) => r.key === k)?.value);
  return (
    <div>
      <table>
        <thead>
          <tr>
            <th>key</th>
            <th>value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="mono">{r.key}</td>
              <td>
                <input
                  className="mono"
                  style={{ width: '100%' }}
                  value={edits[r.key] ?? r.value}
                  disabled={r.value.includes('redacted')}
                  onChange={(e) => setEdits((p) => ({ ...p, [r.key]: e.target.value }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row">
        <button
          className="primary"
          disabled={a.busy || changed.length === 0}
          onClick={() =>
            void a.run(async () => {
              const r = await postJson('/api/admin/config', {
                changes: changed.map(([key, value]) => ({ key, value })),
              });
              if (r.status === 200) {
                setEdits({});
                return { ok: true, msg: `applied ${String(r.body['applied'])} change(s)` };
              }
              return { ok: false, msg: errText(r) };
            })
          }
        >
          apply {changed.length} change(s)
        </button>
        <Status msg={a.msg} ok={a.ok} />
      </div>
    </div>
  );
}

// --- station verification ----------------------------------------------------------

export function VerifyStationButton({ cityStationId, icao }: { cityStationId: string; icao: string }): ReactElement {
  const a = useAction();
  return (
    <span className="form-row">
      <button
        disabled={a.busy}
        title="confirm coordinates/ICAO against the live market description first"
        onClick={() =>
          void a.run(async () => {
            const r = await postJson('/api/admin/verify-station', { cityStationId });
            return r.status === 200 ? { ok: true, msg: `${icao} verified` } : { ok: false, msg: errText(r) };
          })
        }
      >
        verify {icao}
      </button>
      <Status msg={a.msg} ok={a.ok} />
    </span>
  );
}

// --- manual job triggers --------------------------------------------------------------

const JOBS = [
  'discover-markets', 'snapshot-forecasts', 'snapshot-ensembles', 'fetch-actuals',
  'metar-nowcast', 'build-distributions', 'poll-markets', 'run-calibration',
  'grade-bets', 'daily-digest', 'health-monitor',
] as const;

export function TriggerJobs(): ReactElement {
  const a = useAction();
  return (
    <div>
      <div className="form-row">
        {JOBS.map((job) => (
          <button
            key={job}
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                const r = await postJson('/api/admin/trigger-job', { job });
                return r.status === 200
                  ? { ok: true, msg: `${job} accepted (${String(r.body['periodKey'])})` }
                  : { ok: false, msg: `${job}: ${errText(r)}` };
              })
            }
          >
            {job}
          </button>
        ))}
      </div>
      <Status msg={a.msg} ok={a.ok} />
    </div>
  );
}

// --- champion promotion (F-019, /calibration) ------------------------------------------

export function PromoteButton({ source }: { source: string }): ReactElement {
  const a = useAction();
  return (
    <span className="form-row">
      <button
        disabled={a.busy}
        onClick={() =>
          void a.run(async () => {
            const r = await postJson('/api/admin/promote-source', { source });
            return r.status === 200
              ? { ok: true, msg: `champion → ${source}` }
              : { ok: false, msg: errText(r) };
          })
        }
      >
        promote {source}
      </button>
      <Status msg={a.msg} ok={a.ok} />
    </span>
  );
}

// --- manual bet (F-035) -----------------------------------------------------------------

export function ManualBetForm(): ReactElement {
  const a = useAction();
  const [f, setF] = useState({
    eventSlug: '', bucketLabel: '', side: 'YES', shares: '', price: '', mode: 'paper', executedExternally: false,
  });
  const set = (k: keyof typeof f, v: string | boolean): void => setF((p) => ({ ...p, [k]: v }));
  return (
    <div>
      <div className="form-row">
        <input placeholder="event slug" value={f.eventSlug} onChange={(e) => set('eventSlug', e.target.value)} />
        <input placeholder="bucket label (e.g. 22°C)" value={f.bucketLabel} onChange={(e) => set('bucketLabel', e.target.value)} />
        <select value={f.side} onChange={(e) => set('side', e.target.value)}>
          <option>YES</option>
          <option>NO</option>
        </select>
        <input style={{ width: 80 }} placeholder="shares" value={f.shares} onChange={(e) => set('shares', e.target.value)} />
        <input style={{ width: 80 }} placeholder="price" value={f.price} onChange={(e) => set('price', e.target.value)} />
        <select value={f.mode} onChange={(e) => set('mode', e.target.value)}>
          <option value="paper">paper</option>
          <option value="live">live</option>
        </select>
        <label className="small muted">
          <input
            type="checkbox"
            checked={f.executedExternally}
            onChange={(e) => set('executedExternally', e.target.checked)}
          />{' '}
          executed externally (record verbatim)
        </label>
        <button
          className="primary"
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              const r = await postJson('/api/admin/manual-bet', {
                eventSlug: f.eventSlug,
                bucketLabel: f.bucketLabel,
                side: f.side,
                shares: Number(f.shares),
                price: Number(f.price),
                mode: f.mode,
                executedExternally: f.executedExternally,
              });
              return r.status === 200
                ? { ok: true, msg: `bet ${String(r.body['betId'])} recorded` }
                : { ok: false, msg: errText(r) };
            })
          }
        >
          place manual bet
        </button>
      </div>
      <Status msg={a.msg} ok={a.ok} />
    </div>
  );
}

// --- K4 CSV export (R-16) ------------------------------------------------------------------

export function ExportForm(): ReactElement {
  const [f, setF] = useState({ from: '', to: '', mode: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { from: f.from, to: f.to };
      if (f.mode) body['mode'] = f.mode;
      const res = await fetch('/api/admin/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status !== 200) {
        const r = { status: res.status, body: (await res.json()) as Record<string, unknown> };
        setMsg(errText(r));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement('a');
      aEl.href = url;
      aEl.download = `weather-edge-export-${f.from}_${f.to}.csv`;
      aEl.click();
      URL.revokeObjectURL(url);
      setMsg('downloaded');
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-row">
      <input style={{ width: 120 }} placeholder="from YYYY-MM-DD" value={f.from} onChange={(e) => setF((p) => ({ ...p, from: e.target.value }))} />
      <input style={{ width: 120 }} placeholder="to YYYY-MM-DD" value={f.to} onChange={(e) => setF((p) => ({ ...p, to: e.target.value }))} />
      <select value={f.mode} onChange={(e) => setF((p) => ({ ...p, mode: e.target.value }))}>
        <option value="">both modes</option>
        <option value="paper">paper</option>
        <option value="live">live</option>
      </select>
      <button disabled={busy || !f.from || !f.to} onClick={() => void download()}>
        export CSV (K4)
      </button>
      {msg ? <span className={msg === 'downloaded' ? 'form-ok' : 'form-error'}>{msg}</span> : null}
    </div>
  );
}
