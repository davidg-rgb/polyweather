import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { isZombieEvent, type RawGammaEvent } from '../../packages/core/src/index.ts';
import { discoverMarkets } from '../functions/discover-markets/handler.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', 'research');
const TODAY = '2026-06-10'; // capture date of the tag fixtures

const page1 = JSON.parse(readFileSync(join(RESEARCH, 'gamma-events-tag104596-active.json'), 'utf8')) as RawGammaEvent[];
const page2 = JSON.parse(readFileSync(join(RESEARCH, 'gamma-events-tag104596-p2.json'), 'utf8')) as RawGammaEvent[];

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
});

afterAll(async () => {
  await db.close();
});

function makeDeps(pages: RawGammaEvent[][], alerts: Alert[], seeded?: string[]) {
  return {
    fetchPage: async (offset: number) => pages[Math.floor(offset / 100)] ?? [],
    notify: async (a: Alert) => {
      alerts.push(a);
      return true;
    },
    ...(seeded
      ? {
          seedDistribution: async (eventId: string) => {
            seeded.push(eventId);
            return true;
          },
        }
      : {}),
    todayUtcISO: TODAY,
  };
}

function makeCtx(): JobCtx {
  return {
    db: port,
    config: { jobWallLimitSec: 150 } as JobCtx['config'],
    log: () => {},
    startedAt: new Date(),
  };
}

