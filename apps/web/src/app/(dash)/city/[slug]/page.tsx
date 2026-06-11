/**
 * /city/[slug] — per-city calibration + history (§6.21 getCityDetail):
 * today's live market with our overlay (§12), station history with the
 * verify flow, the model_stats heatmap, Brier trend, bet history, and the
 * truth divergence log.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { CalibrationHeatmap } from '../../../../components/CalibrationHeatmap.tsx';
import { DistributionOverlay } from '../../../../components/DistributionOverlay.tsx';
import { VerifyStationButton } from '../../../../components/controls.tsx';
import { fmtDate, fmtProb, fmtTemp, fmtUsd, num } from '../../../../lib/format.ts';
import { getCityDetail } from '../../../../lib/loaders.ts';
import { shapeHeatmap } from '../../../../lib/shapers.ts';
import { serverDb } from '../../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function CityPage({ params }: { params: Promise<{ slug: string }> }): Promise<ReactElement> {
  const { slug } = await params;
  const view = await getCityDetail(await serverDb(), slug);
  if (!view) notFound();
  const { city, openEvent } = view;

  return (
    <div>
      <h1>
        {city.city.name}{' '}
        <span className={`chip ${city.city.bettingEnabled ? 'green' : 'amber'}`}>
          {city.city.bettingEnabled ? 'betting enabled' : 'betting disabled'}
        </span>
      </h1>
      <p className="muted small">
        {city.city.tz} · °{city.city.unit} · cluster {city.city.region}
      </p>

      {openEvent ? (
        <>
          <h2>
            Today&apos;s market —{' '}
            <a href={`/events/${openEvent.detail.event.slug}`}>{openEvent.detail.event.slug}</a>
          </h2>
          <div className="panel">
            <DistributionOverlay
              labels={openEvent.detail.ladder.map((l) => l.label)}
              houseProbs={openEvent.detail.houseDist?.probs ?? null}
              consensusProbs={openEvent.detail.consensusDist?.probs ?? null}
              nowcast={openEvent.detail.houseDist?.nowcast ?? false}
              winningIdx={openEvent.detail.event.winningBucketIdx}
            />
          </div>
        </>
      ) : (
        <p className="muted">No open market for this city right now.</p>
      )}

      <h2>Stations</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>icao</th>
              <th>valid from</th>
              <th>valid to</th>
              <th>verified</th>
            </tr>
          </thead>
          <tbody>
            {city.stationHistory.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.icao}</td>
                <td>{fmtDate(s.validFrom)}</td>
                <td>{s.validTo ? fmtDate(s.validTo) : <span className="chip blue">current</span>}</td>
                <td>
                  {s.verified ? (
                    <span className="badge-pass">✓</span>
                  ) : s.validTo === null ? (
                    <VerifyStationButton cityStationId={s.id} icao={s.icao} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Calibration heatmap (model_stats)</h2>
      <div className="panel grid cols-2">
        <CalibrationHeatmap grid={shapeHeatmap(city.calibrationHeatmap, '10Z')} />
        <CalibrationHeatmap grid={shapeHeatmap(city.calibrationHeatmap, '22Z')} />
      </div>

      <h2>Brier trend</h2>
      <div className="panel">
        {city.brierTrend.length === 0 ? (
          <p className="muted">No calibration scores yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>source</th>
                <th className="num">lead</th>
                <th>window</th>
                <th className="num">brier</th>
                <th className="num">market</th>
                <th className="num">ece</th>
                <th className="num">sharpness</th>
                <th className="num">n</th>
              </tr>
            </thead>
            <tbody>
              {city.brierTrend.map((r, i) => {
                const b = num(r.brier);
                const m = num(r.brierMarket);
                const better = b !== null && m !== null && b < m;
                return (
                  <tr key={i}>
                    <td className="mono">{r.source}</td>
                    <td className="num">{r.lead}</td>
                    <td>{r.window}</td>
                    <td className={`num ${better ? 'pos' : ''}`}>{fmtProb(r.brier)}</td>
                    <td className="num">{fmtProb(r.brierMarket)}</td>
                    <td className="num">{fmtProb(r.ece)}</td>
                    <td className="num">{fmtProb(r.sharpness)}</td>
                    <td className="num">{num(r.n) ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <h2>Bet history</h2>
      <div className="panel">
        {city.betHistory.length === 0 ? (
          <p className="muted">No bets yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>event</th>
                <th>bucket</th>
                <th>status</th>
                <th className="num">stake</th>
                <th className="num">pnl</th>
              </tr>
            </thead>
            <tbody>
              {city.betHistory.map((b) => (
                <tr key={b.betId}>
                  <td><a href={`/events/${b.eventSlug}`} className="mono small">{b.eventSlug}</a></td>
                  <td className="mono">{b.label}</td>
                  <td>{b.status}</td>
                  <td className="num">{fmtUsd(b.stake)}</td>
                  <td className={`num ${(num(b.pnl) ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(b.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Truth divergence log</h2>
      <div className="panel">
        {city.divergenceLog.length === 0 ? (
          <p className="muted">No cross-check divergences recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>date</th>
                <th>flags</th>
                <th className="num">WU</th>
                <th className="num">METAR</th>
                <th className="num">IEM °F</th>
              </tr>
            </thead>
            <tbody>
              {city.divergenceLog.map((d, i) => (
                <tr key={i}>
                  <td>{fmtDate(d.date)}</td>
                  <td>
                    {d.flags.map((f) => (
                      <span key={f} className="chip amber" style={{ marginRight: 4 }}>{f}</span>
                    ))}
                  </td>
                  <td className="num">{fmtTemp(d.wu, city.city.unit)}</td>
                  <td className="num">{fmtTemp(d.metar, city.city.unit)}</td>
                  <td className="num">{num(d.iemF) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
