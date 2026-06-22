/**
 * SharpDisagreement (0049) narrative — renders the pure server component to static markup and pins the
 * review fixes: the "Agreement" claim must require all THREE calls present (not just a null-blind distinct
 * count, finding [2] false-agreement-on-null-bucket), and the sharp-vs-us delta must NOT print an exact
 * "N°C" when either endpoint is an open-ended tail bucket (finding [12]). renderToStaticMarkup needs no DOM.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharpDisagreement } from '../src/components/SharpDisagreement.tsx';
import type { SharpsView } from '../src/lib/loaders.ts';

function mk(overrides: Partial<SharpsView> = {}): SharpsView {
  return {
    hasSharp: true,
    address: '0x8fbd7cf5f806f563080864694415829f7229a959',
    label: 'badatmath.',
    asOfDate: '2026-06-22',
    targetDate: '2026-06-23',
    rank: 1,
    pnlUsd: 25000,
    sharpBucketIdx: 3,
    sharpLabel: '27°C',
    ourBucketIdx: 3,
    ourLabel: '27°C',
    marketBucketIdx: 3,
    marketLabel: '27°C',
    disagreement: 1,
    signedDeltaIdx: 0,
    positions: [],
    ...overrides,
  };
}
const render = (sharps: SharpsView): string => renderToStaticMarkup(SharpDisagreement({ sharps }));

describe('SharpDisagreement — narrative honesty', () => {
  it('claims agreement only when all three calls are present and equal', () => {
    const html = render(mk()); // all three = bucket 3, disagreement 1
    expect(html).toContain('Agreement.');
    expect(html).toContain('converge on the same bucket');
    expect(html).not.toContain('Partial read.');
  });

  it('does NOT claim agreement when the sharp has no bucket (only NO legs) — finding [2]', () => {
    // The killer regression: disagreement = count(distinct non-null) = 1 because only ONE call is non-null,
    // but the sharp's bucket is null. The pre-fix `distinct <= 1` rendered a false 3-way convergence.
    const html = render(mk({ sharpBucketIdx: null, sharpLabel: null, signedDeltaIdx: null, disagreement: 1 }));
    expect(html).not.toContain('Agreement.');
    expect(html).toContain('Partial read.');
    expect(html).toContain('no comparable Yes bucket');
  });

  it('does NOT claim agreement when no market_events row exists yet (all three null) — finding [2]', () => {
    const html = render(
      mk({
        sharpBucketIdx: null, sharpLabel: null,
        ourBucketIdx: null, ourLabel: null,
        marketBucketIdx: null, marketLabel: null,
        signedDeltaIdx: null, disagreement: 0,
      }),
    );
    expect(html).not.toContain('Agreement.');
    expect(html).toContain('Partial read.');
  });

  it('flags partial when our/market call is missing but the sharp has one', () => {
    const html = render(mk({ ourBucketIdx: null, ourLabel: null, marketBucketIdx: null, marketLabel: null, disagreement: 1 }));
    expect(html).not.toContain('Agreement.');
    expect(html).toContain('Partial read.');
    expect(html).toContain('isn’t priced');
  });

  it('shows a genuine disagreement with an exact °C delta in the whole-°C interior', () => {
    const html = render(
      mk({ sharpBucketIdx: 5, sharpLabel: '29°C', ourBucketIdx: 3, ourLabel: '27°C', signedDeltaIdx: 2, disagreement: 2 }),
    );
    expect(html).toContain('Disagreement.');
    expect(html).toContain('2°C warmer than our call');
  });

  it('drops the exact °C when an endpoint is an open-ended tail bucket — finding [12]', () => {
    const html = render(
      mk({ sharpBucketIdx: 0, sharpLabel: '25°C or below', ourBucketIdx: 3, ourLabel: '27°C', signedDeltaIdx: -3, disagreement: 2 }),
    );
    expect(html).toContain('Disagreement.');
    expect(html).toContain('colder than our call');
    expect(html).not.toContain('3°C colder'); // tail step is not a clean 3°C
  });

  it('labels a true three-way split when all three differ', () => {
    const html = render(
      mk({ sharpBucketIdx: 5, sharpLabel: '29°C', ourBucketIdx: 3, ourLabel: '27°C', marketBucketIdx: 4, marketLabel: '28°C', signedDeltaIdx: 2, disagreement: 3 }),
    );
    expect(html).toContain('Three-way split.');
  });

  it('renders the benchmark placeholder when the tracker has no position yet', () => {
    const html = render(mk({ hasSharp: false }));
    expect(html).toContain('hasn');
    expect(html).toContain('not a copy-trade');
    expect(html).not.toContain('Agreement.');
  });
});
