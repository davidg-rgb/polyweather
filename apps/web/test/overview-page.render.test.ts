/**
 * / (overview) render smoke test — the front door is a server component composing three RPC loaders.
 * Renders the whole tree to static markup with the loaders mocked, proving it never throws and the
 * key skill/verdict/coverage content reaches the DOM after the .ams-dash Terminal-Glass restyle —
 * including the twelve-ways verdict hero (SIGNAL_HERO figures + the /signals flagship link), asserted
 * against the imported asset so the hero can never drift from the record.
 * Emits a standalone preview (markup + globals.css) when OVERVIEW_PREVIEW_OUT is set.
 */
import { SIGNAL_HERO } from '@weather-edge/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));
vi.mock('../src/lib/loaders.ts', () => ({
  getCalibrationView: async () => ({
    champion: 'house_gaussian',
    scores: [
      { city: 'amsterdam', cityId: '1', source: 'house_gaussian', lead: 1, window: '30Z', brier: 0.362, brierMarket: 0.341, bootstrapP: 0.2, ece: 0.048, sharpness: 0.2, n: 120, reliability: [{ bin: 0.2, hit: 0.21, n: 40 }, { bin: 0.5, hit: 0.48, n: 50 }, { bin: 0.8, hit: 0.83, n: 30 }] },
      { city: 'paris', cityId: '2', source: 'house_gaussian', lead: 1, window: '30Z', brier: 0.371, brierMarket: 0.352, bootstrapP: 0.3, ece: 0.052, sharpness: 0.2, n: 110, reliability: [{ bin: 0.3, hit: 0.28, n: 45 }, { bin: 0.6, hit: 0.62, n: 35 }] },
    ],
  }),
  getEventsList: async () => ({ events: [], champion: 'house_gaussian', counts: { open: 38, withSnapshot: 35, withHouse: 37 } }),
  getTodayOverview: async () => ({
    bankroll: 0, mode: 'shadow', championSource: 'house_gaussian', openRecs: [], pnlSeries: [],
    breakerStates: [], jobHealth: [{ job: 'poll-markets', lastOk: '2026-06-26T03:00:00Z', running: null }],
    exposures: { byEvent: [], byCluster: [], byDay: [] },
  }),
}));

describe('/ overview page renders (Terminal-Glass restyle)', () => {
  it('renders end-to-end with the .ams-dash idiom and the key content present', async () => {
    const { default: OverviewPage } = await import('../src/app/(dash)/page.tsx');
    const el = await OverviewPage();
    const html = renderToStaticMarkup(el);

    expect(html).toContain('class="ams-dash"'); // the glass idiom wrapper
    expect(html).toContain('Forecast skill vs. the market');
    expect(html).toContain('champion: house_gaussian');
    expect(html).toContain('market efficient — measured'); // verdict chip (market sharper in the fixture)
    // the twelve-ways verdict hero — numbers imported from the SIGNAL_HERO asset (never re-typed) + the /signals link
    expect(html).toContain('The market measured efficient');
    expect(html).toContain(`${SIGNAL_HERO.measuredWays} ways`); // 12
    expect(html).toContain(SIGNAL_HERO.investigationStatus); // CLOSED · analytics retained · rail DORMANT
    expect(html).toContain(`>${SIGNAL_HERO.signalsFalsified}<`); // 10 orthogonal signals tile value
    expect(html).toContain(`>${SIGNAL_HERO.totalRows}<`); // signal rows on file tile value
    expect(html).toContain('Ways efficient');
    expect(html).toContain('href="/signals"'); // the flagship explorer link
    expect(html).toContain('Explore the verdict');

    expect(html).toContain('Can you beat these markets?');
    expect(html).toContain('the verdict page'); // /efficiency link
    expect(html).toContain('Champion reliability');
    expect(html).toContain('Coverage');
    expect(html).toContain('38'); // open events from the fixture
    expect(html).toContain('class="strip"'); // headline + coverage strips
    expect(html).toContain('0.36'); // our Brier

    const out = process.env.OVERVIEW_PREVIEW_OUT;
    if (out) {
      const css = readFileSync('apps/web/src/app/globals.css', 'utf8');
      const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="shell"><main>${html}</main></div></body></html>`;
      try {
        writeFileSync(out, doc);
      } catch {
        /* preview is best-effort */
      }
    }
  });
});
