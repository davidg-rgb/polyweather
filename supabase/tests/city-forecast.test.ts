/**
 * dash_city_forecast (0080) — the /paper-trade PRE-PLACEMENT forecast that completes the current-bet box.
 *
 * Exercises the RPC directly against the real migration chain (PGlite): per ACTIVE city it computes TODAY's
 * (city-local) intended whole-° call from the day's lead-1 cross-model mean (avg over all captures), trailing-30 debiased (the
 * verbatim city_sim_place_inputs / 0040/0041 correction), converted to the city's native unit, wuRounded, and
 * priced against today's live ladder — plus `alreadyPlacedToday` and the operator gate. Three cities cover
 * the load-bearing paths: Singapore (°C, ≥20 pairs → bias-corrected), Houston (°F, <20 pairs → raw-fallback
 * display + °C→°F conversion), and Lima (run window closed → omitted). `p_now` pins a deterministic "today".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const TODAY = '2026-06-15';
// 06:00Z ⇒ Singapore 14:00 (UTC+8), Houston 01:00 CDT (UTC−5), Lima 01:00 (UTC−5) — all still 2026-06-15.
const NOW = '2026-06-15T06:00:00Z';

// A Singapore-shaped °C ladder (whole-°C interior + open tails) — WSSS highs sit ~30–33°C.
const LADDER_C = [
  { idx: 0, label: '29°C or below', low: null as number | null, high: 29 as number | null },
  { idx: 1, label: '30°C', low: 30, high: 30 },
  { idx: 2, label: '31°C', low: 31, high: 31 },
  { idx: 3, label: '32°C', low: 32, high: 32 },
  { idx: 4, label: '33°C', low: 33, high: 33 },
  { idx: 5, label: '34°C or higher', low: 34, high: null },
];
// A Houston-shaped °F ladder (2°F interior pairs, even-start — the real Polymarket US convention).
const LADDER_F = [
  { idx: 0, label: '93°F or below', low: null as number | null, high: 93 as number | null },
  { idx: 1, label: '94-95°F', low: 94, high: 95 },
  { idx: 2, label: '96-97°F', low: 96, high: 97 },
  { idx: 3, label: '98-99°F', low: 98, high: 99 },
  { idx: 4, label: '100°F or higher', low: 100, high: null },
];

let db: PGlite;

async function seedCity(
  slug: string,
  displayName: string,
  cc: string,
  unit: 'C' | 'F',
  icao: string,
  tz: string,
  region: string,
  activeUntil: string | null,
): Promise<string> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $2, $3, $4, $5, $6, now(), now())`,
    [slug, displayName, cc, unit, tz, region],
  );
  await db.query(
    `insert into stations (icao, country_code, tz, source) values ($1, $2, $3, 'manual') on conflict (icao) do nothing`,
    [icao, cc, tz],
  );
  const cityId = (await rows<{ id: string }>(db, `select id from cities where slug = $1`, [slug]))[0]!.id;
  await db.query(
    `insert into city_sim_config (city_id, slug, icao, tz, arm_hours, forecast_max_hour, stake_usd, active, active_until)
     values ($1, $2, $3, $4, array[11,12,13,14]::smallint[], 12, 10, true, $5::date)`,
    [cityId, slug, icao, tz, activeUntil],
  );
  return cityId;
}

async function seedMarket(cityId: string, unit: 'C' | 'F', icao: string, ladder: typeof LADDER_C): Promise<string> {
  const ev = (
    await db.query<{ id: string }>(
      `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok)
       values ($1, $2, $3, $4, $5, 'highest', true) returning id`,
      [`poly-${icao}-${TODAY}`, `highest-temperature-in-${icao}-on-${TODAY}`, cityId, TODAY, unit],
    )
  ).rows[0]!;
  for (const b of ladder) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ev.id, b.idx, b.label, b.low, b.high, `c-${icao}-${b.idx}`, `y-${icao}-${b.idx}`, `n-${icao}-${b.idx}`],
    );
  }
  return ev.id;
}

async function seedAsk(eventId: string, bucketIdx: number, ask: number, capturedAt: string): Promise<void> {
  const bucket = (
    await rows<{ id: string }>(db, `select id from market_buckets where event_id = $1 and bucket_idx = $2`, [eventId, bucketIdx])
  )[0]!;
  await db.query(`insert into market_snapshots (bucket_id, best_ask, captured_at) values ($1, $2, $3)`, [bucket.id, ask, capturedAt]);
}

/** Seed N trailing (lead-1 forecast, finalized observation) pairs before TODAY with a fixed residual of 0. */
async function seedTrailingPairs(icao: string, unit: 'C' | 'F', n: number, fcC: number, obsNative: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const d = `2026-05-${String(i).padStart(2, '0')}`; // all < TODAY
    await db.query(
      `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
       values ($1, 'ecmwf_ifs025', $2::date, 1, $3, '10Z', 'forecast_api', ($2::date - interval '1 day'))`,
      [icao, d, fcC],
    );
    await db.query(
      `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
       values ($1, $2, $3, $4, 24, false, now())`,
      [icao, d, obsNative, unit],
    );
  }
}

