/**
 * scripts/research/copytrade-feasibility — the copy-trade (fill-mirror) feasibility study
 * (WALLET-RECON-HANDOFF.md §11). The one replication path KILL-GATE 2 left open.
 *
 * THE QUESTION. KILL-GATE 2 proved our forecast can't beat the day-before market, so badatmath's
 * protocol run on OUR forecast loses. But badatmath BEATS the market. The only path left to "get as
 * close to its automated buying protocol as possible" is to MIRROR its revealed bucket choices —
 * copy-trade — riding its forecast for free. Nobody measured whether a FOLLOWER can capture it. This
 * script does: it crawls badatmath's BUY fills, joins each to the bucket's market_snapshots book
 * time-series + resolution, and asks whether a follower who detects the trade and TAKES the ask still
 * nets a positive EV after the spread, the 5% taker fee (badatmath earns the maker rebate; a follower
 * does not), and a realistic detection lag.
 *
 * POSTURE: analytics study, NOT a trading green-light. Ships nothing to prod. The PRE-REGISTERED
 * kill-criterion (core/sim/copy-trade copyTradeVerdict): the follower fee-net EV 95% bootstrap CI
 * lower bound must clear 0. CI straddles 0 → "late follower" confirmed; the clean efficiency
 * measurement IS the deliverable; the live rail stays dormant. Do NOT move the criterion to fit the
 * result (WO-5 discipline). A PASS is the new out-of-market information the project posture requires
 * to even consider re-opening the rail — and only THEN is execution wired.
 *
 * THE 30-MIN SNAPSHOT GRID is the binding limitation (see core/sim/copy-trade): we cannot resolve a
 * sub-grid 5-min lag, so the realistic entry is the first snapshot at/after the fill (≈15 min of
 * baked-in drift on a uniform grid — conservative for a follower chasing). Contemporaneous-ask and
 * maker-at-fill-price bounds are reported alongside.
 *
 * The heavy pure analytics live in @weather-edge/core (sim/copy-trade.ts — unit-tested); this script
 * is the impure spine: crawl (with --cache to respect Polymarket rate limits), DB join, print.
 *
 * Run: pnpm tsx scripts/research/copytrade-feasibility.ts [--wallet 0x..] [--cache file.json]
 *        [--from YYYY-MM-DD] [--lag SECONDS] [--max-staleness SECONDS] [--cheap-max 0.25]
 *        [--margin 0.02] [--max-pages N] [--json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  type BucketSnapshot,
  copyTradeVerdict,
  type MirrorFill,
  simulateMirror,
} from '../../packages/core/src/index.ts';
import {
  SHARP_WALLET_ADDRESS,
  type WalletActivity,
} from '../../packages/io/src/polymarket-wallet.ts';
import { loadEnv } from '../lib/load-env.ts';
import { crawlActivity } from '../lib/polymarket-crawl.ts';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// fills → positions (the realistic mirror unit: one follower entry per detected NEW position, not per
// micro-fill — badatmath splits a position across many tiny fills; mirroring each would inflate n with
// perfectly-correlated outcomes. We enter ONCE, at the first fill's time, at the prevailing ask.)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Position {
  conditionId: string;
  outcome: string;
  /** Volume-weighted entry price across the position's BUY fills (badatmath's blended maker entry). */
  vwapPrice: number;
  sizeShares: number;
  usdcSize: number;
  /** First BUY timestamp — the moment a follower would first detect the entry. */
  firstTs: number;
  citySlug: string | null;
  targetDate: string | null;
}

