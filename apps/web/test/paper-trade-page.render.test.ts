/**
 * /paper-trade render smoke test — the page is a server component composing the live dash_city_sim loader
 * with the committed "45-City Scan" static-asset section (SIGNAL-BACKLOG.md §12 + Data appendix) and the
 * current-bet box (operator request 2026-07-04). Renders the whole tree to static markup with the loader
 * mocked to prove (a) the page never throws on the populated, empty-cities, and RPC-missing paths, (b) the
 * scan section's appendix figures, candidate table, and caveats reach the DOM, and (c) the current-bet box
 * shows the bidding date + predicted native temperature with DST-correct Stockholm equivalents for both
 * the "bidding now" and "today's bets not placed yet" branches. Mirrors efficiency-page.render.test.ts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));

/** A minimal-but-complete CitySimCity view object (the loader is mocked, so we build the view shape). */
const cityFixture = (over: Record<string, unknown>): Record<string, unknown> => ({
  slug: 'x', displayName: 'X', icao: 'XXXX', unit: 'C', tz: 'UTC',
  armHours: [11, 12, 13, 14], stakeUsd: 10,
  coverage: { firstDate: '2026-06-12', lastDate: '2026-07-03', nDays: 20, nGradedDays: 19, nPending: 4 },
  arms: [], leaderHour: null,
  entryWatch: { recommendedHour: null, confidence: 'insufficient', rationale: 'gathering data', arms: [] },
  totals: { pnl: 0, nGraded: 0, nWon: 0, staked: 0 },
  chart: { dates: [], byHour: {} },
  betLog: [],
  latest: { date: null, byHour: {} },
  ...over,
});

const latestRow = (predictedC: number, label: string): Record<string, unknown> => ({
  predictedC, label, ask: 0.35, status: 'pending', won: null, pnl: null, actualC: null, runMaxC: null,
});

