/**
 * /efficiency render smoke test — the page is a server component that composes two RPC loaders +
 * the static findings record. This renders the whole tree to static markup with the loaders mocked
 * (empty/fixture data) to prove (a) it never throws on the graceful-empty and populated paths, and
 * (b) every curated lever + section actually reaches the DOM. It also writes the rendered HTML (with
 * globals.css inlined) to the scratchpad so the layout can be eyeballed without an authenticated
 * session (the live tiles populate against the real DB in prod).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// A small calibration fixture so the live skill tiles + reliability diagram populate with realistic
// numbers (market slightly sharper → skillVsMarket negative — the measured-efficiency read).
vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));
vi.mock('../src/lib/loaders.ts', () => ({
  getCalibrationView: async () => ({
    champion: 'house_gaussian',
    scores: [
      { city: 'amsterdam', cityId: '1', source: 'house_gaussian', lead: 1, window: '30Z', brier: 0.362, brierMarket: 0.341, bootstrapP: 0.2, ece: 0.048, sharpness: 0.2, n: 120, reliability: [{ bin: 0.2, hit: 0.21, n: 40 }, { bin: 0.5, hit: 0.48, n: 50 }, { bin: 0.8, hit: 0.83, n: 30 }] },
      { city: 'paris', cityId: '2', source: 'house_gaussian', lead: 1, window: '30Z', brier: 0.371, brierMarket: 0.352, bootstrapP: 0.3, ece: 0.052, sharpness: 0.2, n: 110, reliability: [{ bin: 0.3, hit: 0.28, n: 45 }, { bin: 0.6, hit: 0.62, n: 35 }] },
      { city: 'madrid', cityId: '3', source: 'house_gaussian', lead: 1, window: '30Z', brier: 0.358, brierMarket: 0.349, bootstrapP: 0.4, ece: 0.041, sharpness: 0.2, n: 95, reliability: [{ bin: 0.4, hit: 0.39, n: 40 }] },
    ],
  }),
  getAmsterdamSim: async () => ({ overall: { marketHitRate: 0.83, nGradedAll: 42, truthHitRate: 0.79, nTruthAll: 38 } }),
}));

describe('/efficiency page renders', () => {
  it('renders end-to-end and every curated lever reaches the DOM', async () => {
    const { default: EfficiencyPage } = await import('../src/app/(dash)/efficiency/page.tsx');
    const el = await EfficiencyPage();
    const html = renderToStaticMarkup(el);

    // headline + framing
    expect(html).toContain('The verdict');
    expect(html).toContain('signals falsified');
    expect(html).toContain('every lever, falsified');

    // all three arcs
    expect(html).toContain('Arc 1');
    expect(html).toContain('Arc 2');
    expect(html).toContain('Arc 3');

    // a representative lever from each arc (apostrophe-free substrings)
    expect(html).toContain('Multi-day NWP blend');
    expect(html).toContain('Intraday nowcast');
    expect(html).toContain('Running-max');
    expect(html).toContain('Maker-spray');
    expect(html).toContain('Complete-set structural arb');
    expect(html).toContain('Forecast-free reward farming');
    expect(html).toContain('Cross-venue RV');
    expect(html).toContain('capacity wall');

    // the live grounding tiles populated from the fixture (market sharper → negative skill text present)
    expect(html).toContain('0.36'); // our Brier
    expect(html).toContain('83%'); // live Amsterdam hit rate from the fixture

    // the eleventh-way sweep + methodology
    expect(html).toContain('hardened at executable depth');
    expect(html).toContain('Lane C2');
    expect(html).toContain('executable-depth lens');

    // verdict chips render
    expect(html).toContain('KILL');
    expect(html).toContain('FAIL');

    // Opt-in: when EFFICIENCY_PREVIEW_OUT is set, write a standalone preview (markup + globals.css)
    // for a visual eyeball without an authenticated session. Off by default so `pnpm test` writes nothing.
    const out = process.env.EFFICIENCY_PREVIEW_OUT;
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