/** Aggregate BUY TRADE fills into one position per (conditionId, outcome). Pure. */
export function toPositions(buys: WalletActivity[]): Position[] {
  const m = new Map<string, Position & { _pw: number }>();
  for (const f of buys) {
    if (f.conditionId === '' || !Number.isFinite(f.price) || f.price <= 0 || f.price > 1) continue;
    if (!Number.isFinite(f.sizeShares) || f.sizeShares <= 0) continue;
    const key = `${f.conditionId}|${f.outcome}`;
    let p = m.get(key);
    if (!p) {
      p = {
        conditionId: f.conditionId,
        outcome: f.outcome,
        vwapPrice: 0,
        sizeShares: 0,
        usdcSize: 0,
        firstTs: f.timestamp,
        citySlug: f.citySlug,
        targetDate: f.targetDate,
        _pw: 0,
      };
      m.set(key, p);
    }
    p._pw += f.price * f.sizeShares;
    p.sizeShares += f.sizeShares;
    p.usdcSize += f.usdcSize;
    p.firstTs = Math.min(p.firstTs, f.timestamp);
    if (p.citySlug === null && f.citySlug !== null) p.citySlug = f.citySlug;
    if (p.targetDate === null && f.targetDate !== null) p.targetDate = f.targetDate;
  }
  return [...m.values()].map(({ _pw, ...p }) => ({ ...p, vwapPrice: p.sizeShares > 0 ? _pw / p.sizeShares : 0 }));
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// DB join: bucket meta + resolution + snapshot series
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface BucketMeta {
  bucketId: string;
  bucketIdx: number;
  feeRate: number;
  /** 'win' | 'lose' | null — leg-level YES resolution from market_buckets. */
  resolvedOutcome: string | null;
  winningBucketIdx: number | null;
  targetDate: string | null;
  resolvedAt: number | null;
}

/** Resolve whether the leg the wallet BOUGHT won. Prefers leg-level resolved_outcome; falls back to
 *  the event's winning_bucket_idx. null when neither is known (unresolved/unknown → dropped). */
export function outcomeWonFor(outcome: string, meta: BucketMeta): boolean | null {
  const isYes = outcome.toLowerCase() === 'yes';
  if (meta.resolvedOutcome === 'win') return isYes ? true : false;
  if (meta.resolvedOutcome === 'lose') return isYes ? false : true;
  if (meta.winningBucketIdx != null) {
    const yesWon = meta.bucketIdx === meta.winningBucketIdx;
    return isYes ? yesWon : !yesWon;
  }
  return null;
}

async function loadBucketMeta(db: ScriptDb, conditionIds: string[]): Promise<Map<string, BucketMeta>> {
  const out = new Map<string, BucketMeta>();
  const ids = [...new Set(conditionIds)];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.query<{
      condition_id: string; bucket_id: string; bucket_idx: number; fee_rate: string | null;
      resolved_outcome: string | null; winning_bucket_idx: number | null;
      target_date: string | Date | null; resolved_at: string | Date | null;
    }>(
      `select mb.condition_id, mb.id bucket_id, mb.bucket_idx, mb.fee_rate, mb.resolved_outcome,
              me.winning_bucket_idx, me.target_date, me.resolved_at
       from market_buckets mb join market_events me on me.id = mb.event_id
       where mb.condition_id = any($1)`,
      [chunk],
    );
    for (const r of rows) {
      out.set(r.condition_id, {
        bucketId: r.bucket_id,
        bucketIdx: r.bucket_idx,
        feeRate: r.fee_rate == null ? 0.05 : Number(r.fee_rate),
        resolvedOutcome: r.resolved_outcome,
        winningBucketIdx: r.winning_bucket_idx,
        targetDate: r.target_date == null ? null : String(r.target_date).slice(0, 10),
        resolvedAt: r.resolved_at == null ? null : Math.floor(new Date(r.resolved_at).getTime() / 1000),
      });
    }
  }
  return out;
}

