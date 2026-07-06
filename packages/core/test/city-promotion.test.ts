/**
 * core/sim/city-promotion — the continuous winner-promotion board (CITY-LIVE Lane P). Pins the frozen criteria:
 * the eligibility floors (nBets ≥ 20 AND nDays ≥ 10 AND entry-watch 'sufficient'), PROMOTED requiring the
 * recommended arm's edgeCiLo > 0, DEMOTED hysteresis keyed on prevStatus, WATCH vs INSUFFICIENT, the deterministic
 * rank + slug tiebreak, self-explaining reasons, and the total/deterministic contract on junk/empty input.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCityPromotionBoard,
  CITY_PROMOTION_MIN_BETS,
  CITY_PROMOTION_MIN_DAYS,
  type CityPromotionBoard,
  type CityPromotionInput,
  type CityPromotionStatus,
} from '../src/sim/city-promotion.ts';

type Bet = CityPromotionInput['cities'][number]['bets'][number];
type City = CityPromotionInput['cities'][number];

/** One graded bet on `hour`, on distinct day `day`, with book-consistent P&L (win = stake·(1/ask−1), loss = −stake). */
function bet(won: boolean, ask: number, hour: number, day: number): Bet {
  return {
    won,
    ask,
    armHour: hour,
    targetDate: `2026-07-${String(day).padStart(2, '0')}`,
    pnlUsd: won ? 10 * (1 / ask - 1) : -10,
    stakeUsd: 10,
  };
}

/** `w` wins then `l` losses on one arm hour, each on its OWN distinct day (nDays === nBets for the arm). */
function arm(hour: number, w: number, l: number, ask: number, startDay = 1): Bet[] {
  const out: Bet[] = [];
  let day = startDay;
  for (let i = 0; i < w; i++) out.push(bet(true, ask, hour, day++));
  for (let i = 0; i < l; i++) out.push(bet(false, ask, hour, day++));
  return out;
}

/** `w` wins + `l` losses on one arm but spread across only `nDistinctDays` days (to fail the nDays floor). */
function armFewDays(hour: number, w: number, l: number, ask: number, nDistinctDays: number): Bet[] {
  const results = [...Array<boolean>(w).fill(true), ...Array<boolean>(l).fill(false)];
  return results.map((won, i) => bet(won, ask, hour, (i % nDistinctDays) + 1));
}

function city(slug: string, bets: Bet[], prevStatus?: CityPromotionStatus): City {
  return { cityId: `id-${slug}`, slug, icao: slug.toUpperCase().slice(0, 4), unit: 'C', bets, prevStatus };
}

function board(cities: City[], asOf = '2026-07-06T00:00:00Z'): CityPromotionBoard {
  return buildCityPromotionBoard({ asOf, cities });
}

const rowFor = (b: CityPromotionBoard, slug: string) => b.rows.find((r) => r.slug === slug)!;

