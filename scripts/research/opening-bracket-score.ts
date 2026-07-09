/**
 * scripts/research/opening-bracket-score — the BRACKET-EXIT realized-P&L scorer for the opening-convergence
 * capture panel (the companion to opening-resolution-score.ts, which scores BUY-and-HOLD-to-resolution).
 *
 * WHY THIS EXISTS. opening-resolution-score asks "does our forecast-center bucket win more often than it costs
 * at resolution?" — the pure forecasting-edge question. This script asks the OTHER one — the actual 12th-signal
 * thesis — the BRACKET EXIT: buy the forecast-center cheap, then SELL INTO THE CONVERGENCE *before* resolution
 * on a fixed take-profit / stop-loss / station-local-noon time-stop, walking the captured per-tick order book
 * tick by tick. It answers what the hold scorer cannot: does the bracket exit net positive after spread + fees
 * + the stop-loss leg — i.e. is there a convergence-re-rating edge that does NOT depend on the forecast being
 * correct at resolution.
 *
 * The flat-open premise was falsified 2026-06-28 (markets list pre-informed), so the entry runs with
 * selectEntries(..., { requireFlatOpen:false }) — ONLY the flat-open gate is skipped; the universe, runway,
 * mode, edge, depth and 20%-price-cap gates are intact. A forward mark-path probe showed the bracket mechanism
 * has a pulse (execBid re-rates UP ~79% of enterable events, a profitable sell-back existed ~62%, avg best
 * round-trip +10.4pp vs entry ask) — BUT only ~12% reached the configured +25pp take-profit. "A profitable exit
 * existed" is a LOOK-AHEAD ceiling, not a capture rule. This screen applies the REAL fixed bracket rule (no
 * look-ahead — the exit at tick t reads only tick t) for the honest net P&L, and SWEEPS the take-profit to see
 * whether a lower TP harvests the convergence better than +25pp.
 *
 * VERDICT. Per swept TP it runs the FROZEN §9R-E openingVerdict (executed markets only; city-clustered CI + the
 * cluster-preserving sign-flip MC) and prints PASS/KILL/INSUFFICIENT_DATA. The HEADLINE is the row at the
 * PRE-REGISTERED bot-default tpDeltaPp (0.25) — THAT is the gate; the rest of the sweep is EXPLORATORY (selecting
 * the best TP in-sample is the winner's-curse and is NEVER a GO). Below the §9R-E floors (≥40 executed markets,
 * ≥6 cities, ≥7 distinct days) every TP reads INSUFFICIENT_DATA by design. This script decides NOTHING about
 * capital — it defers to the §9R-E cluster gate + the operator.
 *
 * Read-only, KEYLESS. Reads the per-tick series for the §9R allowlist cities' fresh-listing events — filtered
 * SERVER-SIDE on cfg.cities + min hours_since_listing < 1, NOT the whole 45-city universe (the bracket exit needs
 * each entered event's full tick series, but only for the ~10 enterable cities — see loadEvents) — joined to a
 * market_events resolution map. Places NOTHING, writes NOTHING, never imports packages/trading. Entries are
 * additionally re-gated to the allowlist + flat-open-free inside the engine (selectEntries), matching the panel.
 * Run:  pnpm tsx scripts/research/opening-bracket-score.ts --days 3 --fee-rate 0.05
 *   --fee-rate is a FRACTION (e.g. 0.05 = the real weather taker rate) feeding takerFeePerShare = rate·p·(1−p);
 *   the bracket pays it on its TAKER legs (a taker-fallback entry + every bracket-exit sell). Maker fills pay $0.
 *   NOTE: loadEvents queries opening_captures DIRECTLY (migration 0066), server-side filtered to cfg.cities +
 *   the ≤1h fresh window — NOT the 45-city bot_capture_series RPC. The per-event tick series still carries a
 *   per-tick jsonb buckets column, so it grows with --days × cities — keep --days small (default 3; ~26h today).
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { ScriptDb } from '../lib/script-db.ts';
import {
  replayEvent,
  replayPanel,
  type BracketPanel,
  type EventReplayInput,
  type ReplayTick,
} from '../../packages/core/src/sim/opening-bracket-replay.ts';
import { BOT_DEFAULTS, type OpeningBucket, type OpeningCfg } from '../../packages/core/src/sim/opening-convergence.ts';
import {
  buildEvents,
  mapBucket,
  type RawBucket,
  type RawCaptureRow,
  type Resolution,
} from '../../packages/core/src/sim/opening-bracket-ingest.ts';

export const SCRIPT = 'opening-bracket-score';

// the real weather taker rate (the bracket pays it on taker legs); default kept identical to §9R / the bot.
export const DEFAULT_FEE_RATE = 0.05;
// the executable-depth floor (USD) on a scored entry — the capacity-wall discipline (matches the bot's
// depthFloorUsd / migration 0064). A $-thin top-of-book is not a fillable position; overridable via --min-depth.
export const DEFAULT_MIN_DEPTH_USD = 50;
// the take-profit sweep (the headline bot-default 0.25 is always added by replayPanel even if omitted here).
export const DEFAULT_TPS = [0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25];
// the live panel is ~26h today; the direct opening_captures query carries a per-tick jsonb buckets column.
export const DEFAULT_DAYS = 3;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// formatting
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');
const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const numOrNull = (v: unknown): number | null => (fin(v) ? Number(v) : null);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Raw→core row shapes + mappers now live in core/sim/opening-bracket-ingest (ONE tested copy, shared with
// the /convergence dashboard loader so the RPC payload shape and this harness's query shape cannot drift).
// Re-exported here so the CI seam test (opening-bracket-score.test.ts) keeps importing them from the harness.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export { buildEvents, mapBucket };
export type { RawBucket, RawCaptureRow, Resolution };

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DB I/O (read-only)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Per-event resolution map for the events in the window. winnerIdx = poly_resolved_winner_idx ?? winning_bucket_idx
 *  (venue where settled, else our truth grade); grading_mismatch flags the ambiguous-payout population. */
