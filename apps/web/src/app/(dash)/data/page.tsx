/**
 * /data — FORECAST ACCURACY BY MARKET. The analytics product's measurement surface: across all ~46 global
 * stations, how accurate is our calibrated forecast at day-of / day-before / two-days-out, which MARKETS we
 * forecast best and worst, and how our skill stacks against the market it is priced against.
 *
 * "Accuracy" = the champion (house_gaussian) POINT prediction — its single most-likely whole-°C bucket
 * (argmax) — vs the resolved high. Two lenses: EXACT (nailed the degree) and WITHIN-1 (mode within one
 * degree). The market's own call is scored on the SAME matched events, so every comparison is honest. Plus the
 * daily forecast-vs-market Brier gap. Composes ONE RPC (dash_data, 0065). Read-only analytics; trading DORMANT.
 */
import type { ReactElement } from 'react';
import { BarChart } from '../../../components/BarChart.tsx';
import { LineChart } from '../../../components/LineChart.tsx';
import { fmtDate, fmtPct, num } from '../../../lib/format.ts';
import { getDataAccuracy, type DataStationRow } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

// ─── static provenance (the depth of forecast-vs-outcome data; see the project DATA.md) ──────────────────────
// FACTS measured 2026-06-26 from the prod DB. The forecast-vs-outcome record is the binding constraint — the
// outcome series alone reaches back far further, but has no matching forecast before late March 2026. The
// fourth row ("Bucket distributions") is derived LIVE from meta (the scored window) so it can never drift from
// the window string rendered above it.
const PROVENANCE_HISTORICAL: { label: string; since: string; span: string; note: string }[] = [
  { label: 'Observed highs (truth)', since: '2024-01-21', span: '~29 months', note: '45 stations — but no matching forecast before Mar 2026' },
  { label: 'Raw NWP forecasts captured', since: '2026-03-28', span: '~3 months', note: 'backfilled archive to late Mar; live twice-daily since Jun 13' },
  { label: 'Forecast ↔ outcome pairs', since: '2026-03-28', span: '~3 months', note: '~250k pairs, 45 stations — the real skill record' },
];

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Mean-miss / degrees at 2dp with a degree sign, or '—'. */
function deg(v: unknown): string {
  const n = num(v);
  return n === null ? '—' : `${n.toFixed(2)}°`;
}

/** Whole-week span between two 'YYYY-MM-DD' dates, '~N week(s)' or '—' when either is absent/invalid. */
function spanWeeks(first: string | null, last: string | null): string {
  if (!first || !last) return '—';
  const f = Date.parse(first);
  const l = Date.parse(last);
  if (Number.isNaN(f) || Number.isNaN(l)) return '—';
  const weeks = Math.max(1, Math.round((l - f) / (7 * 86_400_000)));
  return `~${weeks} week${weeks === 1 ? '' : 's'}`;
}

/** Prettify a cluster region slug: 'europe-west' → 'europe west'. */
function region(r: string): string {
  return r.replace(/-/g, ' ');
}

const LEAD_LABEL: Record<number, string> = { 0: 'Day-of', 1: '1 day before', 2: '2 days before' };

