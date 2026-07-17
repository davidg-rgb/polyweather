/**
 * /cities render smoke test — the page is a server component composing ONE RPC loader
 * (dash_city_predictions) and the client CitiesTable. Renders the whole tree to static markup with the
 * loader mocked to prove (a) it never throws, (b) the table rows + tiles + the buy-window highlight + the
 * small-n grey rule + the no-open-market panel all reach the DOM, and (c) the staged-dark path renders.
 */
import { wilsonInterval } from '@weather-edge/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/** The page's conservative-upside formula, recomputed independently for dynamic expectations. */
const upsideStr = (hits: number, n: number, ask: number): string => {
  const v = wilsonInterval(hits, n).lo / ask - 1;
  return `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
};

vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));

const iso = (hoursFromNow: number): string => new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
const utcDate = (daysFromNow: number): string =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

const FIXTURE = {
  generatedAt: new Date().toISOString(),
  config: { leadMinH: 2, leadMaxH: 12, priceCap: 0.4 },
  stats: [
    // seoul: well-sampled strong rate (green, in the open table)
    { city: 'seoul', displayName: 'Seoul', unit: 'C', n: 18, hits: 11, rate: 0.6111, lastGradedDate: '2026-07-16' },
    // denver: small n (must render grey + n visible, in the open table)
    { city: 'denver', displayName: 'Denver', unit: 'F', n: 3, hits: 1, rate: 0.3333, lastGradedDate: '2026-07-15' },
    // amsterdam: graded history but NO open market (must land in the idle panel)
    { city: 'amsterdam', displayName: 'Amsterdam', unit: 'C', n: 15, hits: 6, rate: 0.4, lastGradedDate: '2026-07-16' },
  ],
  rows: [
    // inside the [2,12]h buy window → rec-row highlight + the "window" pill
    {
      city: 'seoul', displayName: 'Seoul', unit: 'C', targetDate: utcDate(0),
      resolvesAt: iso(5.5), capturedAt: iso(-0.1),
      predIdx: 4, predLabel: '31°C', predProb: 0.44, ask: 0.38,
    },
    // outside the window (tomorrow, ~29h) — no highlight
    {
      city: 'denver', displayName: 'Denver', unit: 'F', targetDate: utcDate(1),
      resolvesAt: iso(29.7), capturedAt: iso(-0.2),
      predIdx: 2, predLabel: '88-89°F', predProb: 0.31, ask: 0.12,
    },
    // unseeded capture — prediction cell renders the honest "unseeded", not a fabricated pick
    {
      city: 'perth', displayName: 'Perth', unit: 'C', targetDate: utcDate(1),
      resolvesAt: iso(20), capturedAt: iso(-0.05),
      predIdx: null, predLabel: null, predProb: null, ask: null,
    },
  ],
};

describe('/cities page renders', () => {
  it('renders end-to-end with the populated fixture and surfaces every section', async () => {
    vi.doMock('../src/lib/loaders.ts', () => ({ getCityPredictions: async () => FIXTURE }));
    const { default: CitiesPage } = await import('../src/app/(dash)/cities/page.tsx');
    const html = renderToStaticMarkup(await CitiesPage());

    // header + tiles
    expect(html).toContain('Cities — prediction table');
    expect(html).toContain('3 open markets');
    expect(html).toContain('3 cities tracked');
    expect(html).toContain('In buy window');

    // the table: city, prediction + house prob, ask in cents, time to close, rate with n
    expect(html).toContain('Seoul');
    expect(html).toContain('31°C');
    expect(html).toContain('44% house');
    expect(html).toContain('38¢');
    expect(html).toContain('5.5h');
    expect(html).toContain('61%');
    expect(html).toContain('(n=18)');

    // the buy-window highlight: seoul (5.5h) is inside [2,12]h → rec-row + pill; denver (29.7h) is not
    expect(html).toContain('rec-row');
    expect(html).toContain('>window<');
    expect(html).toContain('29.7h');

    // small-n honesty: denver renders its rate in the muted grey, n visible
    expect(html).toContain('(n=3)');
    expect(html).toContain('var(--ams-muted)');

    // unseeded capture renders the honest empty state, not a fabricated pick
    expect(html).toContain('unseeded');

    // the sortable headers render with the default time-to-close ascending sort + idle arrows
    expect(html).toContain('aria-sort="ascending"'); // the active 'time to close' column
    expect(html).toContain('upside /$1'); // the new metric column header
    expect(html).toContain('↕'); // inactive columns advertise sortability

    // the conservative-upside column: values recomputed independently from the fixture
    // seoul: wilson95lo(11,18)/0.38 − 1 (≈ +2%) — a well-sampled record near its ask
    expect(html).toContain(upsideStr(11, 18, 0.38));
    // denver: wilson95lo(1,3)/0.12 − 1 (≈ −49%) — the thin-record longshot sinks, muted under the n floor
    expect(html).toContain(upsideStr(1, 3, 0.12));
    // perth has no ask and no history → the em-dash cell (null upside)
    expect(html).toContain('needs both a graded history and a live ask');
    // the footnote pins the metric's honesty framing
    expect(html).toContain('deliberately conservative');
    expect(html).toContain('Wilson-95% lower');

    // "all available cities" literal: amsterdam has no open market → the idle panel
    expect(html).toContain('No open market right now');
    expect(html).toContain('Amsterdam');

    // the footnote documents the /data difference (the handoff's cross-check note)
    expect(html).toContain('NOT /data');
    expect(html).toContain('bucket-win');

    // optional unauthenticated eyeball (the DATA_PREVIEW_OUT idiom from data-page.render.test.ts)
    const out = process.env.CITIES_PREVIEW_OUT;
    if (out) {
      const css = readFileSync('apps/web/src/app/globals.css', 'utf8');
      const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div class="shell"><main>${html}</main></div></body></html>`;
      try {
        writeFileSync(out, doc);
      } catch {
        /* preview is best-effort */
      }
    }
  });

  it('the day tabs + window toggle render (client component SSR)', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({ getCityPredictions: async () => FIXTURE }));
    const { default: CitiesPage } = await import('../src/app/(dash)/cities/page.tsx');
    const html = renderToStaticMarkup(await CitiesPage());
    expect(html).toContain('>all</button>');
    expect(html).toContain('>today</button>');
    expect(html).toContain('>tomorrow</button>');
    expect(html).toContain('in buy window');
  });

  it('renders the staged-dark state when the loader returns null (0106 not applied / RPC error)', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({ getCityPredictions: async () => null }));
    const { default: CitiesPage } = await import('../src/app/(dash)/cities/page.tsx');
    const html = renderToStaticMarkup(await CitiesPage());
    expect(html).toContain('Cities — prediction table');
    expect(html).toContain('0106_city_predictions.sql');
  });

  it('renders gracefully with zero open rows but populated stats (every city idle)', async () => {
    vi.resetModules();
    const IDLE = { ...FIXTURE, rows: [] };
    vi.doMock('../src/lib/loaders.ts', () => ({ getCityPredictions: async () => IDLE }));
    const { default: CitiesPage } = await import('../src/app/(dash)/cities/page.tsx');
    const html = renderToStaticMarkup(await CitiesPage());
    expect(html).toContain('No open captured markets right now');
    expect(html).toContain('No open market right now'); // all three cities land in the idle panel
    expect(html).toContain('Seoul');
  });
});
