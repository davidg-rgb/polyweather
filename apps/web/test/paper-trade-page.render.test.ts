/**
 * /paper-trade render smoke test — the page is now a pure static-asset server component (no DB round trip):
 * the per-city "$10 on our predicted high, bought cheap, held to close" archive-backtest table
 * (core/sim/city-buy-table-results) + the pre-registered "45-City Scan" companion section
 * (core/sim/city-scan-results). Renders the whole tree to static markup to prove (a) it never throws, (b) the
 * honest KILL verdict + the pooled/per-city figures reach the DOM, (c) the lead curve and per-city table render
 * every city, and (d) the 45-City Scan appendix still renders. Mirrors efficiency-page.render.test.ts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CITY_BUY_TABLE } from '@weather-edge/core';
import PaperTradePage from '../src/app/(dash)/paper-trade/page.tsx';

const html = renderToStaticMarkup(PaperTradePage());

describe('/paper-trade page renders — per-city buy table + 45-City Scan', () => {
  it('renders the honest KILL verdict headline with the pooled figures', () => {
    expect(html).toContain('Per-city buy table');
    expect(html).toContain('Verdict: a net loss');
    expect(html).toContain('-28.2pp'); // pooled ROI (ASCII hyphen via fmtDelta)
    expect(html).toContain('$977'); // pooled net (signedUsd prefixes a U+2212 minus, so match the magnitude)
    expect(html).toContain('signal #12'); // names the falsified signal
    expect(html).toContain('already falsified');
    expect(html).toContain('Nothing here reopens');
  });

  it('renders the summary strip: sweet-spot lead, cities net-positive, window', () => {
    expect(html).toContain('Sweet-spot entry');
    expect(html).toContain('16'); // net-positive cities count
    expect(html).toContain('small-sample longshot noise');
    expect(html).toContain('2026-05-14'); // window start
    expect(html).toContain('2026-06-30'); // window end
  });

  it('renders the "peak time" lead curve — negative at every lead, sweet-spot marked', () => {
    expect(html).toContain('peak time'); // section heading (curly quotes around it render as chars)
    expect(html).toContain('sweet-spot');
    for (const l of CITY_BUY_TABLE.leadCurve) {
      expect(html, `lead ${l.leadH}h ROI`).toContain(`${l.roiPct.toFixed(1)}pp`);
    }
  });

  it('renders the per-city table: header, every city row, and the pooled footer', () => {
    expect(html).toContain('net by lead'); // the sparkline column header
    expect(html).toContain('Per-city results @ 24h sweet-spot');
    // first (best) and last (worst) rows are present
    expect(html).toContain('Jeddah');
    expect(html).toContain('New York');
    // all cities in the record reach the DOM
    for (const r of CITY_BUY_TABLE.rows) expect(html, `row ${r.city}`).toContain(r.display);
    // pooled footer row
    expect(html).toContain('POOLED');
  });

  it('renders the reproduce/method block naming the source script', () => {
    expect(html).toContain('city-buy-table.py');
    expect(html).toContain('bias corrected on prior data only'); // no-hyphen convention (calibration invariant)
    expect(html).toContain('executable ask');
  });

  it('still renders the 45-City Scan companion section with its golden candidate figures', () => {
    expect(html).toContain('45-City Scan');
    expect(html).toContain('ankara');
    expect(html).toContain('houston');
    expect(html).toContain('candidate');
    expect(html).toContain('$44.88'); // ankara TEST net
    expect(html).toContain('$12.04'); // houston TEST net
    expect(html).toContain('Read this before trusting the two candidates');
  });
});