beforeAll(async () => {
  db = await freshDb();

  // --- Singapore (°C): 22 trailing pairs (bias 0 → corrected), target-day lead-1 = 31.6°C → wuRound 32. ---
  const sg = await seedCity('singapore', 'Singapore', 'SG', 'C', 'WSSS', 'Asia/Singapore', 'southeast-asia', '2026-07-14');
  await seedTrailingPairs('WSSS', 'C', 22, 30.0, 30); // resid 0 → bias 0, n=22 ≥ 20 → trusted
  await db.query(
    `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
     values ('WSSS', 'ecmwf_ifs025', $1::date, 1, 31.6, '10Z', 'forecast_api', '2026-06-14T22:00:00Z')`,
    [TODAY],
  );
  const sgEv = await seedMarket(sg, 'C', 'WSSS', LADDER_C);
  await seedAsk(sgEv, 3, 0.5, '2026-06-15T02:00:00Z'); // older quote on idx3
  await seedAsk(sgEv, 3, 0.68, '2026-06-15T05:00:00Z'); // newest quote on idx3 → the one reported

  // --- Houston (°F): only 5 trailing pairs (< 20 → NOT trusted → raw display) + °C→°F conversion. ---
  // target-day lead-1 = 37.0°C → native 98.6°F → wuRound 99 → bucket idx3 (98-99°F).
  const hou = await seedCity('houston', 'Houston', 'US', 'F', 'KHOU', 'America/Chicago', 'na-central', '2026-07-14');
  await seedTrailingPairs('KHOU', 'F', 5, 35.0, 95);
  await db.query(
    `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
     values ('KHOU', 'ecmwf_ifs025', $1::date, 1, 37.0, '10Z', 'forecast_api', '2026-06-14T22:00:00Z')`,
    [TODAY],
  );
  const houEv = await seedMarket(hou, 'F', 'KHOU', LADDER_F);
  await seedAsk(houEv, 3, 0.12, '2026-06-15T05:00:00Z');

  // --- Lima (°C): active but run window CLOSED (active_until < today) → omitted from the payload. ---
  await seedCity('lima', 'Lima', 'PE', 'C', 'SPIM', 'America/Lima', 'latam', '2026-06-14');
});

afterAll(async () => {
  await db?.close();
});

async function forecast(): Promise<Record<string, unknown>> {
  return asRole(db, 'authenticated', OPERATOR, async () => {
    const r = await rows<{ v: Record<string, unknown> }>(db, `select public.dash_city_forecast($1::timestamptz) as v`, [NOW]);
    return r[0]!.v;
  });
}

