import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { fetchActuals } from '../functions/fetch-actuals/handler.ts';
import { metarNowcast } from '../functions/metar-nowcast/handler.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', 'research');
const rksiObs = JSON.parse(readFileSync(join(RESEARCH, 'wunderground_api_v1_obs_historical_RKSI_2026-06-09.json'), 'utf8'));
const metarFx = JSON.parse(readFileSync(join(RESEARCH, 'aviationweather_metar_RKSI.json'), 'utf8'));
const era5Fx = JSON.parse(readFileSync(join(RESEARCH, 'openmeteo_era5_archive_daily_RKSI.json'), 'utf8'));
const wuHtml = readFileSync(join(RESEARCH, 'wunderground_history_RKSI_2026-06-09.html'), 'utf8');

// Seoul 01:30 local on Jun 10 — Jun 9 ended >1h ago; only Jun 9.. are candidates.
const NOW = new Date('2026-06-09T16:30:00Z');

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
const alerts: Alert[] = [];
const gradedIds: string[] = [];

const ctx = (): JobCtx => ({
  db: port,
  config: { jobWallLimitSec: 150 } as JobCtx['config'],
  log: () => {},
  startedAt: NOW,
});

const baseDeps = () => ({
  fetchText: async () => wuHtml,
  notify: async (a: Alert) => (alerts.push(a), true),
  gradeEvent: async (id: string) => (gradedIds.push(id), { graded: true }),
  now: NOW,
  omArchiveBase: 'https://archive-api.open-meteo.com',
});

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  await db.exec(`
    insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
    values ('seoul', 'Seoul', 'KR', 'C', 'Asia/Seoul', 'east-asia', now(), now());
    insert into stations (icao, country_code, tz, lat, lon, source) values ('RKSI', 'KR', 'Asia/Seoul', 37.46, 126.44, 'ourairports');
    insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
      select id, 'RKSI', 'KR', now(), true from cities where slug = 'seoul';
    insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
      select 'pe-jun9', 'highest-temperature-in-seoul-on-june-9-2026', id, '2026-06-09', 'C', true from cities where slug = 'seoul';
  `);
});

afterAll(async () => {
  await db.close();
});

describe('fetch-actuals (§6.15)', () => {
  it('runtime WU key extraction + provisional upsert, then finalization with cross-checks and grading', async () => {
    const urls: string[] = [];
    const stats = await fetchActuals(ctx(), {
      ...baseDeps(),
      fetchJson: async (url: string) => {
        urls.push(url);
        if (url.includes('aviationweather')) return metarFx;
        if (url.includes('mesonet')) return { data: [{ station: 'RKSI', max_tmpf: 78.0 }] };
        if (url.includes('archive-api')) return era5Fx;
        return rksiObs; // WU obs for the date AND the next-day probe
      },
    });

    // the key was extracted from the page source, never hardcoded
    const key = await rows<{ value: string }>(db, `select value from config where key = 'wuApiKey'`);
    expect(key[0]!.value).toMatch(/^[a-f0-9]{32}$/);
    expect(urls.some((u) => u.includes(`apiKey=${key[0]!.value}`))).toBe(true);
    expect(urls.some((u) => u.includes('/RKSI:9:KR/'))).toBe(true);
    expect(urls.some((u) => u.includes('units=m'))).toBe(true); // °C city

    // 4 candidate local days (Jun 6-9) are over at Seoul 01:30 Jun-10; the stub
    // serves the same fixture for each, so all four upsert+finalize. Only the
    // Jun-9 event exists, so exactly one grading fires.
    expect(stats['observationsUpserted']).toBe(4);
    expect(stats['finalized']).toBe(4);
    expect(stats['graded']).toBe(1);
    expect(gradedIds.length).toBe(1);

    const obs = (await rows<{
      tmax_wu_native: number; provisional: boolean; tmax_metar_native: number | null;
      tmax_iem_f: string | null; tmax_era5_c: string | null; divergence_flags: string[] | null;
    }>(db, `select tmax_wu_native, provisional, tmax_metar_native, tmax_iem_f, tmax_era5_c, divergence_flags
            from observations where icao = 'RKSI' and date_local = '2026-06-09'`))[0]!;
    expect(obs.tmax_wu_native).toBe(25); // fixture daily max
    expect(obs.provisional).toBe(false);
    // METAR fixture covers Jun 9 local tail: max 20 °C → divergence −5 flagged
    expect(obs.tmax_metar_native).toBe(20);
    expect(obs.divergence_flags).toContain('metar-5');
    expect(Number(obs.tmax_iem_f)).toBe(78); // 25°C = 77°F vs IEM 78°F → within 2°F, no iem flag
    expect(obs.tmax_era5_c).not.toBeNull();
    expect(stats['divergences']).toBe(1);
    expect(alerts.some((a) => a.kind === 'DATA_DIVERGENCE')).toBe(true);
  });

  it('finalized dates are skipped on re-run (local-day-over gating holds)', async () => {
    const stats = await fetchActuals(ctx(), {
      ...baseDeps(),
      fetchJson: async () => {
        throw new Error('should not be called for finalized dates');
      },
    });
    expect(stats['observationsUpserted']).toBe(0);
    expect(stats['finalized']).toBe(0);
  });

  it('401 forces a key refresh and retries once', async () => {
    // age the key cache so freshness does not short-circuit, then a 401 path
    await db.exec(`update config set value = '2026-06-01T00:00:00Z' where key = 'wuKeyFetchedAt'`);
    await db.exec(`delete from observations where icao = 'RKSI'`); // make Jun 9 a candidate again
    let wuCalls = 0;
    const stats = await fetchActuals(ctx(), {
      ...baseDeps(),
      fetchJson: async (url: string) => {
        if (url.includes('api.weather.com')) {
          wuCalls++;
          if (wuCalls === 1) throw new Error('HTTP 401 from api.weather.com');
          return rksiObs;
        }
        if (url.includes('aviationweather')) return metarFx;
        if (url.includes('mesonet')) return { data: [] };
        if (url.includes('archive-api')) return era5Fx;
        return rksiObs;
      },
    });
    expect(wuCalls).toBeGreaterThanOrEqual(2); // failed call + retried call
    expect(stats['finalized']).toBe(4);
  });

  it('key-refresh failure goes CRITICAL but keeps the stale key', async () => {
    await db.exec(`update config set value = '2026-06-01T00:00:00Z' where key = 'wuKeyFetchedAt'`);
    const before = alerts.filter((a) => a.kind === 'WU_KEY').length;
    await fetchActuals(ctx(), {
      ...baseDeps(),
      fetchText: async () => {
        throw new Error('page unreachable');
      },
      fetchJson: async () => rksiObs,
    });
    expect(alerts.filter((a) => a.kind === 'WU_KEY').length).toBe(before + 1);
    const key = await rows(db, `select 1 from config where key = 'wuApiKey'`);
    expect(key.length).toBe(1); // stale key retained
  });
});