async function loadSnapshots(db: ScriptDb, bucketIds: string[]): Promise<Map<string, BucketSnapshot[]>> {
  const out = new Map<string, BucketSnapshot[]>();
  const ids = [...new Set(bucketIds)];
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.query<{
      bucket_id: string; captured_at: string | Date; best_bid: string | null; best_ask: string | null; mid: string | null;
    }>(
      `select bucket_id, captured_at, best_bid, best_ask, mid
       from market_snapshots where bucket_id = any($1) order by bucket_id, captured_at asc`,
      [chunk],
    );
    for (const r of rows) {
      const arr = out.get(r.bucket_id) ?? [];
      arr.push({
        capturedAt: Math.floor(new Date(r.captured_at).getTime() / 1000),
        bid: r.best_bid == null ? null : Number(r.best_bid),
        ask: r.best_ask == null ? null : Number(r.best_ask),
        mid: r.mid == null ? null : Number(r.mid),
      });
      out.set(r.bucket_id, arr);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// crawl (with --cache to respect Polymarket rate limits — persist your own pulls, handoff §7.3)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

async function loadFills(
  wallet: string,
  opts: { cache?: string; from?: string; maxPages: number },
): Promise<WalletActivity[]> {
  if (opts.cache && existsSync(opts.cache)) {
    const raw = JSON.parse(readFileSync(opts.cache, 'utf8')) as WalletActivity[];
    console.log(`Loaded ${raw.length} cached fills from ${opts.cache}`);
    return raw;
  }
  console.log(`Crawling /activity for ${wallet}${opts.from ? ` from ${opts.from}` : ''} (maxPages=${opts.maxPages}) …`);
  // The windowed crawler defeats the ~4,000 offset cap (badatmath has tens of thousands of fills); --from
  // makes it a regime window that stops once it pages past the start.
  const { fills, mode, pagesFetched, windowFrom } = await crawlActivity(wallet, {
    maxPages: opts.maxPages,
    from: opts.from,
  });
  console.log(`Crawl: mode=${mode}, pages=${pagesFetched}, earliest=${windowFrom ?? 'n/a'}, fills=${fills.length}`);
  const buys = fills.filter((f) => f.type === 'TRADE' && f.side === 'BUY');
  if (opts.cache) {
    writeFileSync(opts.cache, JSON.stringify(buys));
    console.log(`Cached ${buys.length} BUY fills to ${opts.cache}`);
  }
  return buys;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// protocol-spec extras (the reverse-engineering deliverable that the same pipeline yields)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const quantile = (sortedAsc: number[], q: number): number =>
  sortedAsc.length === 0 ? NaN : sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))]!;

