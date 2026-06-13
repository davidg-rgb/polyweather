/**
 * /events — the analytics landing (WEB-3, ADR-21 default landing). Lists every
 * open market_event with collection-health columns (snapshots / consensus /
 * model built per event), each row linking to /events/[slug] and /city/[slug].
 *
 * The "model?" chip reads live hasHouse: every row shows "pending" until the
 * house build lights up (Phase 2 capture fix + Phase 3 de-gate), then flips to
 * "built" automatically — the headline diagnostic for the analytics pivot.
 *
 * Sibling of events/[slug]/page.tsx — the App Router resolves /events → this
 * page and /events/{slug} → [slug]/page.tsx with no collision.
 */
import type { ReactElement } from 'react';
import { fmtAgo, fmtDate, num } from '../../../lib/format.ts';
import { getEventsList } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function EventsIndexPage(): Promise<ReactElement> {
  const v = await getEventsList(await serverDb());
  const c = v.counts;
  const open = num(c.open) ?? 0;

  return (
    <div>
      <h1>
        Open events <span className="chip blue">{open} open</span>
      </h1>
      <p className="muted small">
        snapshots {num(c.withSnapshot) ?? 0}/{open} · consensus {num(c.withConsensus) ?? 0}/{open} ·{' '}
        model {num(c.withHouse) ?? 0}/{open} · ladders {num(c.withLadder) ?? 0}/{open} · champion{' '}
        <span className="mono">{v.champion}</span>
      </p>

      <div className="panel">
        {v.events.length === 0 ? (
          <p className="muted">No open events right now — discover-markets seeds them.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>city</th>
                <th>target</th>
                <th>status</th>
                <th>ladder</th>
                <th className="num">buckets</th>
                <th>last snapshot</th>
                <th>last consensus</th>
                <th>model?</th>
              </tr>
            </thead>
            <tbody>
              {v.events.map((e) => (
                <tr key={e.slug}>
                  <td>
                    <a href={`/events/${e.slug}`}>{e.city}</a>{' '}
                    <a href={`/city/${e.citySlug}`} className="muted small">
                      city →
                    </a>
                  </td>
                  <td>{fmtDate(e.targetDate)}</td>
                  <td>
                    {e.acceptingOrders ? (
                      <span className="chip green">accepting</span>
                    ) : (
                      <span className="chip amber">not accepting</span>
                    )}
                  </td>
                  <td>
                    {e.ladderOk ? (
                      <span className="chip green">ok</span>
                    ) : (
                      <span className="chip amber">flagged</span>
                    )}
                  </td>
                  <td className="num">{num(e.nBuckets) ?? '—'}</td>
                  <td className="small">{fmtAgo(e.lastSnapshotAt)}</td>
                  <td className="small">{fmtAgo(e.lastConsensusAt)}</td>
                  <td>
                    {e.hasHouse ? (
                      <span className="chip green">built</span>
                    ) : (
                      <span className="chip amber">pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
