/**
 * /signals render smoke test — the flagship verdict explorer is a server component that composes the static
 * signals-findings record with the ONE live loader (dash_maker_exit, for the 12th-signal gate label). This
 * renders the whole tree to static markup on both the graceful-empty path (feed null → "pending") and the
 * populated path (a maker-exit fixture → the live gate label), proving it never throws and that every arc,
 * the twelve-ways ladder, the concrete confirmation, the hardening sweep, and the backlog sweep reach the DOM.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));

afterEach(() => vi.resetModules());

async function renderWith(getMakerExit: () => Promise<unknown>): Promise<string> {
  vi.doMock('../src/lib/loaders.ts', () => ({ getMakerExit }));
  const { default: SignalsPage } = await import('../src/app/(dash)/signals/page.tsx');
  const el = await SignalsPage();
  return renderToStaticMarkup(el);
}

const makerExitFixture = {
  generatedAt: '2026-07-04T09:00:00Z',
  view: {
    gate: {
      label: 'KILL',
      reason: 'ciLow below zero',
      nMarkets: 27,
      minMarkets: 40,
      nCities: 8,
      minCities: 6,
      nDistinctDays: 12,
      minDistinctDays: 7,
      winFrac: 0.62,
      meanNetReturn: 0.067,
      ciLow: -0.016,
      ciHigh: 0.12,
      zeroSkillPassRate: 0.032,
    },
  },
  gateSnapshot: null,
};

describe('/signals page renders', () => {
  it('graceful-empty path (feed null) never throws and shows the full record + pending live label', async () => {
    const html = await renderWith(async () => null);

    // headline + framing
    expect(html).toContain('The market measured efficient');
    expect(html).toContain('twelve ways');
    expect(html).toContain('Bottom line');

    // all three arcs
    expect(html).toContain('Arc 1');
    expect(html).toContain('Arc 2');
    expect(html).toContain('Forecast-free'); // structural arc heading

    // a representative lever from each arc + a load-bearing number rendered verbatim
    expect(html).toContain('Multi-day NWP blend');
    expect(html).toContain('1.33');
    expect(html).toContain('Maker-spray');
    expect(html).toContain('Complete-set structural arb');
    expect(html).toContain('Cross-venue RV');
    expect(html).toContain('capacity wall');

    // the twelve-ways ladder + the eleventh/twelfth ways
    expect(html).toContain('The twelve ways');
    expect(html).toContain('hardening sweep');
    expect(html).toContain('0/325');

    // the concrete confirmation + the two taxes
    expect(html).toContain('32.8pp');
    expect(html).toContain('15.4pp');

    // the backlog sweep
    expect(html).toContain('pre-registered backlog');
    expect(html).toContain('#12');

    // verdict + mechanism chips
    expect(html).toContain('KILL');
    expect(html).toContain('FAIL');
    expect(html).toContain('adverse selection');

    // the live row, feed absent → pending, NOT a live gate label
    expect(html).toContain('pending');
    expect(html).not.toContain('live §9R-E gate: KILL');
  });

  it('populated path renders the live §9R-E gate label from the dash_maker_exit fixture', async () => {
    const html = await renderWith(async () => makerExitFixture);
    expect(html).toContain('live §9R-E gate: KILL');
    expect(html).toContain('27/40 markets');
    // the static 12th-signal context still renders alongside the live label
    expect(html).toContain('Opening convergence');
    expect(html).toContain('gate of record');
  });
});
