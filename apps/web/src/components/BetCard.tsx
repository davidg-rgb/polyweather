'use client';
/**
 * Recommendation card (§5): the full Kelly math chain (q vs exec ask → raw
 * Kelly → fraction → caps → stake/shares), the complete audit object behind
 * <details> (§15 audit visibility), and approve/skip wired to the §8.2
 * routes — approve relays execute-bet's verdict verbatim (200 fill / 409 /
 * 422 / 503 gate reasons).
 */
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { errText, postJson } from './post.ts';
import { fmtPct, fmtProb, fmtUsd, num } from '../lib/format.ts';
import type { OpenRec } from '../lib/loaders.ts';

export function BetCard({ rec }: { rec: OpenRec }): ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const act = async (action: 'approve' | 'skip'): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const body = action === 'skip' ? { reason: 'operator skip via dashboard' } : {};
      const r = await postJson(`/api/bets/${rec.betId}/${action}`, body);
      if (r.status === 200) {
        setOk(true);
        const fill = r.body['fill'] as { price?: unknown; shares?: unknown } | undefined;
        setMsg(
          action === 'approve'
            ? `filled ${String(fill?.shares ?? '?')} sh @ ${String(fill?.price ?? '?')}`
            : 'skipped',
        );
        router.refresh();
      } else {
        setMsg(errText(r));
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bet-card">
      <div className="head">
        <span className="title">{rec.city} — {rec.label}</span>
        <a href={`/events/${rec.eventSlug}`} className="small">{rec.eventSlug}</a>
        <span className={`chip ${rec.mode === 'paper' ? 'blue' : 'red'}`}>{rec.mode}</span>
      </div>
      <div className="kelly">
        <span>q <b>{fmtProb(rec.q)}</b></span>
        <span>exec ask <b>{fmtProb(rec.execAsk)}</b></span>
        <span>edge <b>{fmtProb(rec.edge)}</b> (min {fmtProb(rec.minEdge)})</span>
        <span>kelly raw <b>{fmtPct(rec.kellyRaw)}</b></span>
        <span>→ frac <b>{fmtPct(rec.kellyFrac)}</b></span>
        <span>→ capped <b>{fmtPct(rec.cappedFrac)}</b></span>
        <span>stake <b>{fmtUsd(rec.stake)}</b></span>
        <span>shares <b>{num(rec.shares) ?? '—'}</b></span>
      </div>
      <details className="audit">
        <summary>full audit object</summary>
        <pre>{JSON.stringify(rec.audit, null, 2)}</pre>
      </details>
      <div className="actions">
        <button className="primary" disabled={busy || ok} onClick={() => void act('approve')}>
          approve → fill
        </button>
        <button disabled={busy || ok} onClick={() => void act('skip')}>
          skip
        </button>
        {msg ? <span className={ok ? 'form-ok' : 'form-error'}>{msg}</span> : null}
      </div>
    </div>
  );
}
