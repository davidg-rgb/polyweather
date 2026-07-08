/**
 * google-repoint-parity (0088/0089) — the CROSS-PATH parity check the depth-capture v2 cutover needs.
 *
 * WHY THIS EXISTS (WS-B ∩ WS-D, loop C14). The v2 repoint moves the /convergence Google forward-paper panel off
 * `opening_captures` (google_paper_inputs_opening) onto the dedicated `market_depth` table (google_paper_inputs,
 * the guarded cutover). DEPTH-CAPTURE-V2-HANDOFF.md §6.3 makes the live parity check a POST-DEPLOY step — it can't
 * run until the operator applies 0089/0088 and depth accrues. But the load-bearing question is answerable OFFLINE
 * and BEFORE the deploy: given the SAME logical event with the SAME ladder + exec-price trajectory, does the
 * depth-path RPC drive `buildGoogleView` to the SAME panel decision as the preserved opening_captures path?
 *
 * This is NOT the population question (the handoff's documented caveat — the depth fresh cohort is SMALLER because
 * `depth-capture` only walks discover-ingested buckets at 5×/day vs opening-capture's 2-min Gamma poll, so it
 * catches the <1h flat-open less often). That difference is about which events ENTER the panel in production. THIS
 * test isolates the other half: for a shared in-population event, the cutover must be BEHAVIOR-PRESERVING — same
 * bucketing, same entry, same take-profit exit, same P&L, same §9R-E gate. If a SQL key-name/anchor/ladder bug in
 * the rewritten 0088 changed the panel's computation, this catches it before the operator ever applies it.
 *
 * The parity is asserted on the ENGINE output (buildGoogleView), NOT the raw RPC jsonb — the two RPCs deliberately
 * differ on the convergence-signal fields the GOOGLE engine ignores (peakMid/isFlatOpen/houseSeeded/houseProb): the
 * depth path hard-defaults them, the opening path carries the stored values. We PROVE both sources were genuinely
 * exercised (the raw signal-fields differ) AND that the panel decision is identical regardless.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from './harness.ts';
import { buildGoogleView, googleCfg } from '../../packages/core/src/index.ts';

const SLUG = 'pf_city';
const EVENT = '55555555-5555-5555-5555-555555555555';
const ICAO = 'PFTS';
const B = [
  'a0000000-0000-0000-0000-000000000000', // idx 0 — "20°C or below"
  'a1111111-1111-1111-1111-111111111111', // idx 1 — "21°C"  (the Google-predicted bucket)
  'a2222222-2222-2222-2222-222222222222', // idx 2 — "22°C or higher"
];
const LABELS = ['20°C or below', '21°C', '22°C or higher'];

// Two ticks anchored to a fixed listing time so BOTH paths report the SAME hoursSinceListing:
//   • opening_captures stores hours_since_listing as numeric(6,2); the depth path computes it as float8 from
//     captured_at − gamma_created_at. 18 min = 0.30h and 33 min = 0.55h both land EXACTLY on 2 decimals, so the
//     numeric(6,2) round-trip and the float8 compute agree to the bit — no precision skew in the reported entryAgeH.
const now = new Date();
const gamma = new Date(now.getTime() - 40 * 60_000); // listing 40 min ago
const t1 = new Date(gamma.getTime() + 18 * 60_000); // entry tick — age 0.30h (< 1 fresh, < 24 age gate)
const t2 = new Date(gamma.getTime() + 33 * 60_000); // exit tick  — age 0.55h
// target_date +2d ⇒ resolvesAt (target 12:00 UTC) is in the future ⇒ market unresolved, but the take-profit fires
// at t2 so the trade is REALIZED either way (resolution unused). Also keeps the entry inside the purchase window
// [opening, resolvesAt − 20h].
const targetDate = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
const resolvesAt = `${targetDate}T12:00:00Z`;

/** exec ladder per tick — identical numbers seeded into BOTH sources, so any engine-decision divergence is a bug. */
const LADDER = {
  // idx 1 (the predicted bucket): entry ask 0.11 ∈ [0.10, 0.12]; at t2 its execBid 0.35 ≥ tpAbs 0.30 → take-profit.
  t1: [
    { idx: 0, best_bid: 0.78, best_ask: 0.8, exec_ask: 0.82, exec_bid: 0.76, depth_usd: 500 },
    { idx: 1, best_bid: 0.1, best_ask: 0.11, exec_ask: 0.11, exec_bid: 0.1, depth_usd: 340 },
    { idx: 2, best_bid: 0.03, best_ask: 0.05, exec_ask: 0.06, exec_bid: 0.02, depth_usd: 200 },
  ],
  t2: [
    { idx: 0, best_bid: 0.72, best_ask: 0.75, exec_ask: 0.77, exec_bid: 0.7, depth_usd: 480 },
    { idx: 1, best_bid: 0.35, best_ask: 0.37, exec_ask: 0.37, exec_bid: 0.35, depth_usd: 400 },
    { idx: 2, best_bid: 0.02, best_ask: 0.04, exec_ask: 0.05, exec_bid: 0.01, depth_usd: 180 },
  ],
} as const;