describe('buildCityPromotionBoard — criteria, ranking, totality', () => {
  it('exposes the frozen floor constants', () => {
    expect(CITY_PROMOTION_MIN_BETS).toBe(20);
    expect(CITY_PROMOTION_MIN_DAYS).toBe(10);
  });

  it('PROMOTED requires ALL floors (nBets ≥ 20, nDays ≥ 10, sufficient) — each failure demotes to WATCH with a reason', () => {
    const b = board([
      city('promoted', arm(13, 18, 2, 0.5)), // 20 bets / 20 days / sufficient / edge +0.40 → PROMOTED
      city('fewbets', arm(13, 11, 1, 0.5)), // 12 bets < 20 (but strong+sufficient) → WATCH
      city('fewdays', armFewDays(13, 18, 2, 0.5, 9)), // 20 bets but 9 days < 10 → WATCH
      city('notsure', [...arm(11, 6, 6, 0.1), ...arm(12, 30, 0, 0.7)]), // two arms, leader not separated → provisional → WATCH
    ]);

    const promoted = rowFor(b, 'promoted');
    expect(promoted.status).toBe('PROMOTED');
    expect(promoted.recommendedHour).toBe(13);
    expect(promoted.watchConfidence).toBe('sufficient');
    expect(promoted.edgeCiLo!).toBeGreaterThan(0);
    expect(promoted.reasons.join(' ')).toMatch(/PROMOTED/);

    const fewbets = rowFor(b, 'fewbets');
    expect(fewbets.status).toBe('WATCH');
    expect(fewbets.nBets).toBe(12);
    expect(fewbets.reasons).toContain('nBets 12 < 20');

    const fewdays = rowFor(b, 'fewdays');
    expect(fewdays.status).toBe('WATCH');
    expect(fewdays.nBets).toBe(20);
    expect(fewdays.nDays).toBe(9);
    expect(fewdays.reasons).toContain('nDays 9 < 10');

    const notsure = rowFor(b, 'notsure');
    expect(notsure.status).toBe('WATCH'); // recommended arm 12 has point edge +0.30 > 0
    expect(notsure.watchConfidence).toBe('provisional');
    expect(notsure.reasons).toContain('entry-watch provisional < sufficient');
  });

  it('PROMOTED requires the recommended arm to be credibly +EV — a coin-flip arm is never promoted even with a deep, wide sample', () => {
    // 40 bets over 40 days, but the recommended arm is a 20/20 coin flip → edgeCiLo ≤ 0 → not 'sufficient' → not eligible.
    const b = board([city('coinflip', arm(13, 20, 20, 0.5))]);
    const r = rowFor(b, 'coinflip');
    expect(r.nBets).toBe(40);
    expect(r.nDays).toBe(40);
    expect(r.status).not.toBe('PROMOTED');
    expect(r.edgeCiLo!).toBeLessThanOrEqual(0);
    expect(r.watchConfidence).not.toBe('sufficient');
  });

  it('DEMOTED is hysteresis — only a previously-PROMOTED city with a now-negative edge demotes; same numbers without that history → INSUFFICIENT', () => {
    const losingArm = arm(13, 4, 16, 0.5); // edge −0.30, edgeCiLo < 0, 20 bets / 20 days

    const demoted = rowFor(board([city('faller', losingArm, 'PROMOTED')]), 'faller');
    expect(demoted.status).toBe('DEMOTED');
    expect(demoted.edgeCiLo!).toBeLessThan(0);
    expect(demoted.reasons.join(' ')).toMatch(/DEMOTED \(was PROMOTED\)/);

    const notDemoted = rowFor(board([city('fresh', losingArm)]), 'fresh'); // no prevStatus
    expect(notDemoted.status).toBe('INSUFFICIENT');

    const wasWatch = rowFor(board([city('wasw', losingArm, 'WATCH')]), 'wasw'); // prevStatus not PROMOTED
    expect(wasWatch.status).toBe('INSUFFICIENT');
  });

  it('WATCH vs INSUFFICIENT splits on the sign of the recommended arm point edge (any n)', () => {
    const b = board([
      city('watchthin', arm(13, 2, 1, 0.5)), // 3 bets, edge +0.1667 > 0, thin → WATCH
      city('insuffthin', arm(13, 1, 2, 0.5)), // 3 bets, edge −0.1667 ≤ 0 → INSUFFICIENT
    ]);
    expect(rowFor(b, 'watchthin').status).toBe('WATCH');
    expect(rowFor(b, 'insuffthin').status).toBe('INSUFFICIENT');
  });

  it('ranks PROMOTED (edgeCiLo desc) → WATCH → INSUFFICIENT → DEMOTED, with a deterministic slug tiebreak', () => {
    const b = board([
      city('demote', arm(13, 4, 16, 0.5), 'PROMOTED'), // DEMOTED
      city('insuff', []), // INSUFFICIENT (no bets)
      city('watchy', arm(13, 11, 1, 0.5)), // WATCH (12 bets < 20)
      city('bravo', arm(13, 16, 4, 0.5)), // PROMOTED, edgeCiLo ~+0.12
      city('alpha', arm(13, 18, 2, 0.5)), // PROMOTED, edgeCiLo ~+0.27 (higher → ranks first)
    ]);
    expect(b.rows.map((r) => r.slug)).toEqual(['alpha', 'bravo', 'watchy', 'insuff', 'demote']);
    expect(b.rows.map((r) => r.status)).toEqual(['PROMOTED', 'PROMOTED', 'WATCH', 'INSUFFICIENT', 'DEMOTED']);
    // within-PROMOTED order is by edgeCiLo desc, so alpha's lower bound beats bravo's.
    expect(rowFor(b, 'alpha').edgeCiLo!).toBeGreaterThan(rowFor(b, 'bravo').edgeCiLo!);
  });

  it('ties on status + edgeCiLo break deterministically by slug asc', () => {
    // identical ledgers → identical edgeCiLo → slug decides. Input order deliberately reversed.
    const b = board([city('zulu', arm(13, 18, 2, 0.5)), city('alpha', arm(13, 18, 2, 0.5))]);
    expect(b.rows.map((r) => r.slug)).toEqual(['alpha', 'zulu']);
    expect(rowFor(b, 'alpha').edgeCiLo).toBe(rowFor(b, 'zulu').edgeCiLo);
    expect(b.rows.every((r) => r.status === 'PROMOTED')).toBe(true);
  });

  it('every row carries a non-empty, self-explaining reason', () => {
    const b = board([
      city('promoted', arm(13, 18, 2, 0.5)),
      city('watchy', arm(13, 11, 1, 0.5)),
      city('insuff', []),
      city('demote', arm(13, 4, 16, 0.5), 'PROMOTED'),
    ]);
    expect(b.rows.every((r) => r.reasons.length > 0 && r.reasons.every((s) => s.length > 0))).toBe(true);
    expect(rowFor(b, 'insuff').reasons.join(' ')).toMatch(/no graded bets/i);
  });

  it('empty / degenerate inputs never throw — 0 bets, all-lost, missing cities all resolve to a total board', () => {
    // empty cities
    expect(board([]).rows).toEqual([]);
    // missing/undefined cities array
    expect(buildCityPromotionBoard({ asOf: '2026', cities: undefined as unknown as City[] }).rows).toEqual([]);
    // whole input undefined
    expect(buildCityPromotionBoard(undefined as unknown as CityPromotionInput)).toEqual({ asOf: '', rows: [] });

    // a single city with zero graded bets → INSUFFICIENT, all edge fields null, recommendedHour null.
    const empty = rowFor(board([city('empty', [])]), 'empty');
    expect(empty.status).toBe('INSUFFICIENT');
    expect(empty.nBets).toBe(0);
    expect(empty.nDays).toBe(0);
    expect(empty.recommendedHour).toBeNull();
    expect(empty.edge).toBeNull();
    expect(empty.edgeCiLo).toBeNull();
    expect(empty.edgeCiHi).toBeNull();
    expect(empty.watchConfidence).toBe('insufficient');

    // all-lost city → negative net P&L, negative edge, INSUFFICIENT.
    const lost = rowFor(board([city('lost', arm(13, 0, 5, 0.5))]), 'lost');
    expect(lost.status).toBe('INSUFFICIENT');
    expect(lost.netPnlUsd).toBe(-50);
    expect(lost.edge!).toBeLessThan(0);
  });

  it('is deterministic and total — junk hours/asks are dropped, malformed cities filtered, same input twice is identical', () => {
    const cities: City[] = [
      city('nanhour', [
        ...arm(13, 15, 5, 0.5),
        { won: true, ask: Number.NaN, armHour: Number.NaN, targetDate: '2026-07-30', pnlUsd: 0, stakeUsd: 10 },
        { won: true, ask: 1.5, armHour: 13, targetDate: '2026-07-31', pnlUsd: 0, stakeUsd: 10 }, // bad ask dropped by armEdgeStats
      ]),
      { slug: undefined as unknown as string, cityId: 'x', icao: 'X', unit: 'C', bets: arm(13, 20, 0, 0.5) }, // no slug → filtered out
    ];
    const a = buildCityPromotionBoard({ asOf: 'z', cities });
    const c = buildCityPromotionBoard({ asOf: 'z', cities });
    expect(a).toEqual(c); // reproducible (seeded bootstrap, no Date.now)
    expect(a.rows.map((r) => r.slug)).toEqual(['nanhour']); // slug-less city removed
    // the bad-ask bet still counts toward the city ledger total, but the NaN-hour bet cannot form an arm.
    const nan = rowFor(a, 'nanhour');
    expect(nan.recommendedHour).toBe(13);
    expect(nan.edgeCiLo).not.toBeNull();
  });
});
