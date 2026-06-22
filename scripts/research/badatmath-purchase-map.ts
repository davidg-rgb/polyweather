/**
 * scripts/research/badatmath-purchase-map — a FORENSIC map of every badatmath purchase in a window
 * (default the vertical-PnL period 2026-05-23 → 2026-06-21), every win/loss scored, and the purchasing
 * patterns described in depth. Read-only; ships nothing to prod; never imports `packages/trading`.
 *
 * THE UNIT. badatmath splits one decision into many micro-fills. This maps at TWO granularities:
 *   • FILL — every individual BUY order execution (the "every single purchase" raw count).
 *   • POSITION — fills aggregated per (conditionId, outcome) = one bucket bet on one city·day·side.
 *     This is the meaningful "purchase" the win/loss + P&L attach to.
 *
 * WIN/LOSS + P&L. A bucket market's Yes leg pays $1 iff that bucket wins; the No leg pays $1 iff it does
 * NOT. Resolution = our DB `market_events.winning_bucket_idx` joined via `market_buckets.condition_id`
 * (the m1/maker-spray bridge). P&L is HOLD-TO-RESOLUTION on the BUY fills (payoff − cost) — it is the
 * per-purchase outcome the operator asked for, NOT the wallet's net realized P&L (which would also net
 * any SELLs the BUY-only cache doesn't carry, plus MERGE/SPLIT — §10 showed that isn't reconstructible
 * to ±2% from public data anyway). Coverage (events that bridge + are resolved in our DB) is reported.
 *
 * Run: pnpm tsx scripts/research/badatmath-purchase-map.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--cache out/badatmath-fills.json] [--max-pages N] [--csv out/badatmath-purchases.csv] [--top N]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { localDayWindow } from '../../packages/core/src/index.ts';
import { POLYMARKET_GAMMA_API, SHARP_WALLET_ADDRESS, type WalletActivity } from '../../packages/io/src/polymarket-wallet.ts';
import { type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { crawlActivity } from '../lib/polymarket-crawl.ts';

export const SCRIPT = 'badatmath-purchase-map';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// PURE: price banding, aggregation, win/loss + hold-to-resolution P&L, quantiles
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export const PRICE_BANDS: { label: string; lo: number; hi: number }[] = [
  { label: '[0.00,0.05)', lo: 0, hi: 0.05 },
  { label: '[0.05,0.10)', lo: 0.05, hi: 0.1 },
  { label: '[0.10,0.15)', lo: 0.1, hi: 0.15 },
  { label: '[0.15,0.25)', lo: 0.15, hi: 0.25 },
  { label: '[0.25,0.45)', lo: 0.25, hi: 0.45 },
  { label: '[0.45,0.75)', lo: 0.45, hi: 0.75 },
  { label: '[0.75,1.00]', lo: 0.75, hi: 1.0001 },
];

export function priceBand(p: number): string {
  for (const b of PRICE_BANDS) if (p >= b.lo && p < b.hi) return b.label;
  return '[0.75,1.00]';
}

/** A BUY fill reduced to the fields the map needs (a structural subset of WalletActivity). */
export interface BuyFill {
  conditionId: string;
  outcome: string;
  price: number;
  sizeShares: number;
  usdcSize: number;
  timestamp: number;
  citySlug: string | null;
  targetDate: string | null;
  kind: 'highest' | 'lowest' | null;
}

/** One position = all BUY fills on a (conditionId, outcome), the meaningful purchase unit. */
export interface Position {
  conditionId: string;
  outcome: string;
  citySlug: string | null;
  targetDate: string | null;
  kind: 'highest' | 'lowest' | null;
  nFills: number;
  vwapPrice: number;
  totalShares: number;
  totalStakeUsd: number;
  firstTs: number;
  lastTs: number;
}

/** Aggregate BUY fills into positions per (conditionId, outcome). Pure. */
export function aggregatePositions(fills: BuyFill[]): Position[] {
  const m = new Map<string, Position & { _pw: number }>();
  for (const f of fills) {
    if (f.conditionId === '' || !Number.isFinite(f.price) || f.price <= 0 || f.price > 1) continue;
    if (!Number.isFinite(f.sizeShares) || f.sizeShares <= 0) continue;
    const key = `${f.conditionId}|${f.outcome}`;
    let p = m.get(key);
    if (!p) {
      p = {
        conditionId: f.conditionId,
        outcome: f.outcome,
        citySlug: f.citySlug,
        targetDate: f.targetDate,
        kind: f.kind,
        nFills: 0,
        vwapPrice: 0,
        totalShares: 0,
        totalStakeUsd: 0,
        firstTs: f.timestamp,
        lastTs: f.timestamp,
        _pw: 0,
      };
      m.set(key, p);
    }
    p.nFills += 1;
    p._pw += f.price * f.sizeShares;
    p.totalShares += f.sizeShares;
    p.totalStakeUsd += f.usdcSize;
    p.firstTs = Math.min(p.firstTs, f.timestamp);
    p.lastTs = Math.max(p.lastTs, f.timestamp);
    if (!p.citySlug && f.citySlug) p.citySlug = f.citySlug;
    if (!p.targetDate && f.targetDate) p.targetDate = f.targetDate;
    if (!p.kind && f.kind) p.kind = f.kind;
  }
  return [...m.values()].map(({ _pw, ...p }) => ({
    ...p,
    vwapPrice: p.totalShares > 0 ? _pw / p.totalShares : 0,
  }));
}