const ageOf = (t: Date) => Math.round(((t.getTime() - gamma.getTime()) / 3_600_000) * 100) / 100;

/** one opening_captures tick row (camelCase — the record_opening_captures / RPC shape). */
function openingTick(t: Date, ladder: readonly { idx: number; best_bid: number; best_ask: number; exec_ask: number; exec_bid: number; depth_usd: number }[]) {
  return {
    capturedAt: t.toISOString(),
    eventId: EVENT,
    city: SLUG,
    targetDate,
    tzName: 'America/Chicago',
    createdAtGamma: gamma.toISOString(),
    resolvesAt,
    hoursSinceListing: ageOf(t),
    // DISTINCTIVE convergence-signal values → prove the opening path was truly exercised (the depth path nulls these).
    peakMid: 0.5,
    isFlatOpen: true,
    houseSeeded: true,
    evVol24h: 1000,
    negRisk: false,
    buckets: ladder.map((b) => ({
      idx: b.idx,
      label: LABELS[b.idx],
      bestAsk: b.best_ask,
      execAsk: b.exec_ask,
      execBid: b.exec_bid,
      bestBid: b.best_bid,
      depthUsd: b.depth_usd,
      houseProb: null,
    })),
  };
}

async function runView(tdb: PGlite, rpc: 'google_paper_inputs' | 'google_paper_inputs_opening') {
  const raw = (
    await rows<{ v: { captures: any[]; resolutions: any[]; google: any[] } }>(
      tdb,
      `select public.${rpc}(21, array['${SLUG}']::text[]) as v`,
    )
  )[0]!.v;
  const view = buildGoogleView(raw.captures, raw.resolutions, raw.google, googleCfg([SLUG]));
  return { raw, view };
}

