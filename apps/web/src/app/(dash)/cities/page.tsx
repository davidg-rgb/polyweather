/**
 * /cities — THE CITIES PREDICTION TABLE (UI-POLISH-HANDOFF.md WS-B, operator-requested 2026-07-17):
 * one clean table over every available city — our prediction for each ACTIVE market day, what the market
 * charges for it, time to close, and the city's historic success rate. "Our prediction" is EXACTLY the
 * buy-table selector's pick (argmax houseProb over the latest capture's identity-complete ladder), so this
 * page can never disagree with what the live lane would buy.
 *
 * Composes ONE RPC (dash_city_predictions, 0106). The heavy half (per-city success rates over every graded
 * capture-stream event) is folded at grading-write time into city_prediction_grades (the 0100 trigger-fold
 * idiom) — this page's read is O(open markets + 45 stat rows), never a capture scan. Read-only analytics;
 * the trading rail stays under its interlock.
 */
import type { ReactElement } from 'react';
import { wilsonInterval } from '@weather-edge/core';
import { CitiesTable, SMALL_N_FLOOR, rateColor, type CitiesTableRow } from '../../../components/CitiesTable.tsx';
import { fmtAgo, fmtDate, fmtDateTime, num } from '../../../lib/format.ts';
import { polymarketEventUrl } from '../../../lib/market-link.ts';
import { getCityPredictions, type CityPredictionStat } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

const MS_PER_DAY = 86_400_000;

/** Whole-day offset of a station-local YYYY-MM-DD vs the render instant's UTC date. */
function dayOffsetUtc(targetDate: string, nowMs: number): number {
  const target = Date.parse(`${targetDate}T00:00:00Z`);
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(target) || !Number.isFinite(today)) return 99;
  return Math.round((target - today) / MS_PER_DAY);
}

const pct0 = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

