/**
 * Migration 0117 (the forward cheap-early-entry paper loop) — the PGlite twin against the real migration chain.
 *
 * Pins: the cheap_early_panel snapshot round-trips via record_cheap_early_panel → dash_cheap_early
 * (operator-guarded); record_cheap_early_gate persists a forward §9R-E verdict with source='forward-cheap-early';
 * the extended bot_gate_snapshot source CHECK accepts the new value AND still rejects an unknown one; and — the
 * load-bearing SAFETY invariant — a cheap-early gate row (even label='PASS') is INVISIBLE to the exact
 * source='forward' read the live-capital interlock (trade_live_preflight) uses, so a paper panel can never unlock
 * real money. The config seeds (cities widening + pause) are present.
 *
 * Plus migration 0127 (the pre-registered variant sweep): cheap_early_city_hit_rates returns the top-K filter's
 * per-city {hitRate, graded} — honouring the graded floor, the day window, and the ungraded/mismatch exclusions
 * — and dash_operation carries the panel's `variants` block through to /operation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };

describe('0117 cheap-early paper loop — schema + RPCs + safety', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db?.close(); });

  it('cheap_early_panel round-trips: record_cheap_early_panel → dash_cheap_early (operator-guarded)', async () => {
    const view = { entries: [], gate: { label: 'INSUFFICIENT_DATA', nMarkets: 0 }, days: 21 };
    const ins = await rows<{ id: number }>(db, `select public.record_cheap_early_panel($1::jsonb) as id`, [JSON.stringify(view)]);
    expect(Number(ins[0]!.id)).toBeGreaterThan(0);

    // dash_cheap_early is operator-guarded → forbidden without the operator role …
    await expect(rows(db, `select public.dash_cheap_early() as out`)).rejects.toThrow();
    // … and returns the latest snapshot for the operator.
    const out = await asRole(db, 'authenticated', OPERATOR, async () =>
      (await rows<{ out: { view: { gate: { label: string } } } }>(db, `select public.dash_cheap_early() as out`))[0]!.out,
    );
    expect(out.view.gate.label).toBe('INSUFFICIENT_DATA');
  });

  it('the bot_gate_snapshot source CHECK is extended to allow forward-cheap-early (and still rejects unknowns)', async () => {
    // the new value is accepted …
    await expect(
      rows(db, `insert into public.bot_gate_snapshot (computed_at, mode, source, label) values (now(), 'paper', 'forward-cheap-early', 'KILL')`),
    ).resolves.toBeDefined();
    // … 'forward' + 'backtest' stay valid …
    await expect(
      rows(db, `insert into public.bot_gate_snapshot (computed_at, mode, source, label) values (now(), 'paper', 'forward', 'KILL')`),
    ).resolves.toBeDefined();
    // … and an unknown source is still rejected by the CHECK.
    await expect(
      rows(db, `insert into public.bot_gate_snapshot (computed_at, mode, source, label) values (now(), 'paper', 'forward-bogus', 'KILL')`),
    ).rejects.toThrow();
  });

  it('record_cheap_early_gate pins source=forward-cheap-early and mode=paper', async () => {
    const payload = { label: 'INSUFFICIENT_DATA', nMarkets: 12, nCities: 4, nDistinctDays: 5, meanNetReturn: 0.03, ciLow: -0.4, ciHigh: 0.5, zeroSkillPassRate: 0.2, reason: 'forward run continuing', totalNetUsd: -1.5, nOpen: 2 };
    const ins = await rows<{ id: number }>(db, `select public.record_cheap_early_gate($1::jsonb) as id`, [JSON.stringify(payload)]);
    const id = Number(ins[0]!.id);
    const [row] = await rows<{ mode: string; source: string; label: string; n_markets: number; total_net_usd: number }>(
      db, `select mode, source, label, n_markets, total_net_usd from public.bot_gate_snapshot where id = $1`, [id],
    );
    expect(row!.mode).toBe('paper');
    expect(row!.source).toBe('forward-cheap-early');
    expect(row!.n_markets).toBe(12);
    expect(Number(row!.total_net_usd)).toBeCloseTo(-1.5, 6);
  });

  it('SAFETY: a cheap-early PASS is INVISIBLE to the exact source=forward read the capital interlock uses', async () => {
    // Simulate the loop reaching a (paper) PASS and writing its gate row via the pinned-source RPC.
    await rows(db, `select public.record_cheap_early_gate($1::jsonb)`, [JSON.stringify({ label: 'PASS', nMarkets: 45, nCities: 6, nDistinctDays: 8, meanNetReturn: 0.2, ciLow: 0.05, ciHigh: 0.35, zeroSkillPassRate: 0.01, reason: 'PASS' })]);
    // trade_live_preflight reads: the LATEST bot_gate_snapshot WHERE mode='paper' AND source='forward'. That read
    // must NEVER surface the cheap-early PASS — the distinct source is the whole safety mechanism.
    const [gate] = await rows<{ label: string | null; source: string | null }>(
      db,
      `select label, source from public.bot_gate_snapshot
        where mode = 'paper' and source = 'forward'
        order by computed_at desc, id desc limit 1`,
    );
    // either there is no source='forward' row at all, or (if the CHECK test above inserted a 'forward' KILL) it is
    // NOT the cheap-early PASS — in no case does a cheap-early row satisfy the exact source='forward' filter.
    if (gate) {
      expect(gate.source).toBe('forward');
      expect(gate.label).not.toBe('PASS'); // the only 'forward' row inserted in this suite was a KILL
    }
    // and the cheap-early PASS is retrievable ONLY via its own distinct source.
    const [cheap] = await rows<{ label: string }>(
      db,
      `select label from public.bot_gate_snapshot
        where mode = 'paper' and source = 'forward-cheap-early'
        order by computed_at desc, id desc limit 1`,
    );
    expect(cheap!.label).toBe('PASS');
  });

  it('the config seeds are present (cities widening + the pause gate)', async () => {
    const cfg = await rows<{ key: string; value: string }>(
      db, `select key, value from public.config where key like 'cheap_early.%' order by key`,
    );
    const map = new Map(cfg.map((r) => [r.key, r.value]));
    expect(map.get('cheap_early.enabled')).toBe('1');
    expect(map.has('cheap_early.cities')).toBe(true);
    expect(JSON.parse(map.get('cheap_early.cities')!)).toEqual(['ankara', 'helsinki', 'kuala-lumpur', 'wellington']);
  });
  // ── 0127 · the variant sweep's inputs + read surface ──────────────────────────────────────────────
  /** Seed `n` graded predictions for a city, `hits` of them correct, starting `dayOffset` days back. */
  async function seedGrades(slug: string, opts: { n: number; hits: number; dayOffset?: number }): Promise<string> {
    const off = opts.dayOffset ?? 1;
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (await rows<{ city_id: string }>(
      db, `select city_id from public.upsert_city($1, $1, 'US', 'C', 'UTC', $2)`, [slug, region],
    ))[0]!.city_id;
    // winning_bucket_idx stays NULL so the 0106 grading trigger does not fold a competing row over ours.
    await rows(
      db,
      `insert into public.market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
       select 'pe-' || $1 || '-' || g, 'ev-' || $1 || '-' || g, $2::uuid, (current_date - ($3::int + g)), 'C', true
         from generate_series(1, $4::int) g`,
      [slug, cityId, off, opts.n],
    );
    await rows(
      db,
      `insert into public.city_prediction_grades (event_id, city, target_date, winner_idx, hit, mismatch)
       select me.id, $1, me.target_date, 0, (row_number() over (order by me.target_date)) <= $2::int, false
         from public.market_events me where me.city_id = $3::uuid`,
      [slug, opts.hits, cityId],
    );
    return cityId;
  }

  it('0127 cheap_early_city_hit_rates: per-city rate + graded count, honouring the floor and the window', async () => {
    const alpha = await seedGrades('alpha', { n: 10, hits: 6 }); // eligible: 6/10
    await seedGrades('beta', { n: 3, hits: 3 });                 // graded 3 < the min → omitted entirely
    await seedGrades('gamma', { n: 10, hits: 10, dayOffset: 60 }); // outside the 28-day window → omitted

    // an UNGRADED (hit null) and a MISMATCH row for alpha must be excluded from both the rate and the count.
    await rows(
      db,
      `insert into public.market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
       values ('pe-alpha-x', 'ev-alpha-x', $1::uuid, current_date - 20, 'C', true),
              ('pe-alpha-y', 'ev-alpha-y', $1::uuid, current_date - 21, 'C', true)`,
      [alpha],
    );
    await rows(
      db,
      `insert into public.city_prediction_grades (event_id, city, target_date, winner_idx, hit, mismatch)
       select me.id, 'alpha', me.target_date, 0,
              case when me.slug = 'ev-alpha-x' then null else true end,
              (me.slug = 'ev-alpha-y')
         from public.market_events me where me.slug in ('ev-alpha-x', 'ev-alpha-y')`,
    );

    const [out] = await rows<{ out: Record<string, { hitRate: number; graded: number }> }>(
      db, `select public.cheap_early_city_hit_rates(28, 8) as out`,
    );
    const map = out!.out;
    expect(Object.keys(map).sort()).toEqual(['alpha']);
    expect(Number(map.alpha!.graded)).toBe(10);
    expect(Number(map.alpha!.hitRate)).toBeCloseTo(0.6, 9);

    // the floor is a PARAMETER, not a constant — dropping it lets the small city through.
    const [loose] = await rows<{ out: Record<string, { graded: number }> }>(
      db, `select public.cheap_early_city_hit_rates(28, 3) as out`,
    );
    expect(Object.keys(loose!.out).sort()).toEqual(['alpha', 'beta']);
    // and the window is a parameter too — widening it surfaces the old city.
    const [wide] = await rows<{ out: Record<string, unknown> }>(
      db, `select public.cheap_early_city_hit_rates(180, 8) as out`,
    );
    expect(Object.keys(wide!.out).sort()).toEqual(['alpha', 'gamma']);
  });

  it('0127 cheap_early_city_hit_rates is service-role only (no browser session may read it)', async () => {
    await expect(
      asRole(db, 'authenticated', OPERATOR, async () => rows(db, `select public.cheap_early_city_hit_rates()`)),
    ).rejects.toThrow();
  });

  // ── 0128 · the slim capture read takes a SET of disjoint windows ─────────────────────────────────
  /** One event with a tick at each of the given hours-to-close, tagged by peak_mid = htc/100. */
  async function seedWindowSetEvent(city: string, htcs: number[]): Promise<void> {
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (await rows<{ city_id: string }>(
      db, `select city_id from public.upsert_city($1, $1, 'US', 'C', 'UTC', $2)`, [city, region],
    ))[0]!.city_id;
    const evId = (await rows<{ id: string }>(
      db,
      `insert into public.market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
       values ('pe-' || $1, 'ev-' || $1, $2::uuid, current_date, 'C', true) returning id`,
      [city, cityId],
    ))[0]!.id;
    // resolves_at is 1h out, so captured_at = resolves_at − htc puts each tick at exactly that hours-to-close.
    // hours_since_listing 0.5 makes the event FRESH (the min(...) < 1 allowlist filter).
    await rows(
      db,
      `insert into public.opening_captures
         (captured_at, event_id, city, target_date, tz_name, resolves_at, hours_since_listing, peak_mid, buckets)
       select now() + interval '1 hour' - (h || ' hours')::interval, $1::uuid, $2, current_date, 'UTC',
              now() + interval '1 hour', 0.5, h / 100.0, '[]'::jsonb
         from unnest($3::int[]) h`,
      [evId, city, htcs],
    );
  }

  /** the kept ticks, as their hours-to-close tags. `windows` null → the legacy 0126 two-scalar call shape. */
  async function keptHtcs(city: string, windows: number[] | null, lo = 12, hi = 36): Promise<number[]> {
    const arr = windows === null ? 'null::double precision[]' : `array[${windows.join(',')}]::double precision[]`;
    const [out] = await rows<{ out: { captures: { peakMid: number }[] | null } }>(
      db,
      `select public.cheap_early_capture_inputs(21, array[$1], ${lo}, ${hi}, ${arr}) as out`,
      [city],
    );
    return (out!.out.captures ?? []).map((c) => Math.round(Number(c.peakMid) * 100)).sort((a, b) => a - b);
  }

  it('0128 p_windows: EVERY window of the set is kept and the dead middle is dropped (+ the last tick, always)', async () => {
    // 30h → inside [24,36] · 20h → the dead middle the contiguous [12,36] union used to drag in · 13h → inside
    // [12,15] · 2h → out of every window but the event's LAST tick (the open-mark/winner-label lookup).
    await seedWindowSetEvent('winset', [30, 20, 13, 2]);

    expect(await keptHtcs('winset', [12, 15, 24, 36])).toEqual([2, 13, 30]);
    // the contiguous union is what 0126 could express — it reads the 20h tick nobody scores (the 2x row cost).
    expect(await keptHtcs('winset', null)).toEqual([2, 13, 20, 30]);
    // a single-pair p_windows behaves exactly like the old two-scalar window.
    expect(await keptHtcs('winset', [24, 36])).toEqual([2, 30]);
    // …and an empty/odd p_windows falls back to the scalars rather than returning the last tick alone.
    expect(await keptHtcs('winset', [])).toEqual([2, 13, 20, 30]);
    expect(await keptHtcs('winset', [24])).toEqual([2, 13, 20, 30]);
  });

  it('0128 the ±1h capture-cadence slack applies to EACH window of the set, not just the span', async () => {
    await seedWindowSetEvent('winslack', [16, 11, 23, 37, 19, 1]);
    // [12,15]±1 → 11 and 16 are in; [24,36]±1 → 23 and 37 are in; 19 (dead middle) is out; 1 is the last tick.
    expect(await keptHtcs('winslack', [12, 15, 24, 36])).toEqual([1, 11, 16, 23, 37]);
  });

  it('0128 cheap_early_capture_inputs is service-role only (no browser session may read it)', async () => {
    await expect(
      asRole(db, 'authenticated', OPERATOR, async () =>
        rows(db, `select public.cheap_early_capture_inputs(21, array['winset'])`),
      ),
    ).rejects.toThrow();
  });

  it("0127 dash_operation carries the panel's `variants` block through to /operation", async () => {
    const view = {
      days: 21,
      gate: { label: 'INSUFFICIENT_DATA', reason: 'accruing', nMarkets: 3, nCities: 2, meanNetReturn: -0.04 },
      money: { realizedPnlUsd: -1.2, roi: -0.06, winRate: 0.25 },
      variants: [
        { id: 'canonical', verdict: 'INSUFFICIENT', meanNetReturn: -0.04 },
        { id: 'survivor', verdict: 'INSUFFICIENT', meanNetReturn: 0.1 },
      ],
    };
    await rows(db, `select public.record_cheap_early_panel($1::jsonb)`, [JSON.stringify(view)]);
    const out = await asRole(db, 'authenticated', OPERATOR, async () =>
      (await rows<{ out: Record<string, unknown> }>(db, `select public.dash_operation() as out`))[0]!.out,
    );
    expect(Object.keys(out)).toContain('variants');
    expect(out.variants).toEqual(view.variants);
    // the 0125 body is otherwise intact — the benchmark block still reads the same snapshot.
    expect((out.benchmark as { gateLabel: string }).gateLabel).toBe('INSUFFICIENT_DATA');
  });
});
