/**
 * scripts/wallet-forensics.test — the silent-truncation guard (crawlMissedHistory).
 *
 * Regression for a real defect: a --persist run terminated early under Polymarket rate-limiting, fetched
 * only the last ~week of /activity, yet reported mode='full' + exit 0 — and persisted a partial snapshot
 * ($5.9k / 199 bets) as if it were the lifetime forensic (+$25.4k / 9,156 bets). crawlMissedHistory catches
 * it by cross-checking the crawl's earliest fill against the user-pnl ground-truth curve's span (which the
 * tool fetches in one un-paged call), so an incomplete crawl is flagged, refused for --persist, and exits
 * non-zero. Importing the script does NOT run main() (it is guarded behind the import.meta.url check).
 */
import { describe, expect, it } from 'vitest';
import { crawlIncomplete, crawlMissedHistory } from './wallet-forensics.ts';
import type { UserPnlPoint } from '../packages/io/src/polymarket-wallet.ts';

const sec = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
/** A ground-truth curve whose history begins on `firstDay` and ends 2026-06-22. */
const pnl = (firstDay: string): UserPnlPoint[] => [
  { t: sec(firstDay), cumPnlUsd: -10 },
  { t: sec('2026-06-22'), cumPnlUsd: 25_000 },
];

describe('crawlMissedHistory — silent-truncation guard', () => {
  it('FLAGS a full crawl whose earliest fill is far after the user-pnl start (the rate-limit truncation)', () => {
    // the exact shape of the bad persist: pnl starts 2026-01-11, crawl only reached back to 2026-06-15.
    expect(crawlMissedHistory(pnl('2026-01-11'), '2026-06-15', 'full')).toBe(true);
  });

  it('ACCEPTS a full crawl whose earliest fill matches the user-pnl start (a true lifetime crawl)', () => {
    expect(crawlMissedHistory(pnl('2026-01-11'), '2026-01-10', 'full')).toBe(false);
  });

  it('ACCEPTS a small gap within the default 7-day tolerance', () => {
    expect(crawlMissedHistory(pnl('2026-01-11'), '2026-01-14', 'full')).toBe(false);
  });

  it('FLAGS a full crawl that fetched nothing (windowFrom null)', () => {
    expect(crawlMissedHistory(pnl('2026-01-11'), null, 'full')).toBe(true);
  });

  it('also flags a CAPPED crawl that missed history', () => {
    expect(crawlMissedHistory(pnl('2026-01-11'), '2026-06-15', 'capped')).toBe(true);
  });

  it('NEVER flags an explicit --from window (short by design)', () => {
    expect(crawlMissedHistory(pnl('2026-01-11'), '2026-06-15', 'window')).toBe(false);
  });

  it('does NOT flag when there is no ground-truth curve to compare against', () => {
    expect(crawlMissedHistory([], '2026-06-15', 'full')).toBe(false);
  });

  it('respects a custom tolerance', () => {
    // a 30-day gap passes a 60-day tolerance but fails the default.
    expect(crawlMissedHistory(pnl('2026-05-16'), '2026-06-15', 'full', 60)).toBe(false);
    expect(crawlMissedHistory(pnl('2026-05-16'), '2026-06-15', 'full')).toBe(true);
  });
});

describe('crawlIncomplete — the persist guard (review fix [6]: --from masks hitCap in the mode)', () => {
  it('a clean full / window crawl is complete', () => {
    expect(crawlIncomplete('full', false, false)).toBe(false);
    expect(crawlIncomplete('window', false, false)).toBe(false); // legitimate short --from window
  });

  it('a capped crawl is incomplete', () => {
    expect(crawlIncomplete('capped', true, false)).toBe(true);
  });

  it('a --from WINDOW that exhausts the page cap is INCOMPLETE (the masked case)', () => {
    // mode='window' (from took precedence) but hitCap=true → the older tail was dropped. Must be flagged so
    // --persist is refused; the pre-fix `mode === 'capped' || missedHistory` returned false here.
    expect(crawlIncomplete('window', true, false)).toBe(true);
  });

  it('an early-terminated full crawl (missedHistory) is incomplete', () => {
    expect(crawlIncomplete('full', false, true)).toBe(true);
  });
});
