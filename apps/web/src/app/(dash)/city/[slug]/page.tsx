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
import { fmtDate, fmtDelta, fmtProb, fmtTemp, fmtUsd, num } from '../../../../lib/format.ts';
import { getCityDetail, getStationObservations, getStationPredictions } from '../../../../lib/loaders.ts';
import { shapeHeatmap } from '../../../../lib/shapers.ts';
import { serverDb } from '../../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function CityPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    obsFrom?: string;
    obsTo?: string;
    obsLimit?: string;
    predFrom?: string;
    predTo?: string;
    predLimit?: string;
  }>;
}): Promise<ReactElement> {
  const { slug } = await params;
  const sp = await searchParams;
  const db = await serverDb();
  const [view, obs, pred] = await Promise.all([
    getCityDetail(db, slug),
    getStationObservations(db, slug, {
      from: sp.obsFrom || undefined,
      to: sp.obsTo || undefined,
      limit: sp.obsLimit ? Number(sp.obsLimit) : undefined,
    }),
    getStationPredictions(db, slug, {
      from: sp.predFrom || undefined,
      to: sp.predTo || undefined,
      limit: sp.predLimit ? Number(sp.predLimit) : undefined,
    }),
  ]);
  if (!view) notFound();
  const { city, openEvent } = view;

  // Forecast error → at-a-glance accuracy class: on-target green, way-off red.
  const errClass = (v: unknown): string => {
    const n = num(v);
    if (n === null) return '';
    const a = Math.abs(n);
    return a <= 1.5 ? 'pos' : a >= 3 ? 'neg' : '';
  };
  const skillRows = pred
    ? [
        { lead: '+1d', s: pred.summary.lead1 },
        { lead: '+2d', s: pred.summary.lead2 },
        { lead: '+3d', s: pred.summary.lead3 },
      ]
    : [];

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
              modelPending={!openEvent.detail.houseDist && !!openEvent.detail.consensusDist}
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

      <h2>Observations — daily Tmax collected</h2>
      <div className="panel">
        {!obs ? (
          <p className="muted">No collected observations available for this city yet.</p>
        ) : (
          <>
            <p className="muted small">
              station <span className="mono">{obs.icao}</span> · {num(obs.summary.n) ?? 0} date(s) collected
              {obs.summary.firstDate ? (
                <>
                  {' '}· {fmtDate(obs.summary.firstDate)} → {fmtDate(obs.summary.lastDate)}
                </>
              ) : null}
              {' '}· WU {num(obs.summary.wu) ?? 0} / IEM {num(obs.summary.iem) ?? 0} ·{' '}
              {num(obs.summary.flagged) ?? 0} flagged · {num(obs.summary.finalized) ?? 0} finalized
            </p>
            <form method="get" className="form-row" style={{ margin: '8px 0 12px' }}>
              <label className="small muted">
                from{' '}
                <input type="date" name="obsFrom" defaultValue={fmtDate(obs.window.from)} />
              </label>
              <label className="small muted">
                to <input type="date" name="obsTo" defaultValue={fmtDate(obs.window.to)} />
              </label>
              <label className="small muted">
                limit{' '}
                <input
                  type="number"
                  name="obsLimit"
                  min={1}
                  max={400}
                  defaultValue={String(num(obs.window.limit) ?? 120)}
                  style={{ width: 72 }}
                />
              </label>
              <button type="submit">view range</button>
            </form>
            {obs.rows.length === 0 ? (
              <p className="muted">No observations collected in this date range.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>date</th>
                    <th className="num">Tmax</th>
                    <th className="num">n obs</th>
                    <th>source</th>
                    <th className="num">METAR</th>
                    <th className="num">IEM °F</th>
                    <th className="num">ERA5 °C</th>
                    <th>flags</th>
                  </tr>
                </thead>
                <tbody>
                  {obs.rows.map((o) => (
                    <tr key={o.date}>
                      <td>
                        {fmtDate(o.date)}
                        {o.finalized ? null : (
                          <span className="chip amber small" style={{ marginLeft: 6 }}>prov</span>
                        )}
                      </td>
                      <td className="num">{fmtTemp(o.tmaxNative, o.unit)}</td>
                      <td className="num">{num(o.nObs) ?? '—'}</td>
                      <td className="small">
                        {o.provenance === 'iem_fallback' ? (
                          <span className="chip amber">iem</span>
                        ) : o.provenance === 'wu' ? (
                          <span className="mono">wu</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">{fmtTemp(o.metarNative, o.unit)}</td>
                      <td className="num">{num(o.iemF) ?? '—'}</td>
                      <td className="num">{num(o.era5C) ?? '—'}</td>
                      <td>
                        {o.flags.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          o.flags.map((f) => (
                            <span key={f} className="chip amber" style={{ marginRight: 4 }}>{f}</span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <h2>Forecast vs actual — daily Tmax (°C)</h2>
      <div className="panel">
        {!pred ? (
          <p className="muted">No prediction-vs-actual data available for this city yet.</p>
        ) : (
          <>
            <p className="muted small">
              station <span className="mono">{pred.icao}</span> ·{' '}
              {num(pred.summary.withForecast) ?? 0} / {num(pred.summary.n) ?? 0} finalized date(s) have a
              forecast
              {pred.summary.firstDate ? (
                <>
                  {' '}· {fmtDate(pred.summary.firstDate)} → {fmtDate(pred.summary.lastDate)}
                </>
              ) : null}{' '}
              · cross-model mean vs recorded actual, error = actual − forecast
            </p>

            <table style={{ width: 'auto', margin: '8px 0 12px' }}>
              <thead>
                <tr>
                  <th>lead</th>
                  <th className="num">MAE °C</th>
                  <th className="num">bias °C</th>
                  <th className="num">n</th>
                </tr>
              </thead>
              <tbody>
                {skillRows.map(({ lead, s }) => (
                  <tr key={lead}>
                    <td className="mono">{lead}</td>
                    <td className={`num ${errClass(s.mae)}`}>
                      {num(s.mae) === null ? '—' : num(s.mae)!.toFixed(2)}
                    </td>
                    <td className="num">{fmtDelta(s.bias, 2)}</td>
                    <td className="num">{num(s.n) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <form method="get" className="form-row" style={{ margin: '8px 0 12px' }}>
              <label className="small muted">
                from <input type="date" name="predFrom" defaultValue={fmtDate(pred.window.from)} />
              </label>
              <label className="small muted">
                to <input type="date" name="predTo" defaultValue={fmtDate(pred.window.to)} />
              </label>
              <label className="small muted">
                limit{' '}
                <input
                  type="number"
                  name="predLimit"
                  min={1}
                  max={400}
                  defaultValue={String(num(pred.window.limit) ?? 120)}
                  style={{ width: 72 }}
                />
              </label>
              <button type="submit">view range</button>
            </form>

            {pred.rows.length === 0 ? (
              <p className="muted">No finalized prediction-vs-actual pairs in this date range.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>date</th>
                    <th className="num">actual</th>
                    <th className="num">fc +1d</th>
                    <th className="num">Δ+1</th>
                    <th className="num">fc +2d</th>
                    <th className="num">Δ+2</th>
                    <th className="num">fc +3d</th>
                    <th className="num">Δ+3</th>
                    <th className="num">models</th>
                  </tr>
                </thead>
                <tbody>
                  {pred.rows.map((p) => (
                    <tr key={p.date}>
                      <td>{fmtDate(p.date)}</td>
                      <td className="num">{fmtTemp(p.actualC, 'C')}</td>
                      <td className="num">{fmtTemp(p.fcPlus1C, 'C')}</td>
                      <td className={`num ${errClass(p.errPlus1)}`}>{fmtDelta(p.errPlus1)}</td>
                      <td className="num">{fmtTemp(p.fcPlus2C, 'C')}</td>
                      <td className={`num ${errClass(p.errPlus2)}`}>{fmtDelta(p.errPlus2)}</td>
                      <td className="num">{fmtTemp(p.fcPlus3C, 'C')}</td>
                      <td className={`num ${errClass(p.errPlus3)}`}>{fmtDelta(p.errPlus3)}</td>
                      <td className="num">{num(p.nModels) ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
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