describe('discover-markets (§6.13)', () => {
  const alerts: Alert[] = [];
  const seeded: string[] = [];
  let stats: Record<string, unknown>;
  const expectedZombies = [...page1, ...page2].filter((e) => isZombieEvent(e, TODAY)).length;

  it('paginates both fixture pages (stops on the short page) and ingests the universe', async () => {
    stats = await discoverMarkets(makeCtx(), makeDeps([page1, page2], alerts, seeded));

    expect(stats['eventsSeen']).toBe(136);
    expect(stats['zombies']).toBe(expectedZombies);
    expect(expectedZombies).toBeGreaterThanOrEqual(2); // at least the two captured Jinan zombies

    const live = 136 - expectedZombies - (stats['parseFailures'] as number);
    expect(stats['eventsNew']).toBe(live);
    expect(stats['bucketsUpserted']).toBe(live * 11);

    // §6.13: unparseable events with a KNOWN city are stored FLAGGED (ladder_ok
    // false, zero buckets); unknown-city failures are alert-only.
    const flaggedNoBuckets = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from market_events me
       where me.ladder_ok = false
         and not exists (select 1 from market_buckets b where b.event_id = me.id)`,
    );
    const evCount = await rows<{ n: number }>(db, `select count(*)::int as n from market_events`);
    expect(evCount[0]!.n).toBe(live + flaggedNoBuckets[0]!.n);
    expect(flaggedNoBuckets[0]!.n).toBeLessThanOrEqual(stats['parseFailures'] as number);
    const bkCount = await rows<{ n: number }>(db, `select count(*)::int as n from market_buckets`);
    expect(bkCount[0]!.n).toBe(live * 11);
  });

  it('new cities arrive betting-disabled with a WARN alert each (~49-city universe)', async () => {
    const cities = await rows<{ n: number }>(db, `select count(*)::int as n from cities`);
    expect(cities[0]!.n).toBeGreaterThanOrEqual(45); // §14 P2 DoD: ~49 cities
    const enabled = await rows(db, `select 1 from cities where betting_enabled`);
    expect(enabled.length).toBe(0);
    const newCityAlerts = alerts.filter((a) => a.kind === 'NEW_CITY');
    expect(newCityAlerts.length).toBe(cities[0]!.n);
    expect(newCityAlerts[0]!.severity).toBe('WARN');
  });

  it('stations resolve with coordinates pending (provisional rows) and current mappings', async () => {
    const stations = await rows<{ n: number }>(db, `select count(*)::int as n from stations`);
    expect(stations[0]!.n).toBeGreaterThanOrEqual(45); // §14 P2 DoD: stations for ≥45 cities
    const mapped = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from city_stations where valid_to is null`,
    );
    const cityCount = (await rows(db, `select 1 from cities`)).length;
    // cities whose resolutionSource didn't parse stay unmapped (unverified path — never guess)
    expect(mapped[0]!.n).toBeGreaterThanOrEqual(45);
    expect(mapped[0]!.n).toBeLessThanOrEqual(cityCount);
    // every event is seeded with a distribution callback exactly once
    expect(seeded.length).toBe(stats['eventsNew']);
  });

  it('re-run is idempotent: no new events, no duplicate buckets, no station churn', async () => {
    const alerts2: Alert[] = [];
    const stats2 = await discoverMarkets(makeCtx(), makeDeps([page1, page2], alerts2));
    expect(stats2['eventsNew']).toBe(0);
    expect(stats2['stationsChanged']).toBe(0);
    expect(alerts2.filter((a) => a.kind === 'NEW_CITY').length).toBe(0);
    const bkCount = await rows<{ n: number }>(db, `select count(*)::int as n from market_buckets`);
    expect(bkCount[0]!.n).toBe(stats['bucketsUpserted']);
  });

  it('station-change simulation (§15): altered resolutionSource → suspend + CRITICAL + history row', async () => {
    // pre-condition: enable betting for seoul as if the operator had verified it
    await db.exec(`update cities set betting_enabled = true where slug = 'seoul'`);

    const seoulIdx = page1.findIndex((e) => e.slug.includes('-seoul-'));
    const altIdx = seoulIdx >= 0 ? 0 : 1;
    const source = seoulIdx >= 0 ? page1 : page2;
    const target = structuredClone(source[seoulIdx >= 0 ? seoulIdx : altIdx]!) as RawGammaEvent;
    const altered = structuredClone(target) as RawGammaEvent;
    altered.resolutionSource = 'https://www.wunderground.com/history/daily/kr/seoul/RKSS';
    for (const m of altered.markets) m.resolutionSource = altered.resolutionSource;

    const alerts3: Alert[] = [];
    const stats3 = await discoverMarkets(makeCtx(), makeDeps([[altered]], alerts3));
    expect(stats3['stationsChanged']).toBe(1);

    const critical = alerts3.filter((a) => a.kind === 'STATION_CHANGE');
    expect(critical.length).toBe(1);
    expect(critical[0]!.severity).toBe('CRITICAL');

    const city = await rows<{ betting_enabled: boolean }>(db, `select betting_enabled from cities where slug = 'seoul'`);
    expect(city[0]!.betting_enabled).toBe(false); // suspended

    const history = await rows<{ icao: string; valid_to: string | null; verified: boolean }>(
      db,
      `select cs.icao, cs.valid_to, cs.verified from city_stations cs
       join cities c on c.id = cs.city_id where c.slug = 'seoul' order by cs.valid_from`,
    );
    expect(history.length).toBe(2);
    expect(history[0]!.icao).toBe('RKSI');
    expect(history[0]!.valid_to).not.toBeNull(); // old row closed
    expect(history[1]!.icao).toBe('RKSS');
    expect(history[1]!.valid_to).toBeNull();
    expect(history[1]!.verified).toBe(false);

    // the provisional RKSS station row exists (lat/lon pending seed-stations)
    const station = await rows<{ lat: number | null }>(db, `select lat from stations where icao = 'RKSS'`);
    expect(station.length).toBe(1);
    expect(station[0]!.lat).toBeNull();
  });

  it('closes events Gamma stopped returning once 2+ days past target', async () => {
    const city = await rows<{ id: string }>(db, `select id from cities where slug = 'seoul'`);
    await db.query(
      `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, closed)
       values ('ghost-1', 'highest-temperature-in-seoul-on-june-1-2026', $1, '2026-06-01', 'C', true, false)`,
      [city[0]!.id],
    );
    const alerts4: Alert[] = [];
    const stats4 = await discoverMarkets(makeCtx(), makeDeps([[]], alerts4));
    expect(stats4['closedByUs']).toBeGreaterThanOrEqual(1);
    const ghost = await rows<{ closed: boolean }>(db, `select closed from market_events where poly_event_id = 'ghost-1'`);
    expect(ghost[0]!.closed).toBe(true);
  });

  it('zombie events never reach the database', async () => {
    const jinan = await rows(db, `select 1 from cities where slug = 'jinan'`);
    expect(jinan.length).toBe(0);
  });
});