describe('dash_city_forecast — per-city pre-placement forecast', () => {
  it('returns only active-and-in-window cities (Singapore + Houston; Lima excluded)', async () => {
    const out = await forecast();
    expect(out.generatedAt).toBeTruthy();
    const cities = out.cities as Record<string, unknown>[];
    expect(cities.map((c) => c.slug)).toEqual(['houston', 'singapore']); // ordered by slug; lima's window closed
  });

  it('Singapore (°C): bias-corrected center → wuRound 32, bucket label + latest ask', async () => {
    const sg = (await forecast()).cities as Record<string, unknown>[];
    const c = sg.find((x) => x.slug === 'singapore')!;
    expect(c.icao).toBe('WSSS');
    expect(c.unit).toBe('C');
    expect(c.targetDate).toBe(TODAY);
    expect(c.hasMarket).toBe(true);
    expect(Number(c.rawForecastC)).toBeCloseTo(31.6, 6);
    expect(Number(c.biasN)).toBe(22);
    expect(c.biasCorrected).toBe(true);
    expect(Number(c.biasC)).toBeCloseTo(0, 6);
    expect(Number(c.forecastC)).toBeCloseTo(31.6, 6);
    expect(Number(c.forecastNative)).toBeCloseTo(31.6, 6); // °C → no conversion
    expect(Number(c.predictedNative)).toBe(32); // wuRound(31.6)
    expect(c.label).toBe('32°C');
    expect(Number(c.ask)).toBeCloseTo(0.68, 6); // newest quote wins, not the 0.50
    expect(c.alreadyPlacedToday).toBe(false);
    expect(c.armHours).toEqual([11, 12, 13, 14]);
    expect(Number(c.forecastMaxHour)).toBe(12);
  });

  it('Houston (°F): <20 pairs → RAW display, °C→°F conversion → wuRound 99, 98-99°F @ 0.12', async () => {
    const hou = ((await forecast()).cities as Record<string, unknown>[]).find((x) => x.slug === 'houston')!;
    expect(hou.unit).toBe('F');
    expect(hou.biasCorrected).toBe(false); // only 5 pairs < 20 → not trusted
    expect(Number(hou.biasN)).toBe(5);
    expect(Number(hou.forecastC)).toBeCloseTo(37.0, 6); // raw mean shown (not NULLed)
    expect(Number(hou.forecastNative)).toBeCloseTo(98.6, 4); // 37.0°C → °F
    expect(Number(hou.predictedNative)).toBe(99); // wuRound(98.6)
    expect(hou.label).toBe('98-99°F');
    expect(Number(hou.ask)).toBeCloseTo(0.12, 6);
    expect(hou.hasMarket).toBe(true);
  });

  it('alreadyPlacedToday flips true once the tick has placed a bet for the day', async () => {
    const sgId = (await rows<{ id: string }>(db, `select id from cities where slug = 'singapore'`))[0]!.id;
    const evId = (
      await rows<{ id: string }>(db, `select id from market_events where city_id = $1 and target_date = $2`, [sgId, TODAY])
    )[0]!.id;
    await db.query(
      `insert into city_paper_bets
         (city_id, icao, unit, target_date, arm_hour, event_id, predicted_native, bucket_idx, label, ask, stake_usd, shares)
       values ($1, 'WSSS', 'C', $2, 11, $3, 32, 3, '32°C', 0.68, 10, 14.7)`,
      [sgId, TODAY, evId],
    );
    const sg = ((await forecast()).cities as Record<string, unknown>[]).find((x) => x.slug === 'singapore')!;
    expect(sg.alreadyPlacedToday).toBe(true);
  });

  it('is operator-gated (ERR_FORBIDDEN for a non-operator)', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.dash_city_forecast($1::timestamptz)`, [NOW]),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });

  it('returns a jsonb OBJECT (never a top-level array — the 0044 port trap)', async () => {
    const shape = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ outer: string; inner: string }>(
        db,
        `select jsonb_typeof(public.dash_city_forecast($1::timestamptz)) as outer,
                jsonb_typeof(public.dash_city_forecast($1::timestamptz)->'cities') as inner`,
        [NOW],
      );
      return r[0]!;
    });
    expect(shape).toEqual({ outer: 'object', inner: 'array' });
  });
});