export async function loadResolutionMap(db: ScriptDb, ids: string[]): Promise<Map<string, Resolution>> {
  const m = new Map<string, Resolution>();
  if (!Array.isArray(ids) || ids.length === 0) return m;
  const rows = await db.query<Record<string, unknown>>(
    `select id, poly_resolved_winner_idx, winning_bucket_idx, grading_mismatch
       from public.market_events where id = any($1::uuid[])`,
    [ids],
  );
  for (const r of rows) {
    const poly = numOrNull(r['poly_resolved_winner_idx']);
    const win = numOrNull(r['winning_bucket_idx']);
    m.set(String(r['id']), { winnerIdx: poly ?? win, gradingMismatch: r['grading_mismatch'] === true });
  }
  return m;
}

/** The fresh-listing per-tick capture series for the §9R allowlist cities over the look-back, grouped into
 *  per-event replay inputs + their resolution. Filters to the cfg.cities allowlist AND the fresh universe
 *  (events with min hours_since_listing < 1) SERVER-SIDE — the bracket exit needs each entered event's FULL
 *  tick series, but only for the ~10 ENTERABLE cities. The whole-universe bot_capture_series RPC is the wrong
 *  tool here twice over: it aggregates ~175 MB of jsonb at the 45-city scale (migration 0068's >1 GB warning —
 *  it hung an interactive run), AND a non-allowlist event can never be entered (the selectEntries city gate),
 *  so loading it would only inflate the executedFrac denominator with structurally-unenterable markets. Numerics
 *  are ::float8-cast and the timestamp ::text-cast so the TS fresh/finite gates + `new Date()` see numbers/ISO,
 *  not raw pg `numeric` strings or a Date object (mirrors opening-resolution-score's direct-query loadRows idiom,
 *  NOT the RPC). Empty when the allowlist is empty or no rows match. */