/**
 * Score a purchase to its hold-to-resolution outcome. Yes wins iff its bucket won; No wins iff its
 * bucket did NOT win. Payoff = shares on a win, 0 on a loss; P&L = payoff − cost. Pure.
 */
export function scoreOutcome(
  outcome: string,
  bucketWon: boolean,
  shares: number,
  stakeUsd: number,
): { won: boolean; pnlUsd: number } {
  const isYes = outcome.toLowerCase() === 'yes';
  const won = isYes ? bucketWon : !bucketWon;
  const payoff = won ? shares : 0;
  return { won, pnlUsd: payoff - stakeUsd };
}

export const quantile = (sortedAsc: number[], q: number): number =>
  sortedAsc.length === 0
    ? NaN
    : sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)))]!;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// resolution bridge: conditionId → (event, bucket, winner, ladder, tz, region) — read-only, chunked
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface BucketResolution {
  eventId: string;
  bucketIdx: number;
  low: number | null;
  high: number | null;
  unit: 'C' | 'F';
  region: string;
  tz: string;
  citySlug: string;
  targetDate: string;
  /** null ⇒ event not yet resolved in our DB. */
  winningBucketIdx: number | null;
}

async function bridgeResolutions(
  db: Db,
  conditionIds: string[],
): Promise<Map<string, BucketResolution>> {
  const out = new Map<string, BucketResolution>();
  const ids = [...new Set(conditionIds.filter((c) => c !== ''))];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.query<{
      condition_id: string;
      event_id: string;
      bucket_idx: number;
      low_native: number | null;
      high_native: number | null;
      unit: 'C' | 'F';
      region: string;
      tz: string;
      city_slug: string;
      target_date: string | Date;
      winning_bucket_idx: number | null;
    }>(
      `select mb.condition_id, mb.event_id, mb.bucket_idx, mb.low_native, mb.high_native,
              me.unit, c.region, c.tz, c.slug city_slug, me.target_date, me.winning_bucket_idx
       from market_buckets mb
       join market_events me on me.id = mb.event_id
       join cities c on c.id = me.city_id
       where mb.condition_id = any($1)`,
      [chunk],
    );
    for (const r of rows) {
      out.set(r.condition_id, {
        eventId: r.event_id,
        bucketIdx: r.bucket_idx,
        low: r.low_native == null ? null : Number(r.low_native),
        high: r.high_native == null ? null : Number(r.high_native),
        unit: r.unit,
        region: r.region,
        tz: r.tz,
        citySlug: r.city_slug,
        targetDate: typeof r.target_date === 'string' ? r.target_date.slice(0, 10) : r.target_date.toISOString().slice(0, 10),
        winningBucketIdx: r.winning_bucket_idx,
      });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// AUTHORITATIVE resolution from Polymarket Gamma (our DB resolves only ~45%; Gamma settles ~100%).
// Batch `condition_ids=` (≤50/req): outcomePrices ["1","0"] ⇒ Yes won, ["0","1"] ⇒ No won. Cached to
// disk so re-runs are instant; only genuinely-missing ids are re-fetched. Read-only, public, keyless.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decode gamma's stringified-JSON string array (e.g. '["Yes", "No"]'). Total — [] on junk. */
function parseStrArr(v: unknown): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  if (typeof v !== 'string' || v === '') return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) && p.every((x) => typeof x === 'string') ? (p as string[]) : [];
  } catch {
    return [];
  }
}

/** The winning Yes/No outcome from a resolved market, or null (open / non-Yes-No / un-decisive). */
export function winnerFromGamma(outcomes: string[], prices: string[], closed: unknown): 'Yes' | 'No' | null {
  if (closed !== true || outcomes.length !== prices.length) return null;
  const i = prices.findIndex((p) => p === '1' || Number(p) >= 0.999);
  if (i < 0) return null;
  const w = outcomes[i];
  return w === 'Yes' || w === 'No' ? w : null;
}

/**
 * Resolve every conditionId to its winning Yes/No outcome via Gamma, cache-first. The cache stores
 * 'Yes'|'No'|'unresolved' per id so an open/archived market is not re-fetched. Degrades cleanly: a
 * failed chunk is skipped (its ids stay absent → scored as unresolved, surfaced in coverage).
 */
