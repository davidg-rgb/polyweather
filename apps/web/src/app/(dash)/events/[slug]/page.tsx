/**
 * /events/[slug] — the per-event edge view (§6.21 getEventDetail): ladder +
 * book, house-vs-consensus overlay, EdgeChart with the §15 no-drift
 * recompute, mid spark, and every bet with its FULL audit JSON (§15).
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { DistributionOverlay } from '../../../../components/DistributionOverlay.tsx';
import { EdgeChart } from '../../../../components/EdgeChart.tsx';
import { RunningMaxBadge } from '../../../../components/RunningMaxBadge.tsx';
import { Spark } from '../../../../components/Spark.tsx';
import { fmtDate, fmtDateTime, fmtProb, fmtUsd, num } from '../../../../lib/format.ts';
import { getEventDetail } from '../../../../lib/loaders.ts';
import { serverDb } from '../../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }): Promise<ReactElement> {
  const { slug } = await params;
  const view = await getEventDetail(await serverDb(), slug);
  if (!view) notFound();
  const { detail, comparison, championSource } = view;
  const ev = detail.event;
  const winnerLabel =
    ev.winningBucketIdx !== null ? detail.ladder.find((l) => l.idx === ev.winningBucketIdx)?.label : null;

  return (
    <div>
      <h1>
        {ev.city} — {fmtDate(ev.targetDate)}{' '}
        {ev.closed ? <span className="chip">closed</span> : ev.acceptingOrders ? (
          <span className="chip green">accepting orders</span>
        ) : (
          <span className="chip amber">not accepting</span>
        )}{' '}
        <RunningMaxBadge runningMax={detail.runningMax} unit={ev.unit} />
      </h1>
      <p className="muted small">
        slug <span className="mono">{ev.slug}</span> · tz {ev.tz} · 24h volume {fmtUsd(ev.volume24h, 0)} ·{' '}
        <a href={`/city/${ev.citySlug}`}>city page →</a>
      </p>
      {winnerLabel ? <div className="ok-banner">resolved winner: <b>{winnerLabel}</b></div> : null}
      {!ev.ladderOk ? <div className="drift-banner">⚠ ladder flagged invalid — betting disabled for this event</div> : null}

      <h2>Distributions — {championSource} vs market consensus</h2>
      <div className="panel">
        <DistributionOverlay
          labels={detail.ladder.map((l) => l.label)}
          houseProbs={detail.houseDist?.probs ?? null}
          consensusProbs={detail.consensusDist?.probs ?? null}
          nowcast={detail.houseDist?.nowcast ?? false}
          winningIdx={ev.winningBucketIdx}
        />
        <p className="muted small">
          house: μ {fmtProb(detail.houseDist?.mu)} σ {fmtProb(detail.houseDist?.sigma)} · made{' '}
          {fmtDateTime(detail.houseDist?.madeAt)} (lead {detail.houseDist?.lead ?? '—'}) · consensus made{' '}
          {fmtDateTime(detail.consensusDist?.madeAt)}
        </p>
      </div>

      <h2>Edge — stored engine rows vs display recompute</h2>
      <div className="panel">
        <EdgeChart comparison={comparison} />
      </div>

      <h2>Mid-price history</h2>
      <div className="panel">
        <Spark values={detail.snapshotsSpark.map((s) => num(s.mid) ?? 0)} width={720} height={64} />
        <p className="muted small">{detail.snapshotsSpark.length} snapshots (latest 300)</p>
      </div>

      <h2>Bets on this event</h2>
      <div className="panel">
        {detail.bets.length === 0 ? (
          <p className="muted">No bets recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>bucket</th>
                <th>status</th>
                <th className="num">q</th>
                <th className="num">exec ask</th>
                <th className="num">stake</th>
                <th className="num">shares</th>
                <th className="num">fill</th>
                <th className="num">pnl</th>
                <th>audit (§15: stake derivable from stored values)</th>
              </tr>
            </thead>
            <tbody>
              {detail.bets.map((b) => (
                <tr key={b.betId}>
                  <td className="mono">{b.label}</td>
                  <td>
                    <span className={`chip ${b.status === 'resolved_win' ? 'green' : b.status.startsWith('resolved') ? 'red' : b.status === 'filled' ? 'blue' : ''}`}>
                      {b.status}
                    </span>{' '}
                    <span className="muted small">{b.mode}</span>
                  </td>
                  <td className="num">{fmtProb(b.q)}</td>
                  <td className="num">{fmtProb(b.execAsk)}</td>
                  <td className="num">{fmtUsd(b.stake)}</td>
                  <td className="num">{num(b.shares) ?? '—'}</td>
                  <td className="num">
                    {b.executedPrice !== null ? `${num(b.executedShares) ?? '?'} @ ${fmtProb(b.executedPrice)}` : '—'}
                  </td>
                  <td className={`num ${(num(b.pnl) ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(b.pnl)}</td>
                  <td>
                    <details className="audit">
                      <summary>audit JSON</summary>
                      <pre>{JSON.stringify(b.audit, null, 2)}</pre>
                    </details>
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