export async function loadEvents(db: ScriptDb, days: number, cities: string[]): Promise<EventReplayInput[]> {
  const allow = (Array.isArray(cities) ? cities : []).filter((c) => typeof c === 'string' && c.length > 0);
  if (allow.length === 0) return [];
  const rows = await db.query<RawCaptureRow>(
    `with fresh as (
       select event_id
         from public.opening_captures
        where captured_at > now() - ($1 || ' days')::interval
          and event_id is not null
          and city = any($2::text[])
        group by event_id
       having min(hours_since_listing) < 1
     )
     select oc.event_id                    as "eventId",
            oc.captured_at::text           as "capturedAt",
            oc.city                        as "city",
            oc.target_date::text           as "targetDate",
            oc.tz_name                     as "tzName",
            oc.created_at_gamma::text      as "createdAtGamma",
            oc.resolves_at::text           as "resolvesAt",
            oc.hours_since_listing::float8 as "hoursSinceListing",
            oc.peak_mid::float8            as "peakMid",
            oc.is_flat_open                as "isFlatOpen",
            oc.house_seeded                as "houseSeeded",
            oc.buckets                     as "buckets",
            oc.ev_vol24h::float8           as "evVol24h",
            oc.neg_risk                    as "negRisk"
       from public.opening_captures oc
       join fresh f on f.event_id = oc.event_id
      where oc.captured_at > now() - ($1 || ' days')::interval
      order by oc.event_id, oc.captured_at`,
    [Math.max(1, Math.floor(days)), allow],
  );
  const ids = [...new Set(rows.map((r) => r.eventId).filter((v): v is string => !!v))];
  const resMap = await loadResolutionMap(db, ids);
  return buildEvents(rows, resMap);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// report
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function report(panel: BracketPanel, feeRate: number, minDepthUsd: number, log: (m: string) => void): void {
  const headline = panel.perTp.find((r) => r.tpDeltaPp === panel.headlineTp) ?? null;
  log('=== opening-bracket-score · bracket-EXIT realized edge (sell into the convergence before resolution) ===');
  log(
    `  taker fee rate ${pct(feeRate)} (rate·p·(1−p), taker legs only; maker fills $0) · min depth $${minDepthUsd} · ` +
      `headline TP +${pct(panel.headlineTp, 0)} (pre-registered)`,
  );
  log('');
  log('  the bet scored: BUY the forecast-center bucket at the first enterable tick (maker-first, taker fallback),');
  log('  then SELL on the FIRST of take-profit (entry+TP or modelProb) / stop-loss / station-local-noon time-stop,');
  log('  walking the captured order book tick-by-tick (NO LOOK-AHEAD). Leftover-open settles at resolution.');
  log('  §9R-E floors (per TP): ≥40 executed markets · ≥6 cities · ≥7 distinct days — below any → INSUFFICIENT_DATA.');
  log('  ruleCapture = mean realized net ROI the FIXED rule caught; ceiling = mean (bestReachableBid − entry), the');
  log('  look-ahead max a perfect sell-back COULD have realised (NOT a strategy — the gap is the unharvested headroom).');
  log('');
  log(
    `  ${'TP'.padStart(5)}  ${'nMkts'.padStart(5)}  ${'cities'.padStart(6)}  ${'dates'.padStart(5)}  ` +
      `${'exec%'.padStart(6)}  ${'winFrac'.padStart(7)}  ${'meanNetRet'.padStart(10)}  ${'CI95'.padStart(18)}  ` +
      `${'zsMC'.padStart(6)}  ${'ruleRoi'.padStart(7)}  ${'ceiling'.padStart(7)}  verdict`,
  );
  for (const r of panel.perTp) {
    const mark = r.tpDeltaPp === panel.headlineTp ? '*' : ' ';
    log(
      `${mark} ${`+${pct(r.tpDeltaPp, 0)}`.padStart(5)}  ${String(r.nMarkets).padStart(5)}  ` +
        `${String(r.nCities).padStart(6)}  ${String(r.nDistinctDays).padStart(5)}  ${pct(r.executedFrac).padStart(6)}  ` +
        `${pct(r.winFrac).padStart(7)}  ${signedPct(r.meanNetReturn).padStart(10)}  ` +
        `${`[${pct(r.ciLow)}, ${pct(r.ciHigh)}]`.padStart(18)}  ${pct(r.zeroSkillPassRate).padStart(6)}  ` +
        `${signedPct(r.ruleCaptureRoi).padStart(7)}  ${signedPct(r.avgBestReachableRoundtrip).padStart(7)}  ${r.label}`,
    );
  }
  log('');
  log('=== HEADLINE VERDICT (the pre-registered §9R-E gate at TP +25%) ===');
  if (!headline) {
    log('  INSUFFICIENT_DATA — the headline TP row is missing (no panel built). Keep the capture cron running.');
  } else {
    log(`  ${headline.label} — ${headline.reason}`);
    if (Number.isFinite(headline.ruleCaptureRoi) && Number.isFinite(headline.avgBestReachableRoundtrip)) {
      log(
        `  ceiling-vs-capture: the FIXED rule caught ${signedPct(headline.ruleCaptureRoi)} net ROI; the look-ahead ` +
          `best-sell-back ceiling was +${pct(headline.avgBestReachableRoundtrip)} of price over entry (the gap is the ` +
          'unharvested re-rating — a tighter TP MIGHT close some of it, but selecting it in-sample is the winner\'s-curse).',
      );
    }
  }
  log('');
  log('  CAVEATS — the TP sweep is EXPLORATORY (in-sample TP selection = winner\'s-curse; OOS re-validation required).');
  log('  Entries are gated to the bot\'s city allowlist + the FRESH universe (min hours_since_listing < 1). The whole');
  log('  screen DEFERS to the §9R-E openingVerdict cluster gate + the operator for any capital, and is INSUFFICIENT-');
  log('  by-design until enough markets are executed AND resolved. This decides nothing about capital.');
}

const signedPct = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${pct(v)}` : '—');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// self-test (runs on CLI invocation, no DB/network — mirrors the other research spines)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function sanity(): void {
  const TZ = 'Europe/Amsterdam';
  const DATE = '2026-06-28'; // CEST → local noon 10:00Z
  const cfg: OpeningCfg = { ...BOT_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50, takerFeeRate: 0.05 };

  const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
    idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
    bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: null,
    tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
  });
  const ladder = (center: Partial<OpeningBucket> = {}): OpeningBucket[] => [
    b(0, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
    b(1, { houseProb: 0.2 }),
    b(2, { houseProb: 0.35, ...center }),
    b(3, { houseProb: 0.2 }),
    b(4, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
  ];
  const tick = (capturedAt: string, age: number, center: Partial<OpeningBucket> = {}): ReplayTick => ({
    capturedAt, hoursSinceListing: age, tz: TZ, targetDate: DATE, buckets: ladder(center),
  });
  const entry = tick('2026-06-28T08:00:00.000Z', 0.2, { execAsk: 0.18, bestAsk: 0.12, execBid: 0.1 });
  const maker = tick('2026-06-28T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.1 });

  // take-profit on a re-rate up
  const tp = replayEvent(
    { eventId: 'E', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks: [entry, maker, tick('2026-06-28T08:01:00.000Z', 0.35, { execBid: 0.45 })], resolution: { winnerIdx: null, gradingMismatch: false } },
    cfg, 0.25,
  );
  if (!tp.executed || !tp.exitReason.startsWith('take_profit')) throw new Error(`sanity: expected take_profit, got ${tp.exitReason}`);
  if (!tp.isMaker || Math.abs(tp.entryPrice - 0.12) > 1e-9) throw new Error('sanity: expected a maker fill at 0.12');

  // resolution settle WIN
  const held: ReplayTick[] = [entry, maker, tick('2026-06-28T08:01:00.000Z', 0.35, { execBid: 0.1 })];
  const winTrade = replayEvent({ eventId: 'W', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks: held, resolution: { winnerIdx: 2, gradingMismatch: false } }, cfg, 0.25);
  if (winTrade.exitReason !== 'resolution_settle:win' || winTrade.exitPrice !== 1 || !(winTrade.netReturn > 0)) throw new Error('sanity: settle-win');

  // NO LOOK-AHEAD: a stop-loss is not rescued by a later up-tick
  const nla = replayEvent(
    { eventId: 'N', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks: [entry, maker, tick('2026-06-28T08:01:00.000Z', 0.35, { execBid: 0.05 }), tick('2026-06-28T08:01:30.000Z', 0.4, { execBid: 0.9 })], resolution: { winnerIdx: null, gradingMismatch: false } },
    cfg, 0.25,
  );
  if (!nla.exitReason.startsWith('stop_loss') || Math.abs(nla.exitPrice - 0.05) > 1e-9) throw new Error('sanity: stop-loss not honored');
  if (!(nla.bestReachableBid >= 0.9)) throw new Error('sanity: ceiling should have recorded the later up-tick');

  // never-enterable (city gate) ⇒ executed:false
  const off = replayEvent({ eventId: 'O', city: 'london', targetDate: DATE, tz: TZ, ticks: [entry, maker], resolution: { winnerIdx: null, gradingMismatch: false } }, cfg, 0.25);
  if (off.executed !== false) throw new Error('sanity: off-allowlist city must not enter');

  // panel: the headline TP is always present; report() is total on an empty panel
  const panel = replayPanel([{ eventId: 'W', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks: held, resolution: { winnerIdx: 2, gradingMismatch: false } }], cfg, DEFAULT_TPS);
  if (panel.headlineTp !== cfg.tpDeltaPp) throw new Error('sanity: headlineTp must be the bot-default TP');
  if (!panel.perTp.some((r) => r.tpDeltaPp === cfg.tpDeltaPp)) throw new Error('sanity: headline TP row missing');
  const empty = replayPanel([], cfg, DEFAULT_TPS);
  report(empty, 0.05, 50, () => {}); // must not throw
  if (empty.perTp[0]!.label !== 'INSUFFICIENT_DATA') throw new Error('sanity: empty panel must be INSUFFICIENT');

  // buildEvents: grouping + FRESH filter + bucket mapping (DB-free)
  const raw = (over: Partial<RawCaptureRow>): RawCaptureRow => ({
    eventId: 'R', capturedAt: '2026-06-28T08:00:00.000Z', city: 'amsterdam', targetDate: DATE, tzName: TZ,
    createdAtGamma: null, resolvesAt: null, hoursSinceListing: 0.2, peakMid: 0.1, isFlatOpen: true, houseSeeded: true,
    buckets: [{ idx: 2, label: '21C', loF: 70, hiF: 71, mid: 0.1, bestAsk: 0.12, execAsk: 0.18, depthUsd: 100, bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: 0.35, tokenYes: 'y', tokenNo: 'n', conditionId: 'c' }],
    evVol24h: 5000, negRisk: true, ...over,
  });
  const built = buildEvents([raw({ eventId: 'R', hoursSinceListing: 0.2 }), raw({ eventId: 'R', capturedAt: '2026-06-28T08:30:00.000Z', hoursSinceListing: 0.7 })], new Map([['R', { winnerIdx: 2, gradingMismatch: false }]]));
  if (built.length !== 1 || built[0]!.ticks.length !== 2) throw new Error('sanity: buildEvents grouping');
  if (built[0]!.ticks[0]!.buckets[0]!.execAsk !== 0.18) throw new Error('sanity: bucket mapping');
  if (built[0]!.resolution.winnerIdx !== 2) throw new Error('sanity: resolution wiring');
  // a NON-fresh event (min hours_since_listing ≥ 1) is dropped
  if (buildEvents([raw({ eventId: 'Z', hoursSinceListing: 5 })], new Map()).length !== 0) throw new Error('sanity: non-fresh event must drop');
  if (buildEvents([], new Map()).length !== 0) throw new Error('sanity: empty buildEvents');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      'fee-rate': { type: 'string' },
      'min-depth': { type: 'string' },
      tps: { type: 'string' },
    },
  });
  const days = Math.max(1, Math.floor(Number(values.days ?? DEFAULT_DAYS) || DEFAULT_DAYS));
  const feeRate = Math.max(0, Number(values['fee-rate'] ?? DEFAULT_FEE_RATE) || 0);
  const minDepthUsd = values['min-depth'] != null ? Math.max(0, Number(values['min-depth']) || 0) : DEFAULT_MIN_DEPTH_USD;
  const tps =
    values.tps != null
      ? String(values.tps).split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v) && v >= 0)
      : DEFAULT_TPS;
  const cfg: OpeningCfg = { ...BOT_DEFAULTS, depthFloorUsd: minDepthUsd, takerFeeRate: feeRate };

  const db = makeScriptDb();
  try {
    process.stderr.write(
      `${SCRIPT} · ${new Date().toISOString()} · reading opening_captures(${days}) fresh+city-filtered ⋈ market_events — read-only; places NOTHING\n`,
    );
    const events = await loadEvents(db, days, cfg.cities);
    process.stderr.write(`  ${events.length} fresh events (min hours_since_listing < 1) · ${events.reduce((a, e) => a + e.ticks.length, 0)} ticks\n`);
    // priceBasis 'real-book': opening_captures carries the observed exec bid/ask, not mids.
    const panel = replayPanel(events, cfg, tps, { priceBasis: 'real-book' });
    report(panel, feeRate, minDepthUsd, console.log);
  } finally {
    await db.end();
  }
}
