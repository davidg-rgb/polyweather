/**
 * synoptic-nowcast handler — PGlite integration tests (0118, capture-only since
 * the 2026-07-25 resolution-oracle finding).
 *
 * THE LOAD-BEARING PIN here: the 5-min obs stream is NOT resolution-grade (WU's
 * table renders METAR/SPECI reports only — validated 66/66 winner-replication,
 * with the 5-min max EXCEEDING the METAR-table max on ~42% of days), so this
 * lane must NEVER write the resolution-grade `intraday_max` floor. That floor
 * belongs exclusively to metar-nowcast.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { synopticNowcast } from '../functions/synoptic-nowcast/handler.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

// Chicago 13:00 local (CDT) on Jul 25 — daytime, event targets today.
const NOW = new Date('2026-07-25T18:00:00Z');
const TOKEN = 'testtoken1234567890abcdef1234567';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

const ctx = (): JobCtx => ({
  db: port,
  config: { jobWallLimitSec: 150 } as JobCtx['config'],
  log: () => {},
  startedAt: NOW,
});

/** Minimal Synoptic v2 timeseries body for KORD. */
const synopticBody = (temps: (number | null)[], times: string[]) => ({
  SUMMARY: { RESPONSE_CODE: 1, RESPONSE_MESSAGE: 'OK' },
  STATION: [
    {
      STID: 'KORD',
      OBSERVATIONS: { date_time: times, air_temp_set_1: temps },
    },
  ],
});

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  await db.exec(`
    insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
    values ('chicago', 'Chicago', 'US', 'F', 'America/Chicago', 'na-central', now(), now());
    insert into stations (icao, country_code, tz, lat, lon, source) values ('KORD', 'US', 'America/Chicago', 41.97, -87.90, 'ourairports');
    insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
      select id, 'KORD', 'US', now(), true from cities where slug = 'chicago';
    insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
      select 'pe-jul25-chi', 'highest-temperature-in-chicago-on-july-25-2026', id, '2026-07-25', 'F', true from cities where slug = 'chicago';
  `);
});

afterAll(async () => {
  await db.close();
});

describe('synopticNowcast (capture-only)', () => {
  it('no token → clean no-op, no fetch', async () => {
    const stats = await synopticNowcast(ctx(), {
      fetchJson: async () => {
        throw new Error('must not be called');
      },
      now: NOW,
      token: undefined,
    });
    expect(stats.skipped).toBe('no_token');
    expect(stats.obsLogged).toBe(0);
  });

  it('logs raw 5-min obs — and NEVER touches the resolution-grade intraday_max floor', async () => {
    const stats = await synopticNowcast(ctx(), {
      fetchJson: async () => synopticBody([26.0, 27.2], ['2026-07-25T17:40:00Z', '2026-07-25T17:45:00Z']),
      now: NOW,
      token: TOKEN,
    });
    expect(stats).toMatchObject({
      stationsPolled: 1,
      stationsReturned: 1,
      obsLogged: 2,
    });

    // THE oracle-finding pin: a 5-min ob that would have "advanced the floor"
    // under 0118 must leave intraday_max untouched (resolution-grade only).
    const max = await rows(db, `select count(*)::int as n from intraday_max where icao = 'KORD'`);
    expect((max[0] as { n: number }).n).toBe(0);

    const logged = await rows(db, `select count(*)::int as n from synoptic_obs where icao = 'KORD'`);
    expect((logged[0] as { n: number }).n).toBe(2);
  });

  it('re-run with the same obs: idempotent (no re-log)', async () => {
    const stats = await synopticNowcast(ctx(), {
      fetchJson: async () => synopticBody([26.0, 27.2], ['2026-07-25T17:40:00Z', '2026-07-25T17:45:00Z']),
      now: NOW,
      token: TOKEN,
    });
    expect(stats.obsLogged).toBe(0);
    const logged = await rows(db, `select count(*)::int as n from synoptic_obs where icao = 'KORD'`);
    expect((logged[0] as { n: number }).n).toBe(2);
  });

  it('a pre-existing METAR-lane floor is never advanced by a HIGHER 5-min ob', async () => {
    // metar-nowcast (the resolution-grade writer) floors the day at 26.7°C/80F…
    await db.exec(`
      insert into intraday_max (icao, date_local, max_tenths_c, max_native, n_obs, last_obs_at)
      values ('KORD', '2026-07-25', 26.7, 80, 5, now());
    `);
    // …then a synoptic 5-min blip of 28.3°C (would be 83F — the overshoot class)
    const stats = await synopticNowcast(ctx(), {
      fetchJson: async () => synopticBody([28.3], ['2026-07-25T17:50:00Z']),
      now: NOW,
      token: TOKEN,
    });
    expect(stats.obsLogged).toBe(1);
    const max = await rows(
      db,
      `select max_tenths_c::text as t, max_native from intraday_max where icao = 'KORD' and date_local = '2026-07-25'`,
    );
    expect(Number((max[0] as { t: string }).t)).toBe(26.7); // METAR floor untouched
    expect((max[0] as { max_native: number }).max_native).toBe(80);
  });

  it('out-of-tier response (RESPONSE_CODE 2) is a quiet zero, not an error', async () => {
    const stats = await synopticNowcast(ctx(), {
      fetchJson: async () => ({ SUMMARY: { RESPONSE_CODE: 2, RESPONSE_MESSAGE: 'No stations found' } }),
      now: NOW,
      token: TOKEN,
    });
    expect(stats).toMatchObject({ stationsPolled: 1, stationsReturned: 0, obsLogged: 0 });
  });

  it('0119: capture logs around the clock — pre-dawn still logs obs', async () => {
    const NIGHT = new Date('2026-07-26T09:00:00Z'); // Chicago 04:00 local
    const stats = await synopticNowcast(ctx(), {
      fetchJson: async () => synopticBody([22.8], ['2026-07-26T08:55:00Z']),
      now: NIGHT,
      token: TOKEN,
    });
    expect(stats).toMatchObject({ stationsPolled: 1, obsLogged: 1 });
    const logged = await rows(db, `select count(*)::int as n from synoptic_obs where icao = 'KORD'`);
    expect((logged[0] as { n: number }).n).toBe(4); // 2 + 1 (blip test) + 1 night ob
  });

  it('a thrown fetch error never leaks the token', async () => {
    await expect(
      synopticNowcast(ctx(), {
        fetchJson: async () => {
          throw new Error(`HTTP 401 from api.synopticdata.com?token=${TOKEN}`);
        },
        now: NOW,
        token: TOKEN,
      }),
    ).rejects.toThrow(/TOKEN_REDACTED/);
    // and the redacted message must not contain the raw token
    try {
      await synopticNowcast(ctx(), {
        fetchJson: async () => {
          throw new Error(`boom ${TOKEN}`);
        },
        now: NOW,
        token: TOKEN,
      });
    } catch (err) {
      expect(String(err)).not.toContain(TOKEN);
    }
  });
});