async function fetchResolutions(
  conditionIds: string[],
  opts: { cache: string; log: (m: string) => void; chunkSize?: number; delayMs?: number },
): Promise<Map<string, 'Yes' | 'No'>> {
  const ids = [...new Set(conditionIds.filter((c) => c !== ''))];
  const chunkSize = Math.min(opts.chunkSize ?? 50, 50);
  const delayMs = opts.delayMs ?? 150;
  const headers = { 'User-Agent': 'polyweather-analytics/1.0', Accept: 'application/json' };

  const cached = new Map<string, 'Yes' | 'No' | 'unresolved'>();
  if (existsSync(opts.cache)) {
    const raw = JSON.parse(readFileSync(opts.cache, 'utf8')) as Record<string, 'Yes' | 'No' | 'unresolved'>;
    for (const [k, v] of Object.entries(raw)) cached.set(k, v);
  }
  const toFetch = ids.filter((id) => !cached.has(id));
  opts.log(`Gamma resolution: ${ids.length} unique conditionIds · ${ids.length - toFetch.length} cached · fetching ${toFetch.length} …`);

  for (let i = 0; i < toFetch.length; i += chunkSize) {
    if (i > 0) await sleep(delayMs);
    const chunk = toFetch.slice(i, i + chunkSize);
    const qs = chunk.map((id) => `condition_ids=${encodeURIComponent(id)}`).join('&');
    try {
      // `closed=true` is REQUIRED: Gamma's /markets defaults to ACTIVE markets and returns [] for
      // resolved ones without it. Open (still-trading) markets are then absent → scored unresolved.
      const r = await fetch(`${POLYMARKET_GAMMA_API}/markets?${qs}&limit=${chunkSize}&closed=true`, { headers });
      const body = (await r.json()) as unknown;
      if (Array.isArray(body)) {
        for (const m of body as Record<string, unknown>[]) {
          const cid = typeof m.conditionId === 'string' ? m.conditionId : '';
          if (!cid) continue;
          cached.set(cid, winnerFromGamma(parseStrArr(m.outcomes), parseStrArr(m.outcomePrices), m.closed) ?? 'unresolved');
        }
      }
    } catch (e) {
      opts.log(`  chunk @${i} failed (${(e as Error)?.message ?? e}) — skipped`);
    }
    // any chunk id Gamma didn't return is archived/missing → mark unresolved so we don't refetch forever
    for (const id of chunk) if (!cached.has(id)) cached.set(id, 'unresolved');
    if (i % (chunkSize * 20) === 0 && i > 0) opts.log(`  …${Math.min(i + chunkSize, toFetch.length)}/${toFetch.length}`);
  }

  mkdirSync(dirname(opts.cache), { recursive: true });
  writeFileSync(opts.cache, JSON.stringify(Object.fromEntries(cached)));
  const out = new Map<string, 'Yes' | 'No'>();
  for (const [k, v] of cached) if (v === 'Yes' || v === 'No') out.set(k, v);
  opts.log(`  resolved Yes/No: ${out.size}/${ids.length} (${pct(out.size / Math.max(1, ids.length))})`);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the scored purchase row (position + resolution + outcome) — the CSV unit
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface ScoredPurchase extends Position {
  region: string | null;
  isUS: boolean | null;
  bucketIdx: number | null;
  low: number | null;
  high: number | null;
  unit: 'C' | 'F' | null;
  bucketLabel: string;
  leadHours: number | null;
  resolved: boolean;
  bucketWon: boolean | null;
  won: boolean | null;
  pnlUsd: number | null;
}

const isoDateUtc = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

function bucketLabelOf(r: BucketResolution | undefined): string {
  if (!r) return '(unbridged)';
  const u = r.unit;
  if (r.low == null && r.high != null) return `≤${r.high}${u}`;
  if (r.high == null && r.low != null) return `≥${r.low}${u}`;
  if (r.low != null && r.high != null) return `${r.low}–${r.high}${u}`;
  return `bucket ${r.bucketIdx}`;
}

/** North America (US/CA airports) — the closest proxy to "US" in our region taxonomy. */
const isNorthAmerica = (region: string | null): boolean | null => (region == null ? null : region.startsWith('na-'));

function scorePurchases(
  positions: Position[],
  bridge: Map<string, BucketResolution>,
  winByCondition: Map<string, 'Yes' | 'No'>,
): ScoredPurchase[] {
  return positions.map((p) => {
    const r = bridge.get(p.conditionId);
    // resolution: Gamma (authoritative, ~complete) PRIMARY; DB winning_bucket_idx fallback.
    let bucketWon: boolean | null = null; // did THIS bucket's Yes leg win?
    const gamma = winByCondition.get(p.conditionId);
    if (gamma) bucketWon = gamma === 'Yes';
    else if (r && r.winningBucketIdx != null) bucketWon = r.bucketIdx === r.winningBucketIdx;
    const resolved = bucketWon != null;

    let won: boolean | null = null;
    let pnlUsd: number | null = null;
    if (resolved) {
      const s = scoreOutcome(p.outcome, bucketWon!, p.totalShares, p.totalStakeUsd);
      won = s.won;
      pnlUsd = s.pnlUsd;
    }
    let leadHours: number | null = null;
    if (r) {
      try {
        const resTs = Math.floor(localDayWindow(r.tz, r.targetDate).endUtc.getTime() / 1000);
        leadHours = (resTs - p.firstTs) / 3600;
      } catch {
        leadHours = null;
      }
    }
    const region = r?.region ?? null;
    return {
      ...p,
      region,
      isUS: isNorthAmerica(region),
      bucketIdx: r?.bucketIdx ?? null,
      low: r?.low ?? null,
      high: r?.high ?? null,
      unit: r?.unit ?? null,
      bucketLabel: bucketLabelOf(r),
      leadHours,
      resolved,
      bucketWon,
      won,
      pnlUsd,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// reporting helpers
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const usd = (v: number): string => (v < 0 ? `-$${Math.abs(v).toFixed(0)}` : `$${v.toFixed(0)}`);
const usd2 = (v: number): string => (v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `$${v.toFixed(2)}`);
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

interface Tally {
  n: number;
  nResolved: number;
  wins: number;
  losses: number;
  stake: number;
  pnl: number;
  grossWin: number;
  grossLoss: number;
}
const emptyTally = (): Tally => ({ n: 0, nResolved: 0, wins: 0, losses: 0, stake: 0, pnl: 0, grossWin: 0, grossLoss: 0 });
function addToTally(t: Tally, p: ScoredPurchase): void {
  t.n += 1;
  t.stake += p.totalStakeUsd;
  if (p.resolved && p.pnlUsd != null) {
    t.nResolved += 1;
    t.pnl += p.pnlUsd;
    if (p.won) {
      t.wins += 1;
      t.grossWin += p.pnlUsd;
    } else {
      t.losses += 1;
      t.grossLoss += p.pnlUsd;
    }
  }
}
const winRate = (t: Tally): number => (t.nResolved === 0 ? NaN : t.wins / t.nResolved);
const roi = (t: Tally): number => (t.stake === 0 ? NaN : t.pnl / t.stake);

function groupTally<T>(rows: ScoredPurchase[], keyFn: (p: ScoredPurchase) => T): Map<T, Tally> {
  const m = new Map<T, Tally>();
  for (const p of rows) {
    const k = keyFn(p);
    let t = m.get(k);
    if (!t) {
      t = emptyTally();
      m.set(k, t);
    }
    addToTally(t, p);
  }
  return m;
}

function reportTallyTable(
  log: (m: string) => void,
  header: string,
  m: Map<string, Tally>,
  sortBy: (t: Tally) => number = (t) => -t.pnl,
): void {
  log(`  ${'group'.padEnd(16)} ${'n'.padStart(6)} ${'resolved'.padStart(8)} ${'win%'.padStart(7)} ${'stake'.padStart(10)} ${'P&L'.padStart(10)} ${'ROI'.padStart(7)}`);
  const entries = [...m.entries()].sort((a, b) => sortBy(a[1]) - sortBy(b[1]));
  for (const [k, t] of entries) {
    log(
      `  ${String(k).padEnd(16)} ${String(t.n).padStart(6)} ${String(t.nResolved).padStart(8)} ${pct(winRate(t)).padStart(7)} ${usd(t.stake).padStart(10)} ${usd(t.pnl).padStart(10)} ${pct(roi(t)).padStart(7)}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// crawl loader (cache-first)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

async function loadBuyFills(
  wallet: string,
  opts: { cache?: string; from: string; maxPages: number; log: (m: string) => void },
): Promise<WalletActivity[]> {
  if (opts.cache && existsSync(opts.cache)) {
    const raw = JSON.parse(readFileSync(opts.cache, 'utf8')) as WalletActivity[];
    opts.log(`Loaded ${raw.length} cached BUY fills from ${opts.cache}`);
    return raw;
  }
  opts.log(`Crawling /activity for ${wallet} from ${opts.from} (maxPages=${opts.maxPages}) …`);
  const { fills, mode, pagesFetched } = await crawlActivity(wallet, { maxPages: opts.maxPages, from: opts.from });
  opts.log(`Crawl: mode=${mode}, pages=${pagesFetched}, fills=${fills.length}`);
  const buys = fills.filter((f) => f.type === 'TRADE' && f.side === 'BUY');
  if (opts.cache) {
    mkdirSync(dirname(opts.cache), { recursive: true });
    writeFileSync(opts.cache, JSON.stringify(buys));
  }
  return buys;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface MapArgs {
  from: string;
  to: string;
  cache?: string;
  maxPages: number;
  csv: string;
  top: number;
  /** Fetch authoritative Yes/No resolution from Polymarket Gamma (default true; --no-gamma to skip). */
  gamma: boolean;
  resCache: string;
}

export async function runMap(args: MapArgs, deps: { db: Db; log: (m: string) => void }): Promise<void> {
  const { db, log } = deps;
  const wallet = SHARP_WALLET_ADDRESS;

  const all = await loadBuyFills(wallet, { cache: args.cache, from: args.from, maxPages: args.maxPages, log });
  const buys = all.filter((f) => f.type === 'TRADE' && f.side === 'BUY');

  // window by UTC trade date [from, to] inclusive
  const fromTs = Date.parse(`${args.from}T00:00:00Z`) / 1000;
  const toTs = Date.parse(`${args.to}T23:59:59Z`) / 1000;
  const spanTs = buys.reduce(
    (a, f) => ({ min: Math.min(a.min, f.timestamp), max: Math.max(a.max, f.timestamp) }),
    { min: Infinity, max: -Infinity },
  );
  const windowed: BuyFill[] = buys.filter((f) => f.timestamp >= fromTs && f.timestamp <= toTs);

  log(`\n══════════ badatmath PURCHASE MAP — ${args.from} → ${args.to} (by UTC trade date) ══════════`);
  log(`cache span: ${isoDateUtc(spanTs.min)} → ${isoDateUtc(spanTs.max)} (${buys.length} total BUY fills)`);
  log(`in window: ${windowed.length} BUY fills`);

  const positions = aggregatePositions(windowed);
  const bridge = await bridgeResolutions(db, positions.map((p) => p.conditionId));
  const winByCondition = args.gamma
    ? await fetchResolutions(positions.map((p) => p.conditionId), { cache: args.resCache, log })
    : new Map<string, 'Yes' | 'No'>();
  const scored = scorePurchases(positions, bridge, winByCondition);

  // ── 0. headline coverage + totals ──────────────────────────────────────────────────────────────
  const overall = emptyTally();
  for (const p of scored) addToTally(overall, p);
  const nBridged = scored.filter((p) => p.bucketIdx != null).length;
  const distinctEvents = new Set(scored.map((p) => `${p.citySlug}|${p.targetDate}`)).size;
  const distinctCities = new Set(scored.map((p) => p.citySlug ?? '?')).size;
  log(`\n── 0. SCALE & COVERAGE ──`);
  log(`  fills: ${windowed.length}  →  positions (city·day·bucket·side): ${positions.length}`);
  log(`  distinct (city,target_date) events: ${distinctEvents}  ·  distinct cities: ${distinctCities}`);
  log(`  fills per position: median ${quantile(positions.map((p) => p.nFills).sort((a, b) => a - b), 0.5)}  max ${Math.max(...positions.map((p) => p.nFills))}`);
  log(`  positions bridged to our DB (enrichment): ${nBridged}/${positions.length} (${pct(nBridged / positions.length)})`);
  log(`  win/loss RESOLVED (Gamma primary + DB fallback): ${overall.nResolved}/${positions.length} (${pct(overall.nResolved / positions.length)})`);
  log(`  total stake (all positions): ${usd(overall.stake)}  ·  stake on resolved: ${usd(scored.filter((p) => p.resolved).reduce((a, p) => a + p.totalStakeUsd, 0))}`);
  log(`  ── WIN/LOSS TALLY (resolved positions, hold-to-resolution) ──`);
  log(`     WINS ${overall.wins}  ·  LOSSES ${overall.losses}  ·  win rate ${pct(winRate(overall))}`);
  log(`     gross winnings ${usd(overall.grossWin)}  ·  gross losses ${usd(overall.grossLoss)}  ·  NET P&L ${usd(overall.pnl)}  ·  ROI/stake ${pct(roi(overall))}`);

  // ── 1. by side (Yes = the cheap-longshot engine; No = the bleed) ────────────────────────────────
  log(`\n── 1. BY SIDE (Yes vs No) ──`);
  reportTallyTable(log, 'side', groupTally(scored, (p) => p.outcome || '(none)'));

  // ── 2. by entry-price band (the cheap-longshot signature) ───────────────────────────────────────
  log(`\n── 2. BY ENTRY-PRICE BAND (vwap; the cheap-longshot signature) ──`);
  const byBand = groupTally(scored, (p) => priceBand(p.vwapPrice));
  // keep band order, not pnl order
  log(`  ${'band'.padEnd(16)} ${'n'.padStart(6)} ${'resolved'.padStart(8)} ${'win%'.padStart(7)} ${'stake'.padStart(10)} ${'P&L'.padStart(10)} ${'ROI'.padStart(7)}`);
  for (const b of PRICE_BANDS) {
    const t = byBand.get(b.label) ?? emptyTally();
    log(
      `  ${b.label.padEnd(16)} ${String(t.n).padStart(6)} ${String(t.nResolved).padStart(8)} ${pct(winRate(t)).padStart(7)} ${usd(t.stake).padStart(10)} ${usd(t.pnl).padStart(10)} ${pct(roi(t)).padStart(7)}`,
    );
  }

  // ── 3. by side × cheap/expensive (the §3 decomposition) ─────────────────────────────────────────
  log(`\n── 3. SIDE × CHEAP(<0.25)/RICH(≥0.25) (the §3 engine-vs-bleed cut) ──`);
  reportTallyTable(log, 'cut', groupTally(scored, (p) => `${p.outcome}/${p.vwapPrice < 0.25 ? 'cheap' : 'rich'}`));

  // ── 4. region: North America vs international ───────────────────────────────────────────────────
  log(`\n── 4. REGION (North America [US/CA] vs international; bridged only) ──`);
  reportTallyTable(log, 'region', groupTally(scored.filter((p) => p.isUS != null), (p) => (p.isUS ? 'North America' : 'international')));
  log(`\n── 4b. BY REGION GROUP (bridged) ──`);
  reportTallyTable(log, 'regionGroup', groupTally(scored.filter((p) => p.region != null), (p) => p.region!));

  // ── 5. top cities by P&L ────────────────────────────────────────────────────────────────────────
  log(`\n── 5. TOP ${args.top} CITIES BY NET P&L (resolved) ──`);
  const byCity = groupTally(scored, (p) => p.citySlug ?? '?');
  const cityEntries = [...byCity.entries()].filter(([, t]) => t.nResolved > 0).sort((a, b) => b[1].pnl - a[1].pnl);
  log(`  ${'city'.padEnd(16)} ${'n'.padStart(6)} ${'resolved'.padStart(8)} ${'win%'.padStart(7)} ${'stake'.padStart(10)} ${'P&L'.padStart(10)} ${'ROI'.padStart(7)}`);
  for (const [k, t] of cityEntries.slice(0, args.top)) {
    log(`  ${k.slice(0, 16).padEnd(16)} ${String(t.n).padStart(6)} ${String(t.nResolved).padStart(8)} ${pct(winRate(t)).padStart(7)} ${usd(t.stake).padStart(10)} ${usd(t.pnl).padStart(10)} ${pct(roi(t)).padStart(7)}`);
  }
  log(`  … bottom ${Math.min(5, cityEntries.length)} (biggest bleed):`);
  for (const [k, t] of cityEntries.slice(-5).reverse()) {
    log(`  ${k.slice(0, 16).padEnd(16)} ${String(t.n).padStart(6)} ${String(t.nResolved).padStart(8)} ${pct(winRate(t)).padStart(7)} ${usd(t.stake).padStart(10)} ${usd(t.pnl).padStart(10)} ${pct(roi(t)).padStart(7)}`);
  }

  // ── 6. by kind (highest vs lowest temperature markets) ──────────────────────────────────────────
  log(`\n── 6. BY MARKET KIND ──`);
  reportTallyTable(log, 'kind', groupTally(scored, (p) => p.kind ?? '(none)'));

  // ── 7. lead time to resolution (the entry-timing pattern) ───────────────────────────────────────
  const leads = scored.map((p) => p.leadHours).filter((h): h is number => h != null && Number.isFinite(h)).sort((a, b) => a - b);
  log(`\n── 7. ENTRY LEAD TIME (first fill → resolution; the timing pattern) ──`);
  log(`  median ${quantile(leads, 0.5).toFixed(1)}h (${(quantile(leads, 0.5) / 24).toFixed(1)}d)  ·  p10 ${quantile(leads, 0.1).toFixed(1)}h  ·  p90 ${quantile(leads, 0.9).toFixed(1)}h  ·  min ${leads[0]?.toFixed(1)}h  ·  max ${leads[leads.length - 1]?.toFixed(1)}h`);
  const leadBands: { label: string; lo: number; hi: number }[] = [
    { label: '<24h (day-of)', lo: -1e9, hi: 24 },
    { label: '24–48h', lo: 24, hi: 48 },
    { label: '48–72h', lo: 48, hi: 72 },
    { label: '72–120h', lo: 72, hi: 120 },
    { label: '≥120h', lo: 120, hi: 1e9 },
  ];
  const byLead = groupTally(
    scored.filter((p) => p.leadHours != null),
    (p) => leadBands.find((b) => p.leadHours! >= b.lo && p.leadHours! < b.hi)?.label ?? '?',
  );
  log(`  ${'leadBand'.padEnd(16)} ${'n'.padStart(6)} ${'resolved'.padStart(8)} ${'win%'.padStart(7)} ${'stake'.padStart(10)} ${'P&L'.padStart(10)} ${'ROI'.padStart(7)}`);
  for (const b of leadBands) {
    const t = byLead.get(b.label) ?? emptyTally();
    log(
      `  ${b.label.padEnd(16)} ${String(t.n).padStart(6)} ${String(t.nResolved).padStart(8)} ${pct(winRate(t)).padStart(7)} ${usd(t.stake).padStart(10)} ${usd(t.pnl).padStart(10)} ${pct(roi(t)).padStart(7)}`,
    );
  }

  // ── 8. spray breadth (buckets per city·day·side) ────────────────────────────────────────────────
  const breadthMap = new Map<string, number>();
  for (const p of scored) {
    const k = `${p.citySlug}|${p.targetDate}|${p.outcome}`;
    breadthMap.set(k, (breadthMap.get(k) ?? 0) + 1);
  }
  const breadth = [...breadthMap.values()].sort((a, b) => a - b);
  log(`\n── 8. SPRAY BREADTH (distinct buckets per city·day·side) ──`);
  log(`  median ${quantile(breadth, 0.5)}  ·  p90 ${quantile(breadth, 0.9)}  ·  max ${breadth[breadth.length - 1]}  (badatmath sprays the plausible range, not one modal bucket)`);

  // ── 9. sizing (per fill + per position) ─────────────────────────────────────────────────────────
  const fillStakes = windowed.map((f) => f.usdcSize).filter((x) => x > 0).sort((a, b) => a - b);
  const posStakes = positions.map((p) => p.totalStakeUsd).filter((x) => x > 0).sort((a, b) => a - b);
  log(`\n── 9. SIZING ──`);
  log(`  per FILL stake (USDC):     median ${usd2(quantile(fillStakes, 0.5))}  p10 ${usd2(quantile(fillStakes, 0.1))}  p90 ${usd2(quantile(fillStakes, 0.9))}  max ${usd2(fillStakes[fillStakes.length - 1] ?? 0)}`);
  log(`  per POSITION stake (USDC): median ${usd2(quantile(posStakes, 0.5))}  p10 ${usd2(quantile(posStakes, 0.1))}  p90 ${usd2(quantile(posStakes, 0.9))}  max ${usd2(posStakes[posStakes.length - 1] ?? 0)}`);

  // ── 10. daily cadence: buys & resolved P&L by date ──────────────────────────────────────────────
  log(`\n── 10. DAILY CADENCE (BUY fills by UTC trade date · resolved P&L by target_date) ──`);
  const fillsByTradeDate = new Map<string, number>();
  for (const f of windowed) fillsByTradeDate.set(isoDateUtc(f.timestamp), (fillsByTradeDate.get(isoDateUtc(f.timestamp)) ?? 0) + 1);
  const pnlByTargetDate = new Map<string, Tally>();
  for (const p of scored) {
    if (!p.targetDate) continue;
    let t = pnlByTargetDate.get(p.targetDate);
    if (!t) {
      t = emptyTally();
      pnlByTargetDate.set(p.targetDate, t);
    }
    addToTally(t, p);
  }
  const allDates = [...new Set([...fillsByTradeDate.keys(), ...pnlByTargetDate.keys()])].sort();
  log(`  ${'date'.padEnd(12)} ${'buys'.padStart(7)} ${'resPos'.padStart(7)} ${'win%'.padStart(7)} ${'P&L(by target)'.padStart(15)}  cumP&L`);
  let cum = 0;
  for (const d of allDates) {
    const nb = fillsByTradeDate.get(d) ?? 0;
    const t = pnlByTargetDate.get(d) ?? emptyTally();
    cum += t.pnl;
    log(`  ${d.padEnd(12)} ${String(nb).padStart(7)} ${String(t.nResolved).padStart(7)} ${pct(winRate(t)).padStart(7)} ${usd(t.pnl).padStart(15)}  ${usd(cum)}`);
  }

  // ── 11. biggest single winners & losers (by position P&L) ───────────────────────────────────────
  const resolvedScored = scored.filter((p) => p.resolved && p.pnlUsd != null);
  const byPnl = resolvedScored.slice().sort((a, b) => (b.pnlUsd ?? 0) - (a.pnlUsd ?? 0));
  const fmtRow = (p: ScoredPurchase): string =>
    `  ${(p.citySlug ?? '?').slice(0, 12).padEnd(12)} ${(p.targetDate ?? '?').padEnd(11)} ${p.outcome.padEnd(3)} ${p.bucketLabel.padEnd(12)} entry ${p.vwapPrice.toFixed(3)} stake ${usd2(p.totalStakeUsd).padStart(9)} → ${p.won ? 'WIN ' : 'LOSS'} ${usd2(p.pnlUsd!).padStart(9)}  (lead ${p.leadHours != null ? p.leadHours.toFixed(0) + 'h' : '—'})`;
  log(`\n── 11. TOP ${args.top} WINNERS (by position P&L) ──`);
  for (const p of byPnl.slice(0, args.top)) log(fmtRow(p));
  log(`\n── 11b. TOP ${args.top} LOSERS (by position P&L) ──`);
  for (const p of byPnl.slice(-args.top).reverse()) log(fmtRow(p));

  // ── 12. write the COMPLETE per-position log to CSV ──────────────────────────────────────────────
  const header = [
    'first_trade_utc', 'last_trade_utc', 'city', 'region', 'target_date', 'kind', 'outcome',
    'bucket_idx', 'bucket_label', 'unit', 'n_fills', 'vwap_price', 'total_shares', 'total_stake_usd',
    'lead_hours', 'resolved', 'bucket_won', 'won', 'pnl_usd', 'condition_id',
  ].join(',');
  const lines = [header];
  for (const p of scored.slice().sort((a, b) => a.firstTs - b.firstTs)) {
    lines.push(
      [
        new Date(p.firstTs * 1000).toISOString(),
        new Date(p.lastTs * 1000).toISOString(),
        p.citySlug ?? '',
        p.region ?? '',
        p.targetDate ?? '',
        p.kind ?? '',
        p.outcome,
        p.bucketIdx ?? '',
        `"${p.bucketLabel}"`,
        p.unit ?? '',
        p.nFills,
        p.vwapPrice.toFixed(4),
        p.totalShares.toFixed(2),
        p.totalStakeUsd.toFixed(2),
        p.leadHours != null ? p.leadHours.toFixed(1) : '',
        p.resolved ? 1 : 0,
        p.bucketWon == null ? '' : p.bucketWon ? 1 : 0,
        p.won == null ? '' : p.won ? 1 : 0,
        p.pnlUsd != null ? p.pnlUsd.toFixed(2) : '',
        p.conditionId,
      ].join(','),
    );
  }
  mkdirSync(dirname(args.csv), { recursive: true });
  writeFileSync(args.csv, lines.join('\n'));
  log(`\n── 12. COMPLETE PER-POSITION LOG written to ${args.csv} (${scored.length} rows) ──`);
  log('  (one row per city·day·bucket·side purchase, sorted by first trade time, with win/loss + P&L)');
}

/** A no-network self-test of the pure scoring + aggregation (the research-script idiom). */
function sanity(): void {
  // aggregation: two fills on the same (condition,outcome) → one position, vwap = stake/shares weighted.
  const fills: BuyFill[] = [
    { conditionId: 'c1', outcome: 'Yes', price: 0.1, sizeShares: 100, usdcSize: 10, timestamp: 100, citySlug: 'ams', targetDate: '2026-06-01', kind: 'highest' },
    { conditionId: 'c1', outcome: 'Yes', price: 0.2, sizeShares: 100, usdcSize: 20, timestamp: 200, citySlug: 'ams', targetDate: '2026-06-01', kind: 'highest' },
  ];
  const [pos] = aggregatePositions(fills);
  if (!pos || pos.nFills !== 2 || Math.abs(pos.vwapPrice - 0.15) > 1e-9 || pos.totalStakeUsd !== 30) {
    throw new Error('sanity: aggregatePositions vwap/stake');
  }
  // a winning Yes: 200 shares cost $30 → payoff 200, P&L +170.
  const w = scoreOutcome('Yes', true, 200, 30);
  if (!w.won || Math.abs(w.pnlUsd - 170) > 1e-9) throw new Error('sanity: winning Yes P&L');
  // a losing Yes: P&L = −stake.
  const l = scoreOutcome('Yes', false, 200, 30);
  if (l.won || l.pnlUsd !== -30) throw new Error('sanity: losing Yes P&L');
  // a No on a bucket that did NOT win → No wins.
  const n = scoreOutcome('No', false, 50, 40);
  if (!n.won || Math.abs(n.pnlUsd - 10) > 1e-9) throw new Error('sanity: winning No P&L');
  // price banding boundaries
  if (priceBand(0.049) !== '[0.00,0.05)' || priceBand(0.05) !== '[0.05,0.10)' || priceBand(0.99) !== '[0.75,1.00]') {
    throw new Error('sanity: priceBand boundaries');
  }
  if (!Number.isFinite(quantile([1, 2, 3, 4], 0.5)) || !Number.isNaN(quantile([], 0.5))) {
    throw new Error('sanity: quantile (finite on data, NaN on empty)');
  }
  // Gamma resolution decode: ["1","0"] ⇒ Yes won, ["0","1"] ⇒ No won, open ⇒ null.
  if (winnerFromGamma(['Yes', 'No'], ['1', '0'], true) !== 'Yes') throw new Error('sanity: winnerFromGamma Yes');
  if (winnerFromGamma(['Yes', 'No'], ['0', '1'], true) !== 'No') throw new Error('sanity: winnerFromGamma No');
  if (winnerFromGamma(['Yes', 'No'], ['0.5', '0.5'], true) !== null) throw new Error('sanity: winnerFromGamma undecided');
  if (winnerFromGamma(['Yes', 'No'], ['1', '0'], false) !== null) throw new Error('sanity: winnerFromGamma open');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      cache: { type: 'string' },
      'max-pages': { type: 'string' },
      csv: { type: 'string' },
      top: { type: 'string' },
      'no-gamma': { type: 'boolean' },
      'res-cache': { type: 'string' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: MapArgs = {
      from: values.from ?? '2026-05-23',
      to: values.to ?? '2026-06-21',
      cache: values.cache ?? 'scripts/research/out/badatmath-fills.json',
      maxPages: values['max-pages'] ? Number(values['max-pages']) : 1000,
      csv: values.csv ?? 'scripts/research/out/badatmath-purchases-may23-jun21.csv',
      top: values.top ? Number(values.top) : 15,
      gamma: !values['no-gamma'],
      resCache: values['res-cache'] ?? 'scripts/research/out/badatmath-resolutions.json',
    };
    await runMap(args, { db, log: console.log });
  } finally {
    await db.end();
  }
}
