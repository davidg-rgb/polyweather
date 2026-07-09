/**
 * /paper-trade render smoke test — the page composes three sections: (1) the FROZEN per-city buy-table
 * archive-backtest record (core/sim/city-buy-table-results — calibrated book + taker fee, as-of chip),
 * (2) the LIVE forward ledger (dash_city_sim via getCitySim — the backtest-vs-realized cross-check
 * instrument, loop rule 4), and (3) the pre-registered "45-City Scan" companion. Renders the whole tree on
 * both the graceful-empty path (ledger null → the accrues-server-side note) and the populated path (a
 * city-sim fixture), proving it never throws and the honest no-edge verdict + figures reach the DOM.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CITY_BUY_TABLE } from '@weather-edge/core';

vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));

afterEach(() => vi.resetModules());

async function renderWith(getCitySim: () => Promise<unknown>): Promise<string> {
  vi.doMock('../src/lib/loaders.ts', () => ({ getCitySim }));
  const { default: PaperTradePage } = await import('../src/app/(dash)/paper-trade/page.tsx');
  const el = await PaperTradePage();
  return renderToStaticMarkup(el);
}

const B = CITY_BUY_TABLE;

const citySimFixture = {
  generatedAt: '2026-07-09T21:00:00Z',
  overall: { pnl: 12.34, nGraded: 41, nWon: 9 },
  cities: [
    {
      slug: 'singapore',
      displayName: 'Singapore',
      icao: 'WSSS',
      unit: 'C',
      tz: 'Asia/Singapore',
      armHours: [11, 12, 13, 14],
      stakeUsd: 10,
      coverage: { firstDate: '2026-06-29', lastDate: '2026-07-08', nDays: 10, nGradedDays: 9, nPending: 1 },
      arms: [
        { hour: 12, recommended: false },
        { hour: 14, recommended: true },
      ],
      leaderHour: 12,
      entryWatch: { arms: [] },
      totals: { pnl: 12.34, nGraded: 41, nWon: 9, staked: 410 },
      chart: { dates: [], byHour: {} },
      betLog: [],
      latest: { date: null, byHour: {} },
    },
  ],
};

describe('/paper-trade page renders — buy table + live forward ledger + 45-City Scan', () => {
  it('graceful-empty ledger path: never throws; the frozen record + the accrues-server-side note render', async () => {
    const html = await renderWith(async () => null);

    // the honest no-edge verdict with the calibrated-book pooled figures
    expect(html).toContain('Per-city buy table');
    expect(html).toContain('Verdict: no demonstrable edge');
    expect(html).toContain('-9.2pp'); // pooled ROI (ASCII hyphen via fmtDelta) — pinned by the asset tests too
    expect(html).toContain('$51'); // pooled net magnitude (signedUsd prefixes a U+2212 minus)
    expect(html).toContain('calibrated book');
    expect(html).toContain('signal #12');
    expect(html).toContain('already falsified');
    expect(html).toContain('Nothing here reopens');

    // the frozen-record as-of chip (the page is NOT a live feed)
    expect(html).toContain('frozen archive record');

    // summary strip + window from the committed asset
    expect(html).toContain('Sweet-spot entry');
    expect(html).toContain('small-sample longshot noise');
    expect(html).toContain(B.universe.dateRange[0]);
    expect(html).toContain(B.universe.dateRange[1]);

    // the "peak time" lead curve — every lead row reaches the DOM
    expect(html).toContain('peak time');
    expect(html).toContain('sweet-spot');
    for (const l of B.leadCurve) {
      expect(html, `lead ${l.leadH}h ROI`).toContain(`${l.roiPct.toFixed(1)}pp`);
    }

    // the per-city table: header, every city row, pooled footer
    expect(html).toContain('net by lead');
    expect(html).toContain(`Per-city results @ ${B.params.sweetLeadH}h sweet-spot`);
    for (const r of B.rows) expect(html, `row ${r.city}`).toContain(r.display);
    expect(html).toContain('POOLED');

    // method/reproduce names the source script AND the canonical cost model
    expect(html).toContain('city-buy-table.py');
    expect(html).toContain('cost_model.py');
    expect(html).toContain('bias corrected on prior data only'); // no-hyphen convention (calibration invariant)

    // the live forward ledger section renders its graceful-empty note (the cron still accrues server-side)
    expect(html).toContain('Live forward ledger');
    expect(html).toContain('ledger still accrues');

    // the 45-City Scan companion with its golden candidate figures
    expect(html).toContain('45-City Scan');
    expect(html).toContain('ankara');
    expect(html).toContain('houston');
    expect(html).toContain('$44.88'); // ankara TEST net
    expect(html).toContain('$12.04'); // houston TEST net
    expect(html).toContain('Read this before trusting the two candidates');
  });

  it('populated ledger path: the realized totals, leader arm and watcher pick reach the DOM', async () => {
    const html = await renderWith(async () => citySimFixture);
    expect(html).toContain('Live forward ledger');
    expect(html).toContain('Singapore');
    expect(html).toContain('WSSS');
    expect(html).toContain('$12.34'); // city + overall net P&L
    expect(html).toContain('12:00'); // 🥇 leader arm
    expect(html).toContain('14:00'); // ⭐ watcher pick (recommended ≠ leader)
    expect(html).not.toContain('ledger still accrues'); // the graceful-empty note must NOT show
  });

  it('a throwing DB never breaks the page (the static record still renders)', async () => {
    const html = await renderWith(async () => {
      throw new Error('boom');
    });
    expect(html).toContain('Per-city buy table');
    expect(html).toContain('Live forward ledger');
    expect(html).toContain('ledger still accrues');
  });
});
