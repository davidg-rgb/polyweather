/**
 * scripts/research/badatmath-replica — the IMPURE spine of the "recreate badatmath's buying model"
 * paper trial (WALLET-RECON-HANDOFF.md §15; the pure engine is `core/sim/badatmath-replica.ts`).
 *
 * WHAT THIS IS. A fictional, no-money trial run that mimics the #1 WEATHER sharp's REVEALED strategy —
 * cheap-Yes (0.10–0.25) buckets, in his best-performing cities, bought at his peak-odds lead (~36h
 * before resolution), ~3 buckets/city·day, ~$12/position, capped at a daily bankroll — and tracks it
 * day by day, scored THREE ways (maker-ideal / maker-realistic / taker; see the core module). It runs
 * over the data we already have (BACKTEST, to seed a real track record) and forward on live markets
 * (FORWARD, the daily /loop driver). The maker-ideal→taker gap is the spread tax; the
 * maker-ideal→maker-realistic gap is the adverse-selection tax — the whole story of why the edge is
 * his and not ours, watched in real time.
 *
 * POSTURE. Read-only analytics. Ships nothing to prod, no migration, never imports `packages/trading`.
 * Resolution is read from our own DB (`market_events.winning_bucket_idx`) — the same trusted basis
 * db1 / maker-spray / m1 all used. Coverage (events our pipeline has resolved) is reported honestly.
 *
 * Run:
 *   pnpm tsx scripts/research/badatmath-replica.ts                # backtest the default window, write the ledger
 *   pnpm tsx scripts/research/badatmath-replica.ts --rank-cities  # just print the city ROI ranking (pick a whitelist)
 *   pnpm tsx scripts/research/badatmath-replica.ts --cities kuala-lumpur,singapore --from 2026-05-01
 *   pnpm tsx scripts/research/badatmath-replica.ts --mode forward # place today's buys on live markets + score resolved (the loop)
 * Flags: --from --to --cities <slugs> --cheap-lo --cheap-hi --lead-h --breadth --stake --cap
 *        --min-city-n --top N --out <dir> --net --json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { localDayWindow } from '../../packages/core/src/index.ts';
import type { BucketSnapshot } from '../../packages/core/src/sim/copy-trade.ts';
import {
  DEFAULT_REPLICA_STRATEGY,
  type CityRoi,
  type DailyRow,
  type Leg,
  type LegStats,
  type ReplicaCandidate,
  type ReplicaStrategy,
  type ReplicaSummary,
  type ScoredBuy,
  bandEligible,
  dailyLedger,
  rankCitiesByRoi,
  scoreBuys,
  selectBuys,
  summarize,
} from '../../packages/core/src/sim/badatmath-replica.ts';
import { type Db, splitList } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
// Static (circular) import — forward.ts imports this module's loaders/renderers back. ESM resolves the
// cycle via function hoisting; a DYNAMIC import here deadlocks tsx mid-top-level-await (the cycle never
// settles). Loading forward in backtest mode too is a no-op cost (pure declarations).
import { runForward } from './badatmath-replica-forward.ts';
// Reuse the purchase-map's cache-first, batched Gamma resolver (DRY) for the --gamma coverage widening.
import { fetchResolutions } from './badatmath-purchase-map.ts';

export const SCRIPT = 'badatmath-replica';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// DB loaders — events (by city, resolved-or-open) + bucket meta + the snapshot book series
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const dISO = (d: string | Date): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** Format a bucket's native low/high into a human label for the ledger (mirrors the purchase-map). */
function bucketLabel(low: number | null, high: number | null, unit: string): string {
  const u = `°${unit}`;
  if (low == null && high != null) return `≤${high}${u}`;
  if (high == null && low != null) return `≥${low}${u}`;
  if (low != null && high != null) return `${low}–${high}${u}`;
  return 'bucket';
}

interface EventRow {
  event_id: string;
  city_slug: string;
  region: string;
  tz: string;
  unit: 'C' | 'F';
  target_date: string | Date;
  winning_bucket_idx: number | null;
}