function printProtocolSpec(positions: Position[], meta: Map<string, BucketMeta>): void {
  // lead time: hours from first fill to resolution (resolved_at, else target_date+1d 00:00 UTC).
  const leadsH: number[] = [];
  const stakes: number[] = [];
  const byCityDay = new Map<string, number>(); // city|targetDate → distinct buckets bought
  for (const p of positions) {
    stakes.push(p.usdcSize);
    const m = meta.get(p.conditionId);
    const resolveTs = m?.resolvedAt ?? (p.targetDate ? Math.floor(Date.parse(`${p.targetDate}T24:00:00Z`) / 1000) : null);
    if (resolveTs) leadsH.push((resolveTs - p.firstTs) / 3600);
    if (p.citySlug && p.targetDate) {
      const k = `${p.citySlug}|${p.targetDate}`;
      byCityDay.set(k, (byCityDay.get(k) ?? 0) + 1);
    }
  }
  leadsH.sort((a, b) => a - b);
  stakes.sort((a, b) => a - b);
  const bucketsPerCityDay = [...byCityDay.values()].sort((a, b) => a - b);

  console.log('\n── PROTOCOL SPEC (reverse-engineered from the fills) ──');
  console.log(`  positions: ${positions.length}  (distinct city·day events: ${byCityDay.size})`);
  console.log(
    `  lead time to resolution (h):  p10 ${quantile(leadsH, 0.1).toFixed(1)}  median ${quantile(leadsH, 0.5).toFixed(1)}  ` +
      `p90 ${quantile(leadsH, 0.9).toFixed(1)}   (frac <36h = day-before/day-of: ${(leadsH.filter((h) => h < 36).length / Math.max(1, leadsH.length) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  stake/position ($):           p10 ${quantile(stakes, 0.1).toFixed(2)}  median ${quantile(stakes, 0.5).toFixed(2)}  ` +
      `p90 ${quantile(stakes, 0.9).toFixed(2)}`,
  );
  console.log(
    `  buckets bought per city·day:  median ${quantile(bucketsPerCityDay, 0.5).toFixed(0)}  ` +
      `p90 ${quantile(bucketsPerCityDay, 0.9).toFixed(0)}  max ${bucketsPerCityDay.length ? bucketsPerCityDay[bucketsPerCityDay.length - 1] : 0}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');

async function main(): Promise<void> {
  loadEnv();
  const { values } = parseArgs({
    options: {
      wallet: { type: 'string' },
      cache: { type: 'string' },
      from: { type: 'string' },
      lag: { type: 'string' },
      'max-staleness': { type: 'string' },
      'cheap-max': { type: 'string' },
      margin: { type: 'string' },
      'max-pages': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const wallet = (values.wallet ?? SHARP_WALLET_ADDRESS).toLowerCase();
  const from = values.from ?? '2026-05-14'; // market_snapshots start; earlier fills can't be joined anyway
  const detectionLagSec = values.lag ? Number(values.lag) : 300;
  const maxEntryStalenessSec = values['max-staleness'] ? Number(values['max-staleness']) : 3600;
  const cheapMaxPrice = values['cheap-max'] ? Number(values['cheap-max']) : 0.25;
  const marginThreshold = values.margin ? Number(values.margin) : 0.02;
  const maxPages = values['max-pages'] ? Number(values['max-pages']) : 1000;

  const buys = await loadFills(wallet, { cache: values.cache, from, maxPages });
  const positions = toPositions(buys);
  console.log(`Aggregated ${buys.length} BUY fills → ${positions.length} positions`);

  const db = makeScriptDb();
  try {
    const meta = await loadBucketMeta(db, positions.map((p) => p.conditionId));
    const bucketIds = [...new Set(positions.map((p) => meta.get(p.conditionId)?.bucketId).filter((x): x is string => !!x))];
    const snaps = await loadSnapshots(db, bucketIds);
    console.log(`Joined ${meta.size}/${positions.length} positions to a bucket; ${snaps.size} buckets have snapshots`);

    const mirrorFills: MirrorFill[] = positions.map((p) => {
      const m = meta.get(p.conditionId);
      return {
        conditionId: p.conditionId,
        outcome: p.outcome,
        fillPrice: p.vwapPrice,
        sizeShares: p.sizeShares,
        usdcSize: p.usdcSize,
        timestamp: p.firstTs,
        citySlug: p.citySlug,
        targetDate: p.targetDate,
        outcomeWon: m ? outcomeWonFor(p.outcome, m) : null,
        feeRate: m?.feeRate ?? 0.05,
        snapshots: m ? snaps.get(m.bucketId) ?? [] : [],
      };
    });

    const report = simulateMirror(mirrorFills, { detectionLagSec, maxEntryStalenessSec, cheapMaxPrice });
    const verdict = copyTradeVerdict(report, { marginThreshold });

    // ---- readout ----
    console.log(`\n══════════ COPY-TRADE FEASIBILITY — ${wallet} ══════════`);
    console.log(
      `params: lag=${detectionLagSec}s  maxStaleness=${maxEntryStalenessSec}s  cheap<${cheapMaxPrice}  margin=+${(marginThreshold * 100).toFixed(0)}%`,
    );
    console.log(
      `fills=${report.nFills}  cheap+resolved positions=${report.nCheapResolved}  usable (with follower entry)=${report.nUsable}`,
    );

    console.log('\n── badatmath maker character ──');
    console.log(
      `  fillPrice − mid:  mean ${pctf(report.fillVsMid.mean)}   frac below mid ${pctf(report.fillVsMid.fracBelowMid)}  (n=${report.fillVsMid.n})` +
        '   ← negative/high-frac ⇒ it buys passively as a MAKER',
    );
    console.log('\n── post-fill price discovery (signed mid drift TOWARD its bucket) ──');
    console.log(
      `  mean drift ${pctf(report.driftToward.mean)}  95% CI [${pctf(report.driftToward.ciLo)}, ${pctf(report.driftToward.ciHi)}]  (n=${report.driftToward.n})` +
        '   ← positive ⇒ room a follower could ride',
    );
    console.log(
      `  follower-entry staleness: median ${(report.entryStaleness.medianSec / 60).toFixed(0)}m  p90 ${(report.entryStaleness.p90Sec / 60).toFixed(0)}m  (30-min-grid diagnostic)`,
    );

    console.log('\n── EDGE: the sharp vs a taker-follower ──');
    const sg = report.sharpGross;
    const fg = report.followerGross;
    console.log(`  sharp @ its fill price (fee-free):   n=${sg.nGraded}  hit ${f3(sg.hitRate)}  avgAsk ${f3(sg.avgAsk)}  EV/$1 ${f3(sg.ev)} [${f3(sg.evCiLo)}, ${f3(sg.evCiHi)}]`);
    console.log(`  follower @ post-fill ask (fee-free): n=${fg.nGraded}  hit ${f3(fg.hitRate)}  avgAsk ${f3(fg.avgAsk)}  EV/$1 ${f3(fg.ev)} [${f3(fg.evCiLo)}, ${f3(fg.evCiHi)}]`);
    // The low-variance lens (db1's primary metric): mean (hit − ask). EV/$1 is heavy-tailed on longshots,
    // so its CI is enormous; the paired hit−ask gap has a tight normal CI and tells the clean story —
    // taking the ask (above the bid the sharp made) on a 12%-hit set is a clearly NEGATIVE per-bet edge.
    console.log(`  sharp    edge (hit−ask):  ${pctf(sg.edge)}  95% CI [${pctf(sg.edgeCiLo)}, ${pctf(sg.edgeCiHi)}]`);
    console.log(`  follower edge (hit−ask):  ${pctf(fg.edge)}  95% CI [${pctf(fg.edgeCiLo)}, ${pctf(fg.edgeCiHi)}]   ← LOW-VARIANCE; negative ⇒ taking the ask loses`);
    console.log(`  capturable fraction (follower net ÷ sharp gross EV): ${pctf(report.capturableFraction)}  (heavy-tail EV ratio — read with care)`);

    console.log('\n── FOLLOWER fee-net EV per $1 (the headline + bounds) ──');
    const line = (label: string, e: { ev: number; evCiLo: number; evCiHi: number; n: number }) =>
      console.log(`  ${label.padEnd(34)} n=${String(e.n).padStart(4)}  EV/$1 ${pctf(e.ev).padStart(8)}  95% CI [${pctf(e.evCiLo)}, ${pctf(e.evCiHi)}]`);
    line('★ taker @ post-fill ask (primary)', report.followerNet);
    line('  taker @ contemporaneous ask', report.followerNetContemporaneous);
    line('  maker @ sharp fill price (bound)', report.followerNetMaker);

    printProtocolSpec(positions, meta);

    console.log('\n──────── VERDICT (pre-registered: follower fee-net EV CI must clear 0) ────────');
    console.log(`  ${verdict.summary}`);
    console.log(
      `  → ${verdict.pass ? (verdict.clearsMargin ? 'PASS — copy-trade VIABLE; this is the new out-of-market info to consider the live rail' : 'PASS but sub-margin — viable yet too thin for the operational risk') : 'FAIL — copy-trade NOT viable; the market is efficient to a mirror; live rail stays DORMANT'}`,
    );

    if (values.json) {
      console.log('\nJSON ' + JSON.stringify({ report, verdict, params: { wallet, from, detectionLagSec, maxEntryStalenessSec, cheapMaxPrice, marginThreshold } }));
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('copytrade-feasibility crashed:', err?.message ?? err);
    process.exit(1);
  });
}