export default async function CitiesPage(): Promise<ReactElement> {
  const view = await getCityPredictions(await serverDb());

  if (!view) {
    return (
      <div className="ams-dash">
        <h1>Cities — prediction table</h1>
        <div className="info-banner" style={{ borderLeftColor: 'var(--ams-amber)' }}>
          <strong style={{ color: 'var(--ams-amber)' }}>No data.</strong> The{' '}
          <span className="mono">dash_city_predictions()</span> RPC is not applied yet (migration{' '}
          <span className="mono">0106_city_predictions.sql</span>) or is temporarily unavailable. The page
          lights up the moment the operator applies 0106 — the migration also backfills the per-city success
          rates from the existing capture archive, so it arrives populated, not empty.
        </div>
      </div>
    );
  }

  const nowMs = Date.now();
  const leadMinH = num(view.config?.leadMinH) ?? 2;
  const leadMaxH = num(view.config?.leadMaxH) ?? 12;

  const statByCity = new Map<string, CityPredictionStat>(view.stats.map((s) => [s.city, s]));

  // The table rows: server-derived, display-ready, serializable (the client component only filters/sorts).
  const rows: CitiesTableRow[] = view.rows.map((r) => {
    const stat = statByCity.get(r.city);
    const resolvesMs = r.resolvesAt ? Date.parse(r.resolvesAt) : NaN;
    const capturedMs = r.capturedAt ? Date.parse(r.capturedAt) : NaN;
    const hoursToClose = Number.isFinite(resolvesMs) ? (resolvesMs - nowMs) / 3_600_000 : null;
    const n = num(stat?.n) ?? 0;
    const hits = num(stat?.hits) ?? 0;
    const rate = num(stat?.rate);
    const ask = num(r.ask);
    // The CONSERVATIVE upside per $1: the Wilson-95% lower bound of the city's success rate against the
    // live ask (the entry-watch idiom — rank by the lower bound, never the point estimate, so a thin
    // record's wide interval sinks its number instead of letting a cheap ask masquerade as edge).
    const pLb = n > 0 ? wilsonInterval(hits, n).lo : null;
    return {
      city: r.city,
      displayName: r.displayName,
      marketUrl: polymarketEventUrl(r.slug, r.city, r.targetDate),
      targetDate: r.targetDate,
      dayOffset: dayOffsetUtc(r.targetDate, nowMs),
      hoursToClose,
      captureAgeMin: Number.isFinite(capturedMs) ? (nowMs - capturedMs) / 60_000 : null,
      predLabel: r.predLabel,
      predProb: num(r.predProb),
      ask,
      rate,
      n,
      pLb,
      evLb: pLb !== null && ask !== null && ask > 0 ? pLb / ask - 1 : null,
      evPoint: rate !== null && ask !== null && ask > 0 ? rate / ask - 1 : null,
      inWindow: hoursToClose !== null && hoursToClose >= leadMinH && hoursToClose <= leadMaxH,
    };
  });
  // Default sort: time to close ascending — actionable first (rows without a clock sink to the bottom).
  rows.sort((a, b) => (a.hoursToClose ?? Infinity) - (b.hoursToClose ?? Infinity));

  // "All available cities" is literal: cities with graded history but NO open market right now.
  const openCities = new Set(rows.map((r) => r.city));
  const idle = view.stats.filter((s) => !openCities.has(s.city));

  // Headline tiles.
  const inWindow = rows.filter((r) => r.inWindow).length;
  const pooledN = view.stats.reduce((acc, s) => acc + (num(s.n) ?? 0), 0);
  const pooledHits = view.stats.reduce((acc, s) => acc + (num(s.hits) ?? 0), 0);
  const ranked = view.stats
    .map((s) => ({ ...s, rateN: num(s.rate), nN: num(s.n) ?? 0 }))
    .filter((s) => s.rateN !== null && s.nN >= SMALL_N_FLOOR)
    .sort((a, b) => (b.rateN ?? 0) - (a.rateN ?? 0));
  const bestCity = ranked[0] ?? null;

  return (
    <div className="ams-dash">
      <h1>
        Cities — prediction table <span className="chip blue">{rows.length} open markets</span>{' '}
        <span className="chip soft">{view.stats.length} cities tracked</span>
      </h1>
      <p className="muted small">
        Every open city-day market with <strong>our prediction</strong> — the highest-probability bucket of
        the calibrated house forecast on the latest capture (exactly the pick the live buy lane would trade)
        — the market&apos;s current ask for that bucket, <strong>time to close</strong>, and the city&apos;s{' '}
        <strong>historic success rate</strong> (how often that same last-look pick matched the resolved
        winner, over every graded capture-stream market — accruing daily; the 0106 backfill starts
        2026-07-05, where the capture retention window began). Read-only analytics.
        {view.generatedAt ? (
          <>
            {' '}Snapshot <span className="mono">{fmtAgo(view.generatedAt)}</span> (
            <span className="mono">{fmtDateTime(view.generatedAt)}</span>).
          </>
        ) : null}
      </p>

      <div className="strip">
        <div className="tile">
          <div className="cap">Open markets</div>
          <div className="big sky">{rows.length}</div>
          <div className="sub">city-day markets with a live capture</div>
        </div>
        <div className="tile">
          <div className="cap">In buy window</div>
          <div className="big" style={{ color: inWindow > 0 ? 'var(--ams-amber)' : undefined }}>{inWindow}</div>
          <div className="sub">
            {leadMinH}–{leadMaxH}h to close — the live lane&apos;s entry window
          </div>
        </div>
        <div className="tile">
          <div className="cap">Pooled success rate</div>
          <div className="big">{pooledN > 0 ? pct0(pooledHits / pooledN) : '—'}</div>
          <div className="sub">last-look pick = resolved winner · n={pooledN} graded</div>
        </div>
        <div className="tile">
          <div className="cap">Best city</div>
          <div className="big" style={{ fontSize: '1.3rem', color: 'var(--ams-tertiary)' }}>
            {bestCity?.displayName ?? '—'}
          </div>
          <div className="sub">
            {bestCity ? `${pct0(bestCity.rateN)} (n=${bestCity.nN})` : `no city at n≥${SMALL_N_FLOOR} yet`}
          </div>
        </div>
      </div>

      <h2>Open markets</h2>
      <CitiesTable rows={rows} leadMinH={leadMinH} leadMaxH={leadMaxH} />

      {idle.length > 0 ? (
        <>
          <h2>No open market right now</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Cities in the capture universe with graded history but no open market at this snapshot — fresh
            daily markets usually list ~00:00–10:00Z and appear above automatically.
          </p>
          <div className="panel">
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>city</th>
                    <th className="num">historic success</th>
                    <th className="num">last graded day</th>
                  </tr>
                </thead>
                <tbody>
                  {idle.map((s) => {
                    const rate = num(s.rate);
                    const n = num(s.n) ?? 0;
                    return (
                      <tr key={s.city}>
                        <td>
                          {s.displayName} <span className="muted small mono">{s.city}</span>
                        </td>
                        <td className="num">
                          <span style={{ color: rateColor(rate, n), fontWeight: 600 }}>{pct0(rate)}</span>{' '}
                          <span className="muted small">(n={n})</span>
                        </td>
                        <td className="num mono small">{s.lastGradedDate ? fmtDate(s.lastGradedDate) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      <h2>How to read this</h2>
      <div className="panel">
        <ul style={{ margin: 0, paddingLeft: '1.1rem', lineHeight: 1.7 }}>
          <li className="small">
            <strong>Success rate = last-look bucket-win rate.</strong> Per city, over ALL graded capture-stream
            markets: the argmax-houseProb bucket of the event&apos;s <em>last pre-resolution</em> capture,
            compared to the market&apos;s resolved winning bucket. Grading mismatches and unseeded captures are
            excluded; rates under n={SMALL_N_FLOOR} render grey because a small-sample percentage is noise, not
            signal.
          </li>
          <li className="small">
            <strong>This is NOT /data&apos;s accuracy number.</strong> <a href="/data">/data</a> scores the
            champion&apos;s whole-degree call against the resolved high at fixed forecast leads (°C-accuracy);
            this page scores the capture stream&apos;s final pre-close pick against the market&apos;s winning
            bucket (bucket-win). Related questions, different frames — the numbers won&apos;t match exactly.
          </li>
          <li className="small">
            <strong>Highlighted rows sit inside the live lane&apos;s entry window</strong> ([{leadMinH},{' '}
            {leadMaxH}]h to close, read live from <span className="mono">buy_table.*</span> config). The ask
            column is what a taker pays for our pick right now — context, not a recommendation; the measured
            record of buying this pick cheap is a KILL (<span className="mono">BUY-TABLE.md</span>).
          </li>
          <li className="small">
            <strong>Upside /$1 is deliberately conservative.</strong> It is the expected return per $1 staked
            on our pick at the current ask <em>if the city&apos;s true win rate sits at the Wilson-95% lower
            bound of its record</em> — the entry-watch lesson: rank by the lower bound, never the point
            estimate. A thin record widens the interval and sinks the number, so a cheap ask on n=3 cannot
            masquerade as edge (that illusion is exactly how the ≤15¢ gate failed). Hover a cell for the
            decomposition. It is a context metric, not a trade signal — all twelve tested signals are dead
            (<span className="mono">FINDINGS.md</span>), and the graded rate measures the <em>last pre-close</em>{' '}
            pick, while a row you see mid-life may still change its pick before close.
          </li>
        </ul>
      </div>
    </div>
  );
}
