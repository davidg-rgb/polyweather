/**
 * grading-lag against PGlite (the real migration chain) — pins the gate-day helper's two load-bearing properties:
 * (1) findWindowMarkets returns ONLY market_events whose target_date has PASSED (`< current_date`) and is still
 *     inside the PANEL_DAYS window — a today-dated market and an out-of-window market never appear; graded and
 *     ungraded both appear (the pure builder does the partitioning);
 * (2) buildGradingLagReport applies the gate scope, lists the resolved-but-ungraded markets, and computes the
 *     distinct-day impact — `isNewDay` is true only for a day with ZERO graded markets in-window, and
 *     `newDaysAtGrading` is the count of such days (the increment n_distinct_days would take once grading lands).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from '../../supabase/tests/harness.ts';
import { toPgliteParam } from '../lib/pglite-param.ts';
import type { ScriptDb } from '../lib/script-db.ts';
import { buildGradingLagReport, findWindowMarkets, type WindowMarket } from './grading-lag.ts';

let db: PGlite;
let sdb: ScriptDb;

async function seedCity(slug: string): Promise<void> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'NL', 'C', 'Europe/Amsterdam', 'europe-west', now(), now()) on conflict (slug) do nothing`,
    [slug],
  );
}

/**
 * dayOffset = whole days before today (target_date = current_date − offset); winningIdx null = ungraded.
 * `kind` lets two markets share a city+day without tripping the (city_id, target_date, kind) natural key.
 */
async function seedMarket(
  id: string,
  city: string,
  dayOffset: number,
  winningIdx: number | null,
  resolvedDaysAgo: number | null,
  closed: boolean,
  kind: 'highest' | 'lowest' = 'highest',
): Promise<void> {
  await seedCity(city);
  await db.query(
    `insert into market_events (poly_event_id, slug, city_id, kind, target_date, unit, ladder_ok,
                                winning_bucket_idx, resolved_at, closed)
     select 'pe-' || $1, 'ev-' || $1, id, $7, current_date - $3::int, 'C', true,
            $4::int,
            case when $5::int is null then null else now() - make_interval(days => $5::int) end,
            $6
       from cities where slug = $2`,
    [id, city, dayOffset, winningIdx, resolvedDaysAgo, closed, kind],
  );
}

const SCOPE = 'gl-scope-a';
const OUT = 'gl-out-b';

beforeAll(async () => {
  db = await freshDb();
  sdb = {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await db.query<T>(sql, params.map(toPgliteParam))).rows,
    end: async () => {},
  };

  // day D-2 (scope): one GRADED + one ungraded → day already in panel, grading adds markets only.
  // distinct `kind` so both share city+day under the (city_id, target_date, kind) natural key.
  await seedMarket('g1', SCOPE, 2, 1, 1, true, 'highest'); // graded
  await seedMarket('u1', SCOPE, 2, null, 1, true, 'lowest'); // ungraded, same day
  // day D-3 (scope): ungraded only → a NEW day, would +1 distinct day at grading.
  await seedMarket('u2', SCOPE, 3, null, null, false); // ungraded, resolved_at null (grading never ran)
  // day D-4 (OUT of scope): ungraded → excluded when scoped to bot.cities.
  await seedMarket('u3', OUT, 4, null, 2, true);
  // today's market (offset 0): NOT passed → never a window market.
  await seedMarket('today', SCOPE, 0, null, null, false);
  // outside the 21-day window (offset 30): excluded.
  await seedMarket('old', SCOPE, 30, null, 20, true);
});

afterAll(async () => {
  await db?.close();
});

describe('grading-lag — window selection + distinct-day impact', () => {
  it('findWindowMarkets returns only passed-and-in-window events (graded + ungraded), not today / not out-of-window', async () => {
    const w = await findWindowMarkets(sdb, 21);
    const byPoly = new Map(w.map((m) => [m.polyEventId, m]));
    expect([...byPoly.keys()].sort()).toEqual(['pe-g1', 'pe-u1', 'pe-u2', 'pe-u3']); // no pe-today, no pe-old
    expect(byPoly.get('pe-g1')!.graded).toBe(true);
    expect(byPoly.get('pe-u1')!.graded).toBe(false);
    expect(byPoly.get('pe-u2')!.resolvedAt).toBeNull(); // grading never ran, still a passed day
  });

  it('a tighter window (--days 3) drops the D-4 out-of-scope market by date', async () => {
    const w = await findWindowMarkets(sdb, 3);
    // D-4 (u3) is now outside the 3-day look-back; D-2/D-3 remain.
    expect(w.map((m) => m.polyEventId).sort()).toEqual(['pe-g1', 'pe-u1', 'pe-u2']);
  });

  it('scoped to bot.cities: lists in-scope ungraded, and only the day with zero graded markets is a NEW day', async () => {
    const w = await findWindowMarkets(sdb, 21);
    const r = buildGradingLagReport(w, 21, [SCOPE]); // OUT city excluded
    expect(r.ungraded.map((m) => m.polyEventId).sort()).toEqual(['pe-u1', 'pe-u2']);
    // D-3 has no graded market → NEW; D-2 already has g1 graded → not new.
    const byDay = new Map(r.days.map((d) => [d.targetDate, d]));
    expect(r.days.map((d) => d.targetDate)).toEqual([...r.days.map((d) => d.targetDate)].sort()); // ascending
    const newDays = r.days.filter((d) => d.isNewDay);
    expect(newDays).toHaveLength(1);
    expect(newDays[0]!.nUngraded).toBe(1);
    expect(newDays[0]!.cities).toEqual([SCOPE]);
    const notNew = r.days.find((d) => !d.isNewDay)!;
    expect(notNew.nUngraded).toBe(1); // u1
    expect(r.newDaysAtGrading).toBe(1);
    expect(byDay.size).toBe(2);
  });

  it('all-cities (scope null) also counts the out-of-scope day, so newDaysAtGrading rises', async () => {
    const w = await findWindowMarkets(sdb, 21);
    const r = buildGradingLagReport(w, 21, null);
    expect(r.ungraded.map((m) => m.polyEventId).sort()).toEqual(['pe-u1', 'pe-u2', 'pe-u3']);
    // D-3 and D-4 are both new (zero graded); D-2 is not.
    expect(r.newDaysAtGrading).toBe(2);
  });

  it('empty / all-graded windows are a clean no-lag report', () => {
    const graded: WindowMarket[] = [
      { eventId: 'x', polyEventId: 'pe-x', city: SCOPE, targetDate: '2026-07-01', resolvedAt: null, closed: true, graded: true },
    ];
    const r = buildGradingLagReport(graded, 21, [SCOPE]);
    expect(r.ungraded).toEqual([]);
    expect(r.days).toEqual([]);
    expect(r.newDaysAtGrading).toBe(0);
    expect(buildGradingLagReport([], 21, null).newDaysAtGrading).toBe(0);
  });
});
