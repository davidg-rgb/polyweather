'use client';
/**
 * CitiesTable — the /cities interactive prediction table (UI-POLISH-HANDOFF.md WS-B).
 *
 * Pure presentation over server-computed, fully-serializable rows: the page (a server component) joins the
 * dash_city_predictions payload (open markets + per-city success rates + the live buy-window config) and
 * hands this component plain numbers/strings; the only client state is the two filters the handoff asks for
 * — day tabs (today / tomorrow / +2) and an "in buy window" toggle. Default order is time-to-close ascending
 * (actionable first — the server pre-sorts; this component never re-sorts).
 *
 * Honesty rules carried in the cells: the success rate ALWAYS renders with its n ("62% (n=18)") and greys
 * out below n=8 (the entry-watch small-n/shrinkage lesson — a small-sample percentage must never look
 * authoritative); rows inside the live lane's [leadMinH, leadMaxH]h window get the rec-row highlight.
 */
import { useState, type ReactElement } from 'react';

/** The n floor below which a success rate renders muted (small-n honesty — the entry-watch lesson). */
export const SMALL_N_FLOOR = 8;

/** One fully-derived table row (server-computed; everything display-ready and serializable). */
export interface CitiesTableRow {
  city: string;
  displayName: string;
  /** station-local market day (YYYY-MM-DD). */
  targetDate: string;
  /** whole-day offset of targetDate vs the render instant's UTC date (0 = today, 1 = tomorrow, …). */
  dayOffset: number;
  /** hours until resolves_at at render time; null when the capture carries no resolution clock. */
  hoursToClose: number | null;
  /** the latest capture's age in minutes at render time (staleness honesty). */
  captureAgeMin: number | null;
  predLabel: string | null;
  /** 0..1 house probability of the predicted bucket. */
  predProb: number | null;
  /** 0..1 ask for the predicted bucket (execAsk → bestAsk). */
  ask: number | null;
  /** per-city historic success rate 0..1 (null when no graded history). */
  rate: number | null;
  /** the rate's sample size. */
  n: number;
  /** hoursToClose ∈ [leadMinH, leadMaxH] — the live lane's entry window. */
  inWindow: boolean;
}

const dayLabel = (offset: number, date: string): string =>
  offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : offset === 2 ? '+2' : date.slice(5);

const fmtHours = (h: number | null): string => (h === null ? '—' : `${h.toFixed(1)}h`);
const fmtCents = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}¢`);
const fmtPct0 = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

/**
 * The success-rate cell tone: grey under the n floor; otherwise a subtle green→amber→red ramp on the
 * project's accessible --ams palette. Thresholds: ≥55% green (comfortably above the ~1-in-3 argmax base
 * rate), ≥40% amber, below that red — coarse on purpose (three steps read faster than a gradient).
 */
export function rateColor(rate: number | null, n: number): string {
  if (rate === null || n < SMALL_N_FLOOR) return 'var(--ams-muted)';
  if (rate >= 0.55) return 'var(--ams-tertiary)';
  if (rate >= 0.4) return 'var(--ams-amber)';
  return 'var(--ams-red)';
}

export function CitiesTable({
  rows,
  leadMinH,
  leadMaxH,
}: {
  rows: CitiesTableRow[];
  leadMinH: number;
  leadMaxH: number;
}): ReactElement {
  const [dayTab, setDayTab] = useState<number | null>(null); // null = all days
  const [windowOnly, setWindowOnly] = useState(false);

  const offsets = [...new Set(rows.map((r) => r.dayOffset))].sort((a, b) => a - b);
  const visible = rows.filter(
    (r) => (dayTab === null || r.dayOffset === dayTab) && (!windowOnly || r.inWindow),
  );

  if (rows.length === 0) {
    return <p className="muted">No open captured markets right now — rows appear as fresh daily markets list.</p>;
  }

  return (
    <div>
      <div className="form-row" role="toolbar" aria-label="filter the prediction table">
        <span className="cap">day</span>
        <button
          type="button"
          className={dayTab === null ? 'primary' : undefined}
          aria-pressed={dayTab === null}
          onClick={() => setDayTab(null)}
        >
          all
        </button>
        {offsets.map((o) => (
          <button
            key={o}
            type="button"
            className={dayTab === o ? 'primary' : undefined}
            aria-pressed={dayTab === o}
            onClick={() => setDayTab(o)}
          >
            {dayLabel(o, rows.find((r) => r.dayOffset === o)?.targetDate ?? '')}
          </button>
        ))}
        <label style={{ marginLeft: '0.75rem' }}>
          <input type="checkbox" checked={windowOnly} onChange={() => setWindowOnly((p) => !p)} /> in buy window
          only <span className="muted small mono">[{leadMinH}, {leadMaxH}]h</span>
        </label>
      </div>
      {visible.length === 0 ? (
        <p className="muted">No open markets match the current filter.</p>
      ) : (
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>city</th>
                <th>active day</th>
                <th>our prediction</th>
                <th className="num">market ask</th>
                <th className="num">time to close</th>
                <th className="num">historic success</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={`${r.city}|${r.targetDate}`}
                  className={r.inWindow ? 'rec-row' : undefined}
                  title={
                    r.inWindow
                      ? `inside the live lane's [${leadMinH}, ${leadMaxH}]h entry window`
                      : undefined
                  }
                >
                  <td>
                    <strong>{r.displayName}</strong> <span className="muted small mono">{r.city}</span>
                  </td>
                  <td className="mono small">
                    {r.targetDate} <span className="muted">({dayLabel(r.dayOffset, r.targetDate)})</span>
                  </td>
                  <td>
                    {r.predLabel ? (
                      <>
                        <strong className="mono">{r.predLabel}</strong>{' '}
                        <span className="muted small">{fmtPct0(r.predProb)} house</span>
                      </>
                    ) : (
                      <span className="muted small" title="the latest capture carries no seeded house forecast">
                        unseeded
                      </span>
                    )}
                  </td>
                  <td className="num mono">{fmtCents(r.ask)}</td>
                  <td
                    className="num mono"
                    title={
                      r.captureAgeMin !== null && r.captureAgeMin > 60
                        ? `latest capture is ${Math.round(r.captureAgeMin)} min old — the quote may be stale`
                        : undefined
                    }
                  >
                    {fmtHours(r.hoursToClose)}
                    {r.inWindow ? <span className="pill" style={{ marginLeft: '0.4rem' }}>window</span> : null}
                    {r.captureAgeMin !== null && r.captureAgeMin > 60 ? (
                      <span className="muted small"> ⚠ stale</span>
                    ) : null}
                  </td>
                  <td className="num">
                    <span style={{ color: rateColor(r.rate, r.n), fontWeight: 600 }}>{fmtPct0(r.rate)}</span>{' '}
                    <span className="muted small">(n={r.n})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
