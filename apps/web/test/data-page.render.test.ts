/**
 * /data render smoke test — the page is a server component that composes ONE RPC loader (dash_data) and two
 * dependency-free SVG charts (BarChart, LineChart). This renders the whole tree to static markup with the
 * loader mocked (a realistic fixture) to prove (a) it never throws, (b) every section + the best/worst markets
 * + the by-horizon table + both charts reach the DOM, and (c) the graceful-empty path renders. It also
 * optionally writes the rendered HTML (globals.css inlined) to the scratchpad for an unauthenticated eyeball.
 */
import { SELECTOR_DIAGNOSTIC_META } from '@weather-edge/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));

const FIXTURE = {
  meta: {
    champion: 'house_gaussian',
    leadStation: 1,
    generatedAt: '2026-06-26T13:00:00Z',
    firstDay: '2026-06-13',
    lastDay: '2026-06-26',
    nStations: 44,
  },
  byLead: [
    { lead: 0, n: 332, stations: 43, houseExact: 0.355, houseWithin1: 0.892, houseMiss: 0.78, marketExact: 0.446, marketWithin1: 0.88, marketMiss: 0.7 },
    { lead: 1, n: 448, stations: 44, houseExact: 0.355, houseWithin1: 0.781, houseMiss: 0.94, marketExact: 0.395, marketWithin1: 0.839, marketMiss: 0.8 },
    { lead: 2, n: 258, stations: 28, houseExact: 0.36, houseWithin1: 0.698, houseMiss: 1.06, marketExact: 0.36, marketWithin1: 0.822, marketMiss: 0.87 },
  ],
  byStation: [
    { city: 'madrid', region: 'europe-west', n: 8, exactPct: 0.625, within1Pct: 1.0, meanMiss: 0.375, marketWithin1Pct: 1.0, marketMeanMiss: 0.5 },
    { city: 'munich', region: 'europe-west', n: 10, exactPct: 0.5, within1Pct: 0.9, meanMiss: 0.5, marketWithin1Pct: 0.9, marketMeanMiss: 0.6 },
    { city: 'london', region: 'europe-west', n: 11, exactPct: 0.45, within1Pct: 0.91, meanMiss: 0.58, marketWithin1Pct: 0.9, marketMeanMiss: 0.6 },
    { city: 'miami', region: 'na-east', n: 9, exactPct: 0.55, within1Pct: 0.88, meanMiss: 0.62, marketWithin1Pct: 0.9, marketMeanMiss: 0.55 },
    { city: 'nyc', region: 'na-east', n: 10, exactPct: 0.36, within1Pct: 0.77, meanMiss: 0.91, marketWithin1Pct: 0.85, marketMeanMiss: 0.7 },
    { city: 'dallas', region: 'na-central', n: 11, exactPct: 0.27, within1Pct: 0.68, meanMiss: 1.23, marketWithin1Pct: 0.8, marketMeanMiss: 0.82 },
    { city: 'shenzhen', region: 'east-asia', n: 10, exactPct: 0.15, within1Pct: 0.7, meanMiss: 1.25, marketWithin1Pct: 0.78, marketMeanMiss: 0.9 },
    { city: 'jeddah', region: 'mideast', n: 7, exactPct: 0.14, within1Pct: 0.43, meanMiss: 1.57, marketWithin1Pct: 0.86, marketMeanMiss: 0.86 },
  ],
  brierSeries: [
    { date: '2026-06-14', nHouse: 23, brierHouse: 0.742, nMarket: 42, brierMarket: 0.725 },
    { date: '2026-06-15', nHouse: 44, brierHouse: 0.803, nMarket: 42, brierMarket: 0.742 },
    { date: '2026-06-24', nHouse: 44, brierHouse: 0.661, nMarket: 41, brierMarket: 0.655 },
    { date: '2026-06-25', nHouse: 44, brierHouse: 0.735, nMarket: 42, brierMarket: 0.683 },
  ],
};