interface BucketRow {
  event_id: string;
  bucket_id: string;
  bucket_idx: number;
  low_native: number | null;
  high_native: number | null;
  tick_size: string | null;
  fee_rate: string | null;
  condition_id: string | null;
}

/**
 * Load every buyable Yes-bucket candidate in scope, each enriched with its resolution (when our DB has
 * it), per-bucket fee/tick, and its full `market_snapshots` book series. `resolvedOnly` restricts to
 * events our pipeline has resolved (the backtest basis); the FORWARD path loads open events too
 * (winning_bucket_idx null → bucketWon null → a pending bet). `cities` (slugs) narrows scope; omitted =
 * all cities. Read-only.
 */
export async function loadCandidates(
  db: Db,
  args: { from: string; to: string; cities?: string[]; resolvedOnly: boolean },
): Promise<ReplicaCandidate[]> {
  const cityFilter = args.cities && args.cities.length > 0 ? args.cities.map((s) => s.toLowerCase()) : null;
  const evRows = await db.query<EventRow>(
    `select me.id event_id, c.slug city_slug, c.region, c.tz, me.unit,
            me.target_date, me.winning_bucket_idx
     from market_events me
     join cities c on c.id = me.city_id
     where me.ladder_ok
       and me.target_date >= $1 and me.target_date <= $2
       ${args.resolvedOnly ? 'and me.winning_bucket_idx is not null' : ''}
       ${cityFilter ? 'and lower(c.slug) = any($3)' : ''}
     order by me.target_date, c.slug`,
    cityFilter ? [args.from, args.to, cityFilter] : [args.from, args.to],
  );
  if (evRows.length === 0) return [];

  const eventById = new Map(evRows.map((e) => [e.event_id, e]));
  const eventIds = [...eventById.keys()];

  // bucket meta (chunked by event)
  const bucketRows: BucketRow[] = [];
  const CHUNK = 500;
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const chunk = eventIds.slice(i, i + CHUNK);
    const rows = await db.query<BucketRow>(
      `select mb.event_id, mb.id bucket_id, mb.bucket_idx, mb.low_native, mb.high_native,
              mb.tick_size, mb.fee_rate, mb.condition_id
       from market_buckets mb
       where mb.event_id = any($1)
       order by mb.event_id, mb.bucket_idx`,
      [chunk],
    );
    bucketRows.push(...rows);
  }
  if (bucketRows.length === 0) return [];

  // snapshot series per bucket_id, windowed to a few days around the target date (markets are
  // short-lived; this bounds volume). Plain-UTC window bounds are a loose filter — the engine picks the
  // precise entry snapshot by unix timestamp downstream.
  const bucketIds = bucketRows.map((b) => b.bucket_id);
  const seriesByBucket = new Map<string, BucketSnapshot[]>();
  const SCHUNK = 300;
  for (let i = 0; i < bucketIds.length; i += SCHUNK) {
    const chunk = bucketIds.slice(i, i + SCHUNK);
    const rows = await db.query<{
      bucket_id: string;
      captured_at: string | Date;
      best_bid: string | null;
      best_ask: string | null;
      mid: string | null;
    }>(
      `select ms.bucket_id, ms.captured_at, ms.best_bid, ms.best_ask, ms.mid
       from market_snapshots ms
       join market_buckets mb on mb.id = ms.bucket_id
       join market_events  me on me.id = mb.event_id
       where ms.bucket_id = any($1)
         and ms.captured_at >= (me.target_date::timestamptz - interval '5 days')
         and ms.captured_at <  (me.target_date::timestamptz + interval '2 days')
       order by ms.bucket_id, ms.captured_at asc`,
      [chunk],
    );
    for (const r of rows) {
      const arr = seriesByBucket.get(r.bucket_id) ?? [];
      arr.push({
        capturedAt: Math.floor(new Date(r.captured_at).getTime() / 1000),
        bid: r.best_bid == null ? null : Number(r.best_bid),
        ask: r.best_ask == null ? null : Number(r.best_ask),
        mid: r.mid == null ? null : Number(r.mid),
      });
      seriesByBucket.set(r.bucket_id, arr);
    }
  }

  // assemble candidates (one per event×bucket = buying that bucket's Yes leg)
  const candidates: ReplicaCandidate[] = [];
  for (const b of bucketRows) {
    const ev = eventById.get(b.event_id);
    if (!ev) continue;
    const series = seriesByBucket.get(b.bucket_id);
    if (!series || series.length === 0) continue; // no book → can't price an entry
    const targetDate = dISO(ev.target_date);
    let resolutionTs: number;
    try {
      resolutionTs = Math.floor(localDayWindow(ev.tz, targetDate).endUtc.getTime() / 1000);
    } catch {
      continue; // unknown tz → skip (rare)
    }
    candidates.push({
      conditionId: b.condition_id ?? '',
      eventId: b.event_id,
      citySlug: ev.city_slug,
      region: ev.region,
      targetDate,
      bucketIdx: b.bucket_idx,
      bucketLabel: bucketLabel(
        b.low_native == null ? null : Number(b.low_native),
        b.high_native == null ? null : Number(b.high_native),
        ev.unit,
      ),
      bucketWon: ev.winning_bucket_idx == null ? null : b.bucket_idx === ev.winning_bucket_idx,
      feeRate: b.fee_rate == null ? 0 : Number(b.fee_rate),
      tickSize: b.tick_size == null ? 0 : Number(b.tick_size),
      resolutionTs,
      snapshots: series,
    });
  }
  return candidates;
}