/** A best/worst station row — `tone` ramps the left rule green (best) or red (worst). */
function StationRow({ s, tone }: { s: DataStationRow; tone: 'pos' | 'neg' }): ReactElement {
  const color = tone === 'pos' ? 'var(--ams-green, #38d39f)' : 'var(--ams-red, #ff6b6b)';
  return (
    <tr style={{ boxShadow: `inset 3px 0 0 ${color}` }}>
      <td>
        <strong>{s.city}</strong>
        <div className="muted small">{region(s.region)}</div>
      </td>
      <td className="num">{deg(s.meanMiss)}</td>
      <td className="num">{fmtPct(s.within1Pct, 0)}</td>
      <td className="num">{fmtPct(s.exactPct, 0)}</td>
      <td className="num muted">{deg(s.marketMeanMiss)}</td>
      <td className="num">{num(s.n) ?? '—'}</td>
    </tr>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────────────────────────────────────

export default async function DataPage(): Promise<ReactElement> {
  const view = await getDataAccuracy(await serverDb());

  // < 2 (not === 0): at exactly one qualifying station there is no best-vs-worst story, and the negative-slice
  // (slice(-0) returns the WHOLE array) would mislabel the lone station "worst" with a blank "best".
  if (!view || view.byStation.length < 2) {
    return (
      <div className="ams-dash">
        <h1>Forecast accuracy by market</h1>
        <p className="muted">
          No scored forecast data yet — this fills in as markets resolve and the calibration scorer runs.
        </p>
      </div>
    );
  }

  const { meta, byLead, byStation, brierSeries } = view;
  const lead0 = byLead.find((r) => r.lead === 0) ?? null; // day-of
  const lead1 = byLead.find((r) => r.lead === 1) ?? null; // day-before

  // Best / worst are the head & tail of the RPC's mean-miss ordering.
  const N = Math.min(8, Math.floor(byStation.length / 2));
  const best = byStation.slice(0, N);
  const worst = byStation.slice(-N).reverse();
  const bestNames = best.slice(0, 3).map((s) => s.city).join(', ');
  const worstNames = worst.slice(0, 3).map((s) => s.city).join(', ');

  // Mean-miss skyline across every market (sorted best→worst by the RPC).
  const skyline = byStation.map((s) => ({
    label: s.city.length > 9 ? `${s.city.slice(0, 8)}…` : s.city,
    value: num(s.meanMiss) ?? 0,
    tag: fmtPct(s.within1Pct, 0),
  }));

  // Brier gap series (house vs market, daily).
  const brierLabels = brierSeries.map((p) => p.date);
  const brierUs = brierSeries.map((p) => num(p.brierHouse));
  const brierMkt = brierSeries.map((p) => num(p.brierMarket));

  const leadStation = num(meta.leadStation) ?? 1;

  // The scored-distribution row is derived from the live window (meta.firstDay→lastDay) — the house probability
  // vectors this page scores start mid-June (house dists are never seeded for past target_dates), NOT mid-May.
  const provenance = [
    ...PROVENANCE_HISTORICAL,
    {
      label: 'Bucket distributions (this page)',
      since: meta.firstDay ? fmtDate(meta.firstDay) : '—',
      span: spanWeeks(meta.firstDay, meta.lastDay),
      note: 'the house probability vectors these accuracy numbers score',
    },
  ];

  return (
    <div className="ams-dash">
      <h1>
        Forecast accuracy by market{' '}
        <span className="chip blue">{num(meta.nStations) ?? '—'} stations</span>{' '}
        <span className="chip soft">
          {fmtDate(meta.firstDay)} → {fmtDate(meta.lastDay)}
        </span>
      </h1>
      <p className="muted small">
        How accurate is our forecast, market by market? “Accuracy” is the champion (
        <span className="mono">{meta.champion}</span>) <strong>point prediction</strong> — its single
        most-likely whole-degree bucket — against the resolved daily high. Two lenses: <strong>exact</strong>{' '}
        (nailed the degree) and <strong>within 1°</strong> (mode within one bucket). Each market’s own price is
        scored on the <em>same</em> resolved days, so the head-to-head is honest. One bucket = one degree in that
        market’s native unit (°C abroad, °F in the US). Read-only analytics — the trading rail is DORMANT.
      </p>

      {/* ── headline tiles ───────────────────────────────────────────────────────────────────────────────── */}
      <div className="strip">
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Markets tracked</span>
          </div>
          <div className="big sky">{num(meta.nStations) ?? '—'}</div>
          <div className="sub">global airport stations</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Day-before within 1°</span>
            <span className="chip soft">ours</span>
          </div>
          <div className="big">{lead1 ? fmtPct(lead1.houseWithin1, 0) : '—'}</div>
          <div className="sub">market: {lead1 ? fmtPct(lead1.marketWithin1, 0) : '—'}</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Day-before exact</span>
            <span className="chip soft">ours</span>
          </div>
          <div className="big">{lead1 ? fmtPct(lead1.houseExact, 0) : '—'}</div>
          <div className="sub">market: {lead1 ? fmtPct(lead1.marketExact, 0) : '—'}</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Best market</span>
          </div>
          <div className="big" style={{ color: 'var(--ams-green, #38d39f)', fontSize: '1.4rem' }}>
            {best[0]?.city ?? '—'}
          </div>
          <div className="sub">{deg(best[0]?.meanMiss)} mean miss</div>
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="cap">Worst market</span>
          </div>
          <div className="big" style={{ color: 'var(--ams-red, #ff6b6b)', fontSize: '1.4rem' }}>
            {worst[0]?.city ?? '—'}
          </div>
          <div className="sub">{deg(worst[0]?.meanMiss)} mean miss</div>
        </div>
      </div>

      {/* ── accuracy by horizon ──────────────────────────────────────────────────────────────────────────── */}
      <h2>Accuracy by forecast horizon</h2>
      <p className="muted small">
        Pooled across every market, on the days both we and the market made a call. Exact-hit holds flat with
        lead while the distribution widens (mean miss grows) — the real skill decay. The market matches or edges
        us at every horizon, and its lead widens the further out you forecast. Day-of (lead 0) is the least clean
        comparison: the market figure is the freshest same-day quote, so it can price a running max already
        partly observed, while our distribution is fixed at the NWP cutoff — the head-to-head is strictest at
        leads 1–2.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Horizon</th>
              <th className="num">n</th>
              <th className="num">stations</th>
              <th className="num">exact (ours)</th>
              <th className="num">within 1° (ours)</th>
              <th className="num">mean miss (ours)</th>
              <th className="num">within 1° (mkt)</th>
              <th className="num">mean miss (mkt)</th>
            </tr>
          </thead>
          <tbody>
            {byLead.map((r) => {
              const weBeat = (num(r.houseWithin1) ?? 0) >= (num(r.marketWithin1) ?? 0);
              return (
                <tr key={r.lead}>
                  <td>
                    <strong>{LEAD_LABEL[r.lead] ?? `lead ${r.lead}`}</strong>
                  </td>
                  <td className="num">{num(r.n) ?? '—'}</td>
                  <td className="num">{num(r.stations) ?? '—'}</td>
                  <td className="num">{fmtPct(r.houseExact, 1)}</td>
                  <td className={`num ${weBeat ? 'pos' : ''}`}>{fmtPct(r.houseWithin1, 1)}</td>
                  <td className="num">{deg(r.houseMiss)}</td>
                  <td className="num muted">{fmtPct(r.marketWithin1, 1)}</td>
                  <td className="num muted">{deg(r.marketMiss)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── best & worst markets ─────────────────────────────────────────────────────────────────────────── */}
      <h2>Best &amp; worst markets — {LEAD_LABEL[leadStation] ?? `lead ${leadStation}`}</h2>
      <p className="muted small">
        Ranked by <strong>mean miss</strong> (average whole-degrees off — the stable ranker on a short sample).
        Best markets are stable maritime/temperate regimes; worst are the physically hard ones — afternoon
        convection, frontal passages, desert/sea-breeze extremes. The market’s mean miss on the same days is
        shown for contrast.
      </p>
      <div className="grid cols-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '0.75rem' }}>
        <div className="panel" style={{ margin: 0 }}>
          <div className="cap" style={{ color: 'var(--ams-green, #38d39f)', marginBottom: '0.35rem' }}>
            ▲ Sharpest markets
          </div>
          <table>
            <thead>
              <tr>
                <th>market</th>
                <th className="num">miss</th>
                <th className="num">≤1°</th>
                <th className="num">exact</th>
                <th className="num">mkt miss</th>
                <th className="num">n</th>
              </tr>
            </thead>
            <tbody>
              {best.map((s) => (
                <StationRow key={s.city} s={s} tone="pos" />
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel" style={{ margin: 0 }}>
          <div className="cap" style={{ color: 'var(--ams-red, #ff6b6b)', marginBottom: '0.35rem' }}>
            ▼ Hardest markets
          </div>
          <table>
            <thead>
              <tr>
                <th>market</th>
                <th className="num">miss</th>
                <th className="num">≤1°</th>
                <th className="num">exact</th>
                <th className="num">mkt miss</th>
                <th className="num">n</th>
              </tr>
            </thead>
            <tbody>
              {worst.map((s) => (
                <StationRow key={s.city} s={s} tone="neg" />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="cap" style={{ marginBottom: '0.4rem' }}>
          Every market by mean miss — shorter bar = more accurate (sorted best → worst)
        </div>
        <BarChart
          data={skyline}
          width={920}
          height={260}
          color="var(--ams-amber, #f0b65e)"
          ariaLabel="mean whole-degree forecast miss per market, sorted from most to least accurate"
          valueFmt={(v) => `${v.toFixed(2)}°`}
          emptyHint="no scored markets yet"
        />
      </div>

      {/* ── Brier gap over time ──────────────────────────────────────────────────────────────────────────── */}
      <h2>Forecast-vs-market Brier gap over time</h2>
      <p className="muted small">
        Daily pooled multi-category Brier (lower = better) at the day-before lead, ours vs the market, since our
        bucket distributions began scoring. Our curve sits persistently a few points ABOVE the market’s — a
        stable deficit that is not closing. This is the efficiency verdict in proper-score form: a competent
        forecaster that the market still edges.
      </p>
      <div className="panel">
        <LineChart
          labels={brierLabels}
          series={[
            { label: 'ours', color: 'var(--ams-amber, #f0b65e)', dash: '5 3', values: brierUs },
            { label: 'market', color: 'var(--ams-sky, #4cc2ff)', values: brierMkt },
          ]}
          width={920}
          height={260}
          yFmt={(v) => v.toFixed(2)}
          yLabel="Brier"
          ariaLabel="daily Brier score, our forecast vs the market, at the day-before lead"
          emptyHint="not enough scored days yet — fills in as markets resolve"
        />
      </div>

      {/* ── what the data says ───────────────────────────────────────────────────────────────────────────── */}
      <h2>What the data says</h2>
      <div className="panel">
        <ul style={{ margin: 0, paddingLeft: '1.1rem', lineHeight: 1.7 }}>
          <li>
            <strong>We are a competent forecaster, not a market-beating one.</strong> Day-of we land within 1°
            about {lead0 ? fmtPct(lead0.houseWithin1, 0) : '—'} of the time; the market matches or edges us at
            every horizon, and its lead grows the further out you forecast.
          </li>
          <li>
            <strong>Accuracy is climate-driven.</strong> The sharpest markets ({bestNames}) are stable
            maritime/temperate regimes; the hardest ({worstNames}) are convective, frontal, or desert/sea-breeze
            climates where the daily high is physically jumpy. The ranking is not noise — it tracks meteorology.
          </li>
          <li>
            <strong>The Brier deficit is stable, not closing.</strong> Our day-before Brier sits a few points
            above the market’s on most days, with no convergence — orthogonal confirmation of the efficiency
            finding, in a proper score rather than a hit rate.
          </li>
          <li>
            <strong>This is a short, summery sample.</strong> The numbers below firm up as live capture accrues —
            treat them as indicative, especially the per-station ranks (~10 day-before observations each).
          </li>
        </ul>
      </div>

      {/* ── data provenance ──────────────────────────────────────────────────────────────────────────────── */}
      <h2>Data provenance &amp; how far back it goes</h2>
      <p className="muted small">
        The outcome record is long, but the <strong>forecast-vs-outcome</strong> record — the only thing skill
        can be measured against — is a ~3-month book, only ~2 weeks of it from live capture. The accuracy on
        this page is scored on the bucket-distribution window ({fmtDate(meta.firstDay)} → {fmtDate(meta.lastDay)}).
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>dataset</th>
              <th className="num">since</th>
              <th className="num">span</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody>
            {provenance.map((p) => (
              <tr key={p.label}>
                <td>
                  <strong>{p.label}</strong>
                </td>
                <td className="num mono">{p.since}</td>
                <td className="num">{p.span}</td>
                <td className="small muted">{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: '0.6rem' }}>
        Calibration runs on a 30-day rolling window, so the live model only conditions on ~1 month of recent
        error per station — the deeper outcome archive trains nothing directly. Live evidence:{' '}
        <a href="/efficiency">the efficiency verdict →</a> · <a href="/calibration">calibration &amp; reliability →</a> ·{' '}
        <a href="/amsterdam">the Amsterdam paper-trade →</a>
      </p>
    </div>
  );
}