describe('/data page renders', () => {
  it('renders end-to-end with the populated fixture and surfaces every section', async () => {
    vi.doMock('../src/lib/loaders.ts', () => ({ getDataAccuracy: async () => FIXTURE }));
    const { default: DataPage } = await import('../src/app/(dash)/data/page.tsx');
    const el = await DataPage();
    const html = renderToStaticMarkup(el);

    // header + framing
    expect(html).toContain('Forecast accuracy by market');
    expect(html).toContain('44 stations');
    expect(html).toContain('house_gaussian');

    // by-horizon table
    expect(html).toContain('Accuracy by forecast horizon');
    expect(html).toContain('1 day before');
    expect(html).toContain('Day-of');

    // best / worst markets — head & tail of the fixture
    expect(html).toContain('Sharpest markets');
    expect(html).toContain('Hardest markets');
    expect(html).toContain('madrid'); // best (lowest mean miss)
    expect(html).toContain('jeddah'); // worst (highest mean miss)
    expect(html).toContain('europe west'); // region prettified

    // charts present (the SVG wrapper class + the headings)
    expect(html).toContain('Every market by mean miss'); // the skyline bar-chart caption
    expect(html).toContain('Forecast-vs-market Brier gap over time');
    expect(html).toContain('class="equity"'); // both BarChart + LineChart render this svg class

    // analysis + provenance
    expect(html).toContain('What the data says');
    expect(html).toContain('climate-driven');
    // the "Day-of" bullet must render the lead-0 within-1 value (~89%), NOT the day-before lead-1 value (78%).
    expect(html).toContain('about 89%');
    expect(html).not.toContain('about 78%');
    expect(html).toContain('Forecast ↔ outcome pairs');
    expect(html).toContain('2026-03-28');

    // model use by use-case (D7) — values coupled to the imported source-accuracy asset, never re-typed
    expect(html).toContain('Model use by use-case');
    expect(html).toContain('Seed-quality check');
    expect(html).toContain(`${SELECTOR_DIAGNOSTIC_META.nEvents}`); // the 708-event detail table label
    expect(html).toContain(`${SELECTOR_DIAGNOSTIC_META.bannerNEvents}-event panel`); // regenerated corroboration
    expect(html).toContain(`${SELECTOR_DIAGNOSTIC_META.bannerChw1Calibrated}%`);
    expect(html).toContain('the rail stays DORMANT, live config unchanged.'); // alignment note rendered as gated

    const out = process.env.DATA_PREVIEW_OUT;
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

  it('renders the graceful-empty state when the loader returns null', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({ getDataAccuracy: async () => null }));
    const { default: DataPage } = await import('../src/app/(dash)/data/page.tsx');
    const html = renderToStaticMarkup(await DataPage());
    expect(html).toContain('Forecast accuracy by market');
    expect(html).toContain('No scored forecast data yet');
  });

  // The production empty path: the RPC always returns a NON-null meta (the win CTE yields one (null,null,0) row
  // over zero data) with byStation coalesced to []. The page must still show the graceful message via the
  // `byStation.length < 2` disjunct, not crash.
  it('renders the graceful-empty state for a non-null but empty view (live empty-DB shape)', async () => {
    vi.resetModules();
    const EMPTY = {
      meta: { champion: 'house_gaussian', leadStation: 1, generatedAt: null, firstDay: null, lastDay: null, nStations: 0 },
      byLead: [], byStation: [], brierSeries: [],
    };
    vi.doMock('../src/lib/loaders.ts', () => ({ getDataAccuracy: async () => EMPTY }));
    const { default: DataPage } = await import('../src/app/(dash)/data/page.tsx');
    const html = renderToStaticMarkup(await DataPage());
    expect(html).toContain('No scored forecast data yet');
  });

  // Single-station guard: at exactly one qualifying station there is no best-vs-worst story, and rendering the
  // tables would hit the slice(-0)-returns-whole-array footgun (lone station mislabelled "worst", blank "best").
  // The `< 2` guard must route it to the graceful message.
  it('routes a single-station result to the graceful-empty state (no slice(-0) mislabel)', async () => {
    vi.resetModules();
    const ONE = {
      meta: { champion: 'house_gaussian', leadStation: 1, generatedAt: '2026-06-26T13:00:00Z', firstDay: '2026-06-13', lastDay: '2026-06-26', nStations: 1 },
      byLead: [{ lead: 1, n: 8, stations: 1, houseExact: 0.5, houseWithin1: 0.9, houseMiss: 0.5, marketExact: 0.5, marketWithin1: 0.9, marketMiss: 0.5 }],
      byStation: [{ city: 'madrid', region: 'europe-west', n: 8, exactPct: 0.5, within1Pct: 0.9, meanMiss: 0.5, marketWithin1Pct: 0.9, marketMeanMiss: 0.5 }],
      brierSeries: [],
    };
    vi.doMock('../src/lib/loaders.ts', () => ({ getDataAccuracy: async () => ONE }));
    const { default: DataPage } = await import('../src/app/(dash)/data/page.tsx');
    const html = renderToStaticMarkup(await DataPage());
    expect(html).toContain('No scored forecast data yet');
    expect(html).not.toContain('Hardest markets'); // the broken best/worst tables must NOT render
  });
});