/**
 * Widen resolution coverage with Polymarket Gamma (~97% settled vs our DB's ~45% — §15). For each
 * candidate's bucket conditionId, Gamma's authoritative Yes/No OVERRIDES our DB-derived `bucketWon`
 * (Gamma is primary; the DB resolution pipeline lags); where Gamma has no answer (still-open / archived)
 * we keep the DB value. Cache-first (re-runs are instant). Mutates `bucketWon` in place; returns coverage
 * counts. Read-only network. Resolve ONLY the buys you will score (selected/allocated) — not all candidates.
 */
export async function resolveViaGamma(
  candidates: ReplicaCandidate[],
  opts: { resCache: string; log: (m: string) => void },
): Promise<{ nGamma: number; nDbFallback: number; nUnresolved: number }> {
  const conditionIds = [...new Set(candidates.map((c) => c.conditionId).filter((id) => id !== ''))];
  const winByCondition = await fetchResolutions(conditionIds, { cache: opts.resCache, log: opts.log });
  let nGamma = 0;
  let nDbFallback = 0;
  let nUnresolved = 0;
  for (const c of candidates) {
    const g = c.conditionId ? winByCondition.get(c.conditionId) : undefined;
    if (g !== undefined) {
      c.bucketWon = g === 'Yes';
      nGamma++;
    } else if (c.bucketWon !== null) {
      nDbFallback++;
    } else {
      nUnresolved++;
    }
  }
  return { nGamma, nDbFallback, nUnresolved };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// formatting
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const usd = (v: number): string => (!Number.isFinite(v) ? '—' : v < 0 ? `-$${Math.abs(v).toFixed(0)}` : `$${v.toFixed(0)}`);
const usd2 = (v: number): string => (!Number.isFinite(v) ? '—' : v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `$${v.toFixed(2)}`);
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const pct2 = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');

const LEG_LABEL: Record<Leg, string> = {
  makerIdeal: '🟢 maker-ideal',
  makerRealistic: '🟡 maker-realistic',
  taker: '🔴 taker',
};
const LEG_GLOSS: Record<Leg, string> = {
  makerIdeal: 'his cheap price, assume filled — the §15 +12.9% ceiling',
  makerRealistic: 'rest the bid, fill only if the book touches it (§12 adverse selection)',
  taker: 'cross to the ask — what we’d actually pay copying him (§11)',
};

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the ledger (markdown) + the per-position CSV
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface LedgerInputs {
  title: string;
  subtitle: string;
  strat: ReplicaStrategy;
  summary: ReplicaSummary;
  daily: DailyRow[];
  cities: CityRoi[];
  topCities: number;
  net: boolean;
  /** optional funnel line override (the forward run reports open/closed/placed instead of the backtest funnel). */
  funnel?: string;
  /** optional extra section appended verbatim (the forward run prints its open positions here). */
  extra?: string;
}

function legRow(s: LegStats): string {
  return `| ${LEG_LABEL[s.leg]} | ${LEG_GLOSS[s.leg]} | ${s.nResolved} | ${usd(s.stakeUsd)} | ${usd(
    s.grossPnlUsd,
  )} | ${pct(s.roiGross)} | ${pct(s.hitRate)} | ${pct2(s.ev)} [${pct2(s.evCiLo)}, ${pct2(s.evCiHi)}] |`;
}

/** Render the full human-readable ledger as markdown. Pure (string in/out). */
export function renderLedger(inp: LedgerInputs): string {
  const { summary: sm, strat } = inp;
  const pnlWord = inp.net ? 'fee-net' : 'gross';
  const L: string[] = [];
  L.push(`# ${inp.title}`);
  L.push('');
  L.push(`_${inp.subtitle}_`);
  L.push('');
  L.push(
    `**Strategy:** cheap-Yes **${strat.cheapBandLo}–${strat.cheapBandHi}**, entry **${strat.entryLeadHours}h** before resolution, ` +
      `**${strat.breadthPerCityDay}** buckets/city·day, **$${strat.positionStakeUsd}**/position, **$${strat.dailyBankrollCapUsd}**/day bankroll cap.`,
  );
  L.push('');
  L.push(
    inp.funnel ??
      `**Funnel:** ${sm.nCandidates} candidate buckets → ${sm.nBandEligible} band-eligible → ${sm.nSelected} breadth-selected → ` +
        `**${sm.nAllocated} bought** (under the cap) → ${sm.nResolved} resolved` +
        (sm.nPending > 0 ? `, ${sm.nPending} still open` : '') +
        '.',
  );
  L.push('');

  // ── the three curves ──
  L.push('## The three curves — where the money is, and where it leaks');
  L.push('');
  L.push('| Curve | what it is | resolved | stake | gross P&L | ROI | win% | EV/$1 (95% CI) |');
  L.push('|---|---|--:|--:|--:|--:|--:|--:|');
  L.push(legRow(sm.makerIdeal));
  L.push(legRow(sm.makerRealistic));
  L.push(legRow(sm.taker));
  L.push('');
  L.push(
    `- **Spread tax** (maker-ideal → taker): **${pct(sm.spreadTaxRoi)} ROI** — the cost of crossing to the ask instead of resting his cheap bid.`,
  );
  L.push(
    `- **Adverse-selection tax** (maker-ideal → maker-realistic): **${pct(sm.adverseSelTaxRoi)} ROI** — the cost of REAL maker fills ` +
      `(only ${pct(sm.makerFillRate)} of our rested bids fill, and they fill on the losers — §12).`,
  );
  L.push('');

  // ── day by day ──
  L.push(`## Day by day (${pnlWord} hold-to-resolution P&L, cumulative)`);
  L.push('');
  if (inp.daily.length === 0) {
    L.push('_No resolved positions yet._');
  } else {
    L.push('| date | resolved | maker-ideal | cum | maker-realistic | cum | taker | cum |');
    L.push('|---|--:|--:|--:|--:|--:|--:|--:|');
    for (const r of inp.daily) {
      L.push(
        `| ${r.date} | ${r.nResolved} | ${usd(r.makerIdealPnl)} | ${usd(r.makerIdealCum)} | ${usd(
          r.makerRealisticPnl,
        )} | ${usd(r.makerRealisticCum)} | ${usd(r.takerPnl)} | ${usd(r.takerCum)} |`,
      );
    }
  }
  L.push('');

  // ── best cities ──
  L.push('## His best-performing cities (by maker-ideal ROI)');
  L.push('');
  if (inp.cities.length === 0) {
    L.push('_Not enough resolved positions per city yet._');
  } else {
    L.push('| city | region | resolved | stake | gross P&L | ROI | win% |');
    L.push('|---|---|--:|--:|--:|--:|--:|');
    for (const c of inp.cities.slice(0, inp.topCities)) {
      L.push(
        `| ${c.city} | ${c.region} | ${c.nResolved} | ${usd(c.stakeUsd)} | ${usd(c.grossPnlUsd)} | ${pct(
          c.roiGross,
        )} | ${pct(c.hitRate)} |`,
      );
    }
    if (inp.cities.length > inp.topCities) {
      L.push('');
      L.push(`_…and the ${inp.cities.length - inp.topCities} weaker cities below the top ${inp.topCities} (the bleeders to drop)._`);
    }
  }
  L.push('');

  if (inp.extra) {
    L.push(inp.extra);
    L.push('');
  }

  L.push('---');
  L.push(
    '_Three curves because badatmath’s edge is a MAKER edge (rests cheap bids, collects the rebate + breadth) that is ' +
      'non-followable as a taker (§11) and non-replicable as a maker on our forecast (§12). This trial watches the spread tax ' +
      'and adverse-selection tax in real time. Not trading; no money; read-only._',
  );
  return L.join('\n');
}

/** The per-position CSV (one row per allocated buy, all three legs) for drill-down. */
export function renderCsv(scored: ScoredBuy[]): string {
  const header = [
    'target_date', 'entry_day_utc', 'city', 'region', 'bucket_label', 'bucket_idx',
    'maker_price', 'taker_price', 'stake_usd', 'allocated', 'resolved', 'won',
    'maker_ideal_pnl', 'maker_realistic_filled', 'maker_realistic_pnl', 'taker_pnl', 'condition_id',
  ].join(',');
  const lines = [header];
  for (const s of scored) {
    const c = s.buy.candidate;
    lines.push(
      [
        c.targetDate,
        s.buy.entryDayUtc,
        c.citySlug,
        c.region,
        `"${c.bucketLabel}"`,
        c.bucketIdx,
        s.buy.makerPrice.toFixed(4),
        s.buy.takerPrice.toFixed(4),
        s.buy.stakeUsd.toFixed(2),
        s.buy.allocated ? 1 : 0,
        s.resolved ? 1 : 0,
        c.bucketWon == null ? '' : c.bucketWon ? 1 : 0,
        s.makerIdeal.grossPnlUsd.toFixed(2),
        s.makerRealistic.filled ? 1 : 0,
        s.makerRealistic.grossPnlUsd.toFixed(2),
        s.taker.grossPnlUsd.toFixed(2),
        c.conditionId,
      ].join(','),
    );
  }
  return lines.join('\n');
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// persistence — project the trial into Postgres for /replica (the web dashboard; migration 0053)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One persisted-position jsonb row (camelCase, mirroring core LockedBuy + bookkeeping). */
export interface ReplicaPositionRow {
  conditionId: string;
  eventId: string;
  citySlug: string;
  region: string;
  targetDate: string;
  bucketIdx: number;
  bucketLabel: string;
  resolutionTs: number;
  entryTs: number;
  entryDayUtc: string;
  /** The placement snapshot's capturedAt (the §12 fill-window start; migration 0056). */
  entryCapturedTs: number;
  makerPrice: number;
  takerPrice: number;
  stakeUsd: number;
  feeRate: number;
  bucketWon: boolean | null;
  makerRealisticFilled: boolean;
  status: 'open' | 'resolved';
  placedAtUtc: string | null;
  closedAtUtc: string | null;
}

/** Map a scored BACKTEST buy → a persisted-position row (callers pass only allocated buys). */
export function scoredToRow(s: ScoredBuy): ReplicaPositionRow {
  const c = s.buy.candidate;
  return {
    conditionId: c.conditionId,
    eventId: c.eventId,
    citySlug: c.citySlug,
    region: c.region,
    targetDate: c.targetDate,
    bucketIdx: c.bucketIdx,
    bucketLabel: c.bucketLabel,
    resolutionTs: c.resolutionTs,
    entryTs: s.buy.entryTs,
    entryDayUtc: s.buy.entryDayUtc,
    entryCapturedTs: s.buy.entrySnapshot.capturedAt,
    makerPrice: s.buy.makerPrice,
    takerPrice: s.buy.takerPrice,
    stakeUsd: s.buy.stakeUsd,
    feeRate: c.feeRate,
    bucketWon: c.bucketWon,
    makerRealisticFilled: s.makerRealistic.filled,
    status: s.resolved ? 'resolved' : 'open',
    placedAtUtc: null,
    closedAtUtc: null,
  };
}

/**
 * Persist a source's full current position set (replace=true → an exact projection of the run's state) via
 * the service-role write RPC. Returns the row count. Read-from-state, write-to-DB; idempotent.
 */
export async function persistPositions(
  db: Db,
  source: 'backtest' | 'forward',
  rows: ReplicaPositionRow[],
): Promise<number> {
  // Pass the RAW array (NOT JSON.stringify'd): postgres-js encodes a JS array/object as jsonb directly, but
  // JSON-RE-ENCODES a pre-stringified string into a jsonb SCALAR (which then can't be array-iterated).
  const [r] = await db.query<{ replica_record_positions: number }>(
    `select public.replica_record_positions($1, true, $2::jsonb) as replica_record_positions`,
    [source, rows],
  );
  return Number(r?.replica_record_positions ?? 0);
}

/** Record one run row (the strategy + whitelist + funnel/tally counts) via the service-role write RPC. */
export async function persistRun(db: Db, payload: Record<string, unknown>): Promise<void> {
  // Raw object param (see persistPositions) so postgres-js binds it as a jsonb object, not a jsonb string.
  await db.query(`select public.replica_record_run($1::jsonb) as id`, [payload]);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// console summary (the quick read; the ledger file is the durable artifact)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

function printSummary(sm: ReplicaSummary, log: (m: string) => void): void {
  const line = (s: LegStats): void =>
    log(
      `  ${LEG_LABEL[s.leg].padEnd(20)} n=${String(s.nResolved).padStart(4)}  stake ${usd(s.stakeUsd).padStart(8)}  ` +
        `P&L ${usd(s.grossPnlUsd).padStart(9)}  ROI ${pct(s.roiGross).padStart(8)}  win ${pct(s.hitRate).padStart(7)}  ` +
        `EV/$1 ${pct2(s.ev).padStart(8)} [${pct2(s.evCiLo)}, ${pct2(s.evCiHi)}]`,
    );
  log('── THE THREE CURVES (hold-to-resolution) ──');
  line(sm.makerIdeal);
  line(sm.makerRealistic);
  line(sm.taker);
  log(`  spread tax (ideal→taker) ${pct(sm.spreadTaxRoi)}   ·   adverse-sel tax (ideal→realistic) ${pct(sm.adverseSelTaxRoi)}   ·   maker fill rate ${pct(sm.makerFillRate)}`);
}

function printCities(cities: CityRoi[], top: number, log: (m: string) => void): void {
  log(`── BEST CITIES by maker-ideal ROI (top ${top}) ──`);
  log(`  ${'city'.padEnd(18)} ${'region'.padEnd(16)} ${'n'.padStart(4)} ${'stake'.padStart(8)} ${'P&L'.padStart(9)} ${'ROI'.padStart(8)} ${'win'.padStart(7)}`);
  for (const c of cities.slice(0, top)) {
    log(
      `  ${c.city.slice(0, 18).padEnd(18)} ${c.region.slice(0, 16).padEnd(16)} ${String(c.nResolved).padStart(4)} ${usd(c.stakeUsd).padStart(8)} ${usd(c.grossPnlUsd).padStart(9)} ${pct(c.roiGross).padStart(8)} ${pct(c.hitRate).padStart(7)}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// args + modes
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReplicaArgs {
  mode: 'backtest' | 'forward';
  from: string;
  to: string;
  cities?: string[];
  strat: ReplicaStrategy;
  minCityN: number;
  top: number;
  outDir: string;
  net: boolean;
  json: boolean;
  rankOnly: boolean;
  /** Widen resolution with Gamma (~97%) over the FULL window instead of DB-resolved-only (~45%). */
  gamma: boolean;
  /** Disk cache for Gamma resolutions (re-runs are instant). */
  resCache: string;
  /** Project the run into Postgres (replica_positions/_runs) so /replica can render it (migration 0053). */
  persist: boolean;
}

export interface ReplicaDeps {
  db: Db;
  log: (m: string) => void;
  /** Current time (unix s) — injectable so the forward run + tests are deterministic. */
  nowSec: number;
}

/** BACKTEST: run the engine over the resolved historical window, write the ledger + CSV, rank cities. */
export async function runBacktest(args: ReplicaArgs, deps: ReplicaDeps): Promise<ReplicaSummary> {
  const { db, log } = deps;
  log(`Loading candidates ${args.from} → ${args.to}${args.cities ? ` · cities ${args.cities.join(',')}` : ' · all cities'} …`);
  // --gamma loads the FULL window (resolvedOnly=false) so the bigger seed isn't bottlenecked by the
  // ~45% DB-resolved cluster; resolution is then filled by Gamma (~97%) on the selected buys.
  const candidates = await loadCandidates(db, { from: args.from, to: args.to, cities: args.cities, resolvedOnly: !args.gamma });
  log(`Loaded ${candidates.length} buyable Yes-bucket candidates with a book (${args.gamma ? 'full window; Gamma resolution' : 'DB-resolved only'}).`);

  const nBandEligible = candidates.filter((c) => bandEligible(c, args.strat)).length;
  const buys = selectBuys(candidates, args.strat);
  if (args.gamma) {
    const sel = buys.filter((b) => b.allocated).map((b) => b.candidate);
    log(`Resolving ${sel.length} selected buys via Gamma (cache ${args.resCache}) …`);
    const cov = await resolveViaGamma(sel, { resCache: args.resCache, log });
    log(`  resolved: Gamma ${cov.nGamma} · DB-fallback ${cov.nDbFallback} · still-unresolved ${cov.nUnresolved}`);
  }
  const scored = scoreBuys(buys, args.strat);
  const summary = summarize(scored, { nCandidates: candidates.length, nBandEligible });
  const daily = dailyLedger(scored, { net: args.net });
  const cities = rankCitiesByRoi(scored, { leg: 'makerIdeal', minResolved: args.minCityN });

  log('');
  printSummary(summary, log);
  log('');
  printCities(cities, args.top, log);

  if (args.rankOnly) return summary;

  const subtitle =
    `backtest ${args.from} → ${args.to} · ${args.gamma ? 'Gamma-resolved (~97%)' : 'DB-resolved (~45%)'} · ` +
    `${candidates.length} candidates · ${args.cities ? args.cities.length + ' cities' : 'all cities'}`;
  const ledger = renderLedger({
    title: 'badatmath replica — paper-trial ledger (backtest seed)',
    subtitle,
    strat: args.strat,
    summary,
    daily,
    cities,
    topCities: args.top,
    net: args.net,
  });
  const mdPath = `${args.outDir}/badatmath-replica-ledger.md`;
  const csvPath = `${args.outDir}/badatmath-replica-positions.csv`;
  writeFile(mdPath, ledger);
  writeFile(csvPath, renderCsv(scored));
  log('');
  log(`Ledger → ${mdPath}`);
  log(`Per-position CSV → ${csvPath} (${scored.length} rows)`);

  // Project the backtest seed into Postgres for /replica (only the ALLOCATED buys — the ones that deploy
  // stake). Wrapped so a DB hiccup never fails the (read-only) analytics run.
  if (args.persist) {
    try {
      const rows = scored.filter((s) => s.buy.allocated).map(scoredToRow);
      const n = await persistPositions(db, 'backtest', rows);
      await persistRun(db, {
        mode: 'backtest',
        ranAt: new Date(deps.nowSec * 1000).toISOString(),
        seedFrom: args.from,
        seedTo: args.to,
        whitelist: args.cities ?? [],
        strat: args.strat,
        nCandidates: summary.nCandidates,
        nBand: summary.nBandEligible,
        nSelected: summary.nSelected,
        nAllocated: summary.nAllocated,
        nOpen: summary.nPending,
        nClosed: summary.nResolved,
        nOpened: 0,
        nReconciled: 0,
      });
      log(`Persisted ${n} backtest positions → replica_positions (source=backtest) for /replica.`);
    } catch (e) {
      log(`WARN: backtest persistence skipped (${String(e)}). The ledger/CSV were still written.`);
    }
  }

  if (args.json) log('\nJSON ' + JSON.stringify({ summary, daily, cities: cities.slice(0, args.top) }));
  return summary;
}

// runForward is implemented in the forward section below (task 5).

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// self-test + CLI
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A no-network self-test of the pure formatting + label helpers (the research-script idiom). */
export function sanity(): void {
  if (bucketLabel(null, 30, 'C') !== '≤30°C') throw new Error('sanity: bucketLabel ≤');
  if (bucketLabel(29, null, 'C') !== '≥29°C') throw new Error('sanity: bucketLabel ≥');
  if (bucketLabel(29, 30, 'F') !== '29–30°F') throw new Error('sanity: bucketLabel range');
  if (usd(-12) !== '-$12' || usd(12) !== '$12') throw new Error('sanity: usd');
  if (pct(0.123) !== '12.3%' || pct(NaN) !== '—') throw new Error('sanity: pct');
}

function buildStrategy(values: Record<string, string | boolean | undefined>): ReplicaStrategy {
  const num = (k: string, d: number): number => (values[k] != null ? Number(values[k]) : d);
  return {
    ...DEFAULT_REPLICA_STRATEGY,
    cheapBandLo: num('cheap-lo', DEFAULT_REPLICA_STRATEGY.cheapBandLo),
    cheapBandHi: num('cheap-hi', DEFAULT_REPLICA_STRATEGY.cheapBandHi),
    entryLeadHours: num('lead-h', DEFAULT_REPLICA_STRATEGY.entryLeadHours),
    breadthPerCityDay: num('breadth', DEFAULT_REPLICA_STRATEGY.breadthPerCityDay),
    positionStakeUsd: num('stake', DEFAULT_REPLICA_STRATEGY.positionStakeUsd),
    dailyBankrollCapUsd: num('cap', DEFAULT_REPLICA_STRATEGY.dailyBankrollCapUsd),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      cities: { type: 'string' },
      'cheap-lo': { type: 'string' },
      'cheap-hi': { type: 'string' },
      'lead-h': { type: 'string' },
      breadth: { type: 'string' },
      stake: { type: 'string' },
      cap: { type: 'string' },
      'min-city-n': { type: 'string' },
      top: { type: 'string' },
      out: { type: 'string' },
      'rank-cities': { type: 'boolean' },
      net: { type: 'boolean' },
      gamma: { type: 'boolean' },
      'res-cache': { type: 'string' },
      persist: { type: 'boolean' },
      'no-persist': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const args: ReplicaArgs = {
    mode: values.mode === 'forward' ? 'forward' : 'backtest',
    from: values.from ?? '2026-04-21',
    to: values.to ?? '2026-06-21',
    cities: splitList(values.cities),
    strat: buildStrategy(values),
    minCityN: values['min-city-n'] ? Number(values['min-city-n']) : 8,
    top: values.top ? Number(values.top) : 15,
    outDir: values.out ?? 'scripts/research/out',
    net: Boolean(values.net),
    json: Boolean(values.json),
    rankOnly: Boolean(values['rank-cities']),
    gamma: Boolean(values.gamma),
    resCache: values['res-cache'] ?? 'scripts/research/out/badatmath-replica-resolutions.json',
    // Forward runs persist by DEFAULT (the dashboard is a projection of the live state); --no-persist opts
    // out for a dry run. Backtest persists only when asked (--persist), to seed /replica's headline.
    persist: values['no-persist']
      ? false
      : values.mode === 'forward'
        ? true
        : Boolean(values.persist),
  };
  const db = makeScriptDb();
  const deps: ReplicaDeps = { db, log: console.log, nowSec: Math.floor(Date.now() / 1000) };
  try {
    if (args.mode === 'forward') {
      await runForward(args, deps);
    } else {
      await runBacktest(args, deps);
    }
  } finally {
    await db.end();
  }
}
