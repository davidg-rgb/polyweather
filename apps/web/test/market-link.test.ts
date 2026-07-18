/**
 * polymarketEventUrl — the /cities live-book permalink. The DB slug (dash_city_predictions 0107) is
 * authoritative and wins verbatim; a missing slug (pre-0107 RPC) falls back to reconstructing the canonical
 * full-month 'highest-temperature-in-{city}-on-{month}-{day}-{year}' slug from city + targetDate — the only
 * pattern the gamma parser admits into the capture universe. Malformed inputs yield null (no link), never a
 * fabricated URL.
 */
import { describe, expect, it } from 'vitest';
import { polymarketEventUrl } from '../src/lib/market-link.ts';

describe('polymarketEventUrl', () => {
  it('uses the DB event slug verbatim when present', () => {
    expect(polymarketEventUrl('highest-temperature-in-chongqing-on-july-18-2026', 'chongqing', '2026-07-18')).toBe(
      'https://polymarket.com/event/highest-temperature-in-chongqing-on-july-18-2026',
    );
  });

  it('reconstructs the canonical slug when the RPC predates 0107 (full month, no zero-pad on the day)', () => {
    expect(polymarketEventUrl(null, 'chongqing', '2026-07-18')).toBe(
      'https://polymarket.com/event/highest-temperature-in-chongqing-on-july-18-2026',
    );
    // single-digit day must NOT keep the ISO zero-pad ('july-8', never 'july-08')
    expect(polymarketEventUrl(undefined, 'seoul', '2026-07-08')).toBe(
      'https://polymarket.com/event/highest-temperature-in-seoul-on-july-8-2026',
    );
    // multi-word capture city slugs are already hyphenated — they pass straight through
    expect(polymarketEventUrl(null, 'kuala-lumpur', '2026-12-01')).toBe(
      'https://polymarket.com/event/highest-temperature-in-kuala-lumpur-on-december-1-2026',
    );
  });

  it('returns null (no link) on malformed inputs instead of fabricating a URL', () => {
    expect(polymarketEventUrl(null, '', '2026-07-18')).toBeNull();
    expect(polymarketEventUrl(null, 'seoul', 'not-a-date')).toBeNull();
    expect(polymarketEventUrl(null, 'seoul', '2026-13-01')).toBeNull(); // impossible month
  });
});