describe('metar-nowcast (§6.15)', () => {
  // Seoul daytime during Jun 10 (fixture METAR covers Jun 10 local までmax 23).
  const NOON = new Date('2026-06-10T03:00:00Z'); // Seoul 12:00 local

  beforeAll(async () => {
    await db.exec(`
      insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
      select 'pe-jun10', 'highest-temperature-in-seoul-on-june-10-2026', id, '2026-06-10', 'C', true
      from cities where slug = 'seoul';
    `);
    const ev = await rows<{ id: string }>(db, `select id from market_events where poly_event_id = 'pe-jun10'`);
    await db.query(
      `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs)
       values ($1, 'house_gaussian', 0, false, now(), 'h-now', '{0.5,0.5}')`,
      [ev[0]!.id],
    );
  });

  it('daytime selection + ONE batched call + monotone intraday + rebuild hook', async () => {
    const urls: string[] = [];
    const rebuilt: string[] = [];
    const deps = {
      fetchJson: async (url: string) => (urls.push(url), metarFx),
      now: NOON,
      rebuildNowcast: async (id: string) => (rebuilt.push(id), true),
    };

    const stats = await metarNowcast(ctx(), deps);
    expect(urls.length).toBe(1); // batched
    expect(urls[0]).toContain('ids=RKSI');
    expect(stats['maxesAdvanced']).toBe(1);
    expect(stats['nowcastsRebuilt']).toBe(1);
    expect(rebuilt.length).toBe(1);

    const im = (await rows<{ max_tenths_c: string; max_native: number }>(
      db,
      `select max_tenths_c, max_native from intraday_max where icao = 'RKSI' and date_local = '2026-06-10'`,
    ))[0]!;
    expect(Number(im.max_tenths_c)).toBe(23); // fixture Jun-10 Seoul running max
    expect(im.max_native).toBe(23);

    // same data again → max did NOT advance → no rebuild
    const again = await metarNowcast(ctx(), deps);
    expect(again['maxesAdvanced']).toBe(0);
    expect(again['nowcastsRebuilt']).toBe(0);
  });

  it('night/offday stations are skipped entirely', async () => {
    const earlyMorning = new Date('2026-06-09T20:00:00Z'); // Seoul 05:00 — before 06
    const stats = await metarNowcast(ctx(), {
      fetchJson: async () => {
        throw new Error('no call expected');
      },
      now: earlyMorning,
    });
    expect(stats['stationsPolled']).toBe(0);
  });
});