describe('depth-capture v2 CROSS-PATH parity (0088/0089) — google_paper_inputs ≡ google_paper_inputs_opening on the panel DECISION', () => {
  let tdb: PGlite;
  let depth: Awaited<ReturnType<typeof runView>>;
  let opening: Awaited<ReturnType<typeof runView>>;

  beforeAll(async () => {
    tdb = await freshDb();
    const region = (await rows<{ region: string }>(tdb, `select region from public.clusters limit 1`))[0]!.region;
    const city_id = (
      await rows<{ city_id: string }>(
        tdb,
        `select city_id from public.upsert_city($1,'PF City','US','C','America/Chicago',$2)`,
        [SLUG, region],
      )
    )[0]!.city_id;
    // station mapping so the google block resolves an icao (the °C forecast that picks the bucket).
    await tdb.query(
      `insert into public.stations (icao, country_code, tz, source) values ($1,'US','America/Chicago','manual')`,
      [ICAO],
    );
    await tdb.query(
      `insert into public.city_stations (city_id, icao, wu_country_code, valid_from, verified) values ($1,$2,'US',now(),true)`,
      [city_id, ICAO],
    );
    // the event: TRUE gamma listing anchor (depth path), unit °C (not excluded), winner idx 1 (unused — TP fires).
    await tdb.query(
      `insert into public.market_events (id, poly_event_id, slug, kind, city_id, target_date, unit,
         accepting_orders, ladder_ok, gamma_created_at, first_seen, last_seen, volume24h, winning_bucket_idx)
       values ($1,'pf_poly','pf-slug','highest',$2,$3::date,'C', true, true, $4, $5, now(), 1000, 1)`,
      [EVENT, city_id, targetDate, gamma.toISOString(), new Date(gamma.getTime() + 10 * 60_000).toISOString()],
    );
    for (let i = 0; i < 3; i++) {
      await tdb.query(
        `insert into public.market_buckets (id, event_id, bucket_idx, label, low_native, high_native,
           condition_id, token_yes, token_no)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [B[i], EVENT, i, LABELS[i], i === 0 ? -99 : 20 + i, i === 2 ? 99 : 20 + i, `pc${i}`, `pty${i}`, `ptn${i}`],
      );
    }
    // the Google forecast: 21.0 °C → wuRound → 21 → bucket idx 1.
    await tdb.query(
      `insert into public.source_forecasts (icao, source, target_date, lead_days, snapshot_slot, tmax_c, captured_at)
       values ($1,'google',$2::date,1,'10Z',21.0,$3)`,
      [ICAO, targetDate, t1.toISOString()],
    );

    // ── SOURCE 1: opening_captures (the preserved fallback path) ──
    await tdb.query(`select public.record_opening_captures($1::jsonb)`, [
      JSON.stringify([openingTick(t1, LADDER.t1), openingTick(t2, LADDER.t2)]),
    ]);
    // ── SOURCE 2: market_depth (the cutover path) — SAME exec numbers, one write per tick ──
    for (const [t, ladder] of [
      [t1, LADDER.t1],
      [t2, LADDER.t2],
    ] as const) {
      const pRows = ladder.map((b) => ({
        bucket_id: B[b.idx],
        best_bid: b.best_bid,
        best_ask: b.best_ask,
        exec_ask: b.exec_ask,
        exec_bid: b.exec_bid,
        depth_usd: b.depth_usd,
      }));
      await tdb.query(`select public.record_market_depth($1::jsonb, $2::timestamptz)`, [
        JSON.stringify(pRows),
        t.toISOString(),
      ]);
    }
    // force the depth path (default cutover threshold is 200; 6 accrued rows > 1).
    await tdb.exec(
      `insert into public.config (key,value) values ('bot.depthCutoverMinRows','1')
       on conflict (key) do update set value = excluded.value`,
    );

    depth = await runView(tdb, 'google_paper_inputs');
    opening = await runView(tdb, 'google_paper_inputs_opening');
  });
  afterAll(async () => {
    await tdb.close();
  });

  it('BOTH sources were genuinely exercised — the raw signal-fields DIFFER (not the fallback twice)', () => {
    // depth path hard-defaults the convergence-signal fields; opening path carries the distinctive stored values.
    expect(depth.raw.captures.length).toBeGreaterThan(0);
    expect(opening.raw.captures.length).toBeGreaterThan(0);
    expect(depth.raw.captures[0].peakMid).toBeNull();
    expect(depth.raw.captures[0].isFlatOpen).toBe(false);
    expect(depth.raw.captures[0].houseSeeded).toBe(false);
    expect(opening.raw.captures[0].peakMid).toBeCloseTo(0.5, 6);
    expect(opening.raw.captures[0].isFlatOpen).toBe(true);
    expect(opening.raw.captures[0].houseSeeded).toBe(true);
  });

  it('each path fires EXACTLY ONE entry on the Google-predicted bucket (idx 1, "21°C")', () => {
    expect(depth.view.entries.length).toBe(1);
    expect(opening.view.entries.length).toBe(1);
    expect(depth.view.entries[0]!.entryLabel).toBe('21°C');
    expect(opening.view.entries[0]!.entryLabel).toBe('21°C');
  });

  it('the ENTRY decision is byte-identical across the cutover (bucket, fill, TP exit, P&L)', () => {
    const d = depth.view.entries[0]!;
    const o = opening.view.entries[0]!;
    // the decision-driving fields must match EXACTLY — same exec numbers in, same engine arithmetic out.
    expect(d.eventId).toBe(o.eventId);
    expect(d.predictedNative).toBe(o.predictedNative);
    expect(d.entryLabel).toBe(o.entryLabel);
    expect(d.entryPrice).toBe(o.entryPrice);
    expect(d.exitKind).toBe(o.exitKind);
    expect(d.exitReason).toBe(o.exitReason);
    expect(d.exitPrice).toBe(o.exitPrice);
    expect(d.stakeUsd).toBe(o.stakeUsd);
    expect(d.netPnlUsd).toBe(o.netPnlUsd);
    expect(d.netReturn).toBe(o.netReturn);
    expect(d.status).toBe(o.status);
    // it's the intended trade: a realized take-profit (the exit leg that carries the whole panel).
    expect(d.exitKind).toBe('take_profit');
    expect(d.status).toBe('realized');
    // entryAgeH agrees (both anchored to gamma; the 0.30h lands exactly on numeric(6,2) — no precision skew).
    expect(d.entryAgeH).toBeCloseTo(0.3, 2);
    expect(o.entryAgeH).toBeCloseTo(0.3, 2);
  });

  it('the fictive MONEY tracker is identical across the cutover', () => {
    const d = depth.view.money;
    const o = opening.view.money;
    expect(d.nEntries).toBe(o.nEntries);
    expect(d.nRealized).toBe(o.nRealized);
    expect(d.nWins).toBe(o.nWins);
    expect(d.nLosses).toBe(o.nLosses);
    expect(d.deployedUsd).toBe(o.deployedUsd);
    expect(d.netPnlUsd).toBe(o.netPnlUsd);
    expect(d.realizedPnlUsd).toBe(o.realizedPnlUsd);
    expect(d.roi).toBe(o.roi);
    expect(d.winRate).toBe(o.winRate);
  });

  it('the §9R-E gate counts + verdict are identical across the cutover', () => {
    const d = depth.view.gate;
    const o = opening.view.gate;
    expect(d.nMarkets).toBe(o.nMarkets);
    expect(d.nCities).toBe(o.nCities);
    expect(d.nDistinctDays).toBe(o.nDistinctDays);
    expect(d.label).toBe(o.label);
    expect(d.winFrac).toBe(o.winFrac);
    expect(d.meanNetReturn).toBe(o.meanNetReturn);
    // one in-population market either side ⇒ the SAME (INSUFFICIENT) verdict, from the SAME realized ledger.
    expect(d.nMarkets).toBe(1);
    expect(o.nMarkets).toBe(1);
  });

  it('the five-TP-variant exit comparison is identical across the cutover', () => {
    const d = depth.view.tpComparison;
    const o = opening.view.tpComparison;
    expect(d.nEntered).toBe(o.nEntered);
    expect(d.variants.length).toBe(o.variants.length);
    for (let i = 0; i < d.variants.length; i++) {
      expect(d.variants[i]!.tpAbs).toBe(o.variants[i]!.tpAbs);
      expect(d.variants[i]!.nTrades).toBe(o.variants[i]!.nTrades);
      expect(d.variants[i]!.nTpHit).toBe(o.variants[i]!.nTpHit);
      expect(d.variants[i]!.nHeldToResolution).toBe(o.variants[i]!.nHeldToResolution);
      expect(d.variants[i]!.netPnlUsd).toBe(o.variants[i]!.netPnlUsd);
      expect(d.variants[i]!.realizedPnlUsd).toBe(o.variants[i]!.realizedPnlUsd);
      expect(d.variants[i]!.winRate).toBe(o.variants[i]!.winRate);
    }
  });

  it('the coverage counts (fresh / google / no-google) are identical across the cutover', () => {
    expect(depth.view.nFreshEvents).toBe(opening.view.nFreshEvents);
    expect(depth.view.nGoogleEvents).toBe(opening.view.nGoogleEvents);
    expect(depth.view.nNoGoogleEvents).toBe(opening.view.nNoGoogleEvents);
    expect(depth.view.nFreshEvents).toBe(1);
    expect(depth.view.nGoogleEvents).toBe(1);
  });
});