describe('/paper-trade page renders — 45-City Scan section + current-bet box', () => {
  it('renders the scan section (full appendix figures) alongside an empty live-cities view', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({
      getCitySim: async () => ({
        generatedAt: '2026-07-04T10:00:00Z',
        cities: [],
        overall: { pnl: 0, nGraded: 0, nWon: 0 },
      }),
    }));
    const { default: PaperTradePage } = await import('../src/app/(dash)/paper-trade/page.tsx');
    const html = renderToStaticMarkup(await PaperTradePage());

    // section headline + framing
    expect(html).toContain('45-City Scan');
    expect(html).toContain('analytics selection');
    expect(html).toContain('another Karachi');
    expect(html).toContain('now enrolled');

    // the two candidates, named + golden TEST figures
    expect(html).toContain('ankara');
    expect(html).toContain('houston');
    expect(html).toContain('candidate');
    expect(html).toContain('$44.88');
    expect(html).toContain('$12.04');

    // the full pooled curve reaches the DOM — every hour's ROI value (chart labels + table)
    for (const v of ['-13.9pp', '-13.6pp', '-13.0pp', '-15.9pp', '-11.4pp', '-25.5pp', '-45.1pp', '-68.7pp', '-91.6pp', '-101.9pp']) {
      expect(html).toContain(v);
    }
    // curve table: n, net, win rate, mean ask, CI samples
    expect(html).toContain('828'); // 9h/10h n
    expect(html).toContain('$3,653.32'); // 18h net
    expect(html).toContain('38.8%'); // 14h win rate
    expect(html).toContain('0.062'); // 19h mean ask
    expect(html).toContain('[-104.6pp, -99.8pp]'); // 19h CI

    // terciles with real figures
    expect(html).toContain('-37.9pp');
    expect(html).toContain('-26.8pp');
    expect(html).toContain('-22.2pp');
    expect(html).toContain('40.4%');
    expect(html).toContain('[0.169, 0.382]');

    // winner/loser ask split with ns
    expect(html).toContain('0.539');
    expect(html).toContain('0.241');
    expect(html).toContain('2,351');
    expect(html).toContain('4,911');

    // the rejected cells, named with a reason — incl. the two asymmetry poster children
    expect(html).toContain('munich');
    expect(html).toContain('buenos-aires');
    expect(html).toContain('helsinki');
    expect(html).toContain('TEST net negative');
    expect(html).toContain('TRAIN LB ≤ 0');
    expect(html).toContain('$30.86'); // munich TEST loss
    expect(html).toContain('$44.23'); // helsinki positive TEST that does NOT count

    // caveats rendered visibly (not a tooltip-only title attr)
    expect(html).toContain('Read this before trusting the two candidates');
    expect(html).toMatch(/fixed.bucket/i);
    expect(html).toContain('straddle');
    expect(html).toContain('SELECTS');
    expect(html).toContain('CONFIRMS');
    expect(html).toContain('2026-07-04');

    // methodology detail
    expect(html).toContain('methodology, run record');
    expect(html).toContain('844');
    expect(html).toContain('7,262');
  });

  it('still renders the scan section when the live dash_city_sim RPC is unavailable', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({ getCitySim: async () => null }));
    const { default: PaperTradePage } = await import('../src/app/(dash)/paper-trade/page.tsx');
    const html = renderToStaticMarkup(await PaperTradePage());

    expect(html).toContain('not available yet');
    expect(html).toContain('45-City Scan');
    expect(html).toContain('ankara');
    expect(html).toContain('houston');
  });

  it('current-bet box: bidding date + predicted temp, per-arm and shared, with Stockholm equivalents', async () => {
    const todayUtc = new Date().toISOString().slice(0, 10);
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({
      getCitySim: async () => ({
        generatedAt: '2026-07-04T10:00:00Z',
        cities: [
          // houston (°F, America/Chicago): arms differ → per-arm rows; date = today → "bidding now".
          // July = CDT (UTC−5): 11:00 local → 18:00 CEST; 14:00 local → 21:00 CEST (DST-correct both ends).
          cityFixture({
            slug: 'houston', displayName: 'Houston', icao: 'KHOU', unit: 'F', tz: 'America/Chicago',
            armHours: [11, 12, 13, 14],
            latest: { date: todayUtc, byHour: { 11: latestRow(96, '96°F'), 14: latestRow(97, '97°F') } },
          }),
          // singapore (°C, Asia/Singapore): all arms agree → one shared temp; stale date → "latest bet" label.
          cityFixture({
            slug: 'singapore', displayName: 'Singapore', icao: 'WSSS', unit: 'C', tz: 'Asia/Singapore',
            armHours: [11, 12],
            latest: { date: '2026-06-30', byHour: { 11: latestRow(32, '32°C'), 12: latestRow(32, '32°C') } },
          }),
        ],
        overall: { pnl: 0, nGraded: 0, nWon: 0 },
      }),
    }));
    const { default: PaperTradePage } = await import('../src/app/(dash)/paper-trade/page.tsx');
    const html = renderToStaticMarkup(await PaperTradePage());

    // the box + both cities
    expect(html).toContain('Current bets');
    expect(html).toContain('bidding date');

    // houston: per-arm temps in native °F, city-local hour + DST-correct Stockholm equivalent
    expect(html).toContain('96°F');
    expect(html).toContain('97°F');
    expect(html).toContain('11:00 local');
    expect(html).toContain('18:00 CEST'); // 11:00 CDT (UTC−5) → 18:00 CEST (UTC+2)
    expect(html).toContain('21:00 CEST'); // 14:00 CDT → 21:00 CEST
    expect(html).toContain('bidding now'); // today's date → the live-bet label

    // singapore: shared temp, stale date labelled + arm range with Stockholm times
    expect(html).toContain('32°C');
    expect(html).toContain('2026-06-30');
    expect(html).toContain('not placed yet');
    expect(html).toContain('05:00 CEST'); // 11:00 SGT (UTC+8) → 05:00 CEST
    expect(html).toContain('06:00 CEST'); // 12:00 SGT → 06:00 CEST

    // the top banner's generated-at now renders in Stockholm wall clock (07-04 10:00Z → 12:00 CEST)
    expect(html).toContain('12:00 CEST');

    // the °F unit-ordering fix: the city header renders °F, never F°
    expect(html).toContain('°F ·');
    expect(html).not.toContain('F° ·');
  });
});
