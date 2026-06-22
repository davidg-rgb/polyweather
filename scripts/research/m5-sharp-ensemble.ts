/**
 * scripts/research/m5-sharp-ensemble — MOVE 5: the sharps as FORECASTERS (BADATMATH-GAP-PLAN.md §3
 * Move 5). The impure twin of `core/sim/sharp-ensemble.ts`.
 *
 * THE QUESTION (the one Move the four falsified angles never asked). §10–§13 falsified every way to
 * *trade* badatmath (all harvesting problems). The forecasting question was never asked: **does the
 * sharp's revealed cheap-spray carry orthogonal information that, folded into a stacked forecaster,
 * beats the market-implied distribution we already lose to?** The honest baseline is the MARKET
 * distribution (the sharper forecaster per KILL-GATE 2 / M3), NOT our EMOS. This script joins
 * badatmath's public revealed picks to our walk-forward EMOS ladder + the market book, then scores a
 * walk-forward "smart-money-consensus" stack against the market.
 *
 * POSTURE: analytics study, NOT a trading green-light. A PASS upgrades the FORECAST/analytics product
 * (a smart-money-consensus distribution); it does NOT reopen the live rail (the harvest is still
 * adverse-selection-bound, §12). A KILL is itself the deliverable. Ships nothing to prod, no
 * migration, never imports `packages/trading`, read-only DB. Pre-registered thresholds frozen in core.
 *
 * THE DATA PATH (all reused, nothing re-derived — the m1-tail-calibration spine):
 *   • badatmath picks  — `crawlActivity` → BUY fills → `toPositions` (per-(condition,outcome) stake).
 *   • OUR EMOS ladder  — the maker-spray spine's `assembleBids` (the db1-forked walk-forward EMOS):
 *                        calibratedP + marketProbAtEntry + bucketWon for the FULL ladder per event.
 *   • the bridge       — `market_buckets.condition_id → (event_id, bucket_idx)` glues the sharp's 0x
 *                        per-bucket conditionId to our event/bucket so the revealed stake lands on the ladder.
 *   • the anchor       — `forkEqualityRmse` proves our forked EMOS == the LIVE db1 model (byte-equal).
 *
 * Run: pnpm tsx scripts/research/m5-sharp-ensemble.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--leads 1,2] [--stations EHAM,EGLC] [--mc-iters N] [--cache out/badatmath-fills.json]
 *        [--max-pages N] [--json]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  SHARP_ENSEMBLE,
  type ArmScore,
  type EnsembleEvent,
  type SharpEnsembleResult,
  runSharpEnsembleStudy,
} from '../../packages/core/src/index.ts';
import {
  SHARP_WALLET_ADDRESS,
  type WalletActivity,
} from '../../packages/io/src/polymarket-wallet.ts';
import { splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { crawlActivity } from '../lib/polymarket-crawl.ts';
import { toPositions } from './copytrade-feasibility.ts';
// the maker-spray spine = the db1-forked walk-forward EMOS (calibratedP/bucketWon/marketProbAtEntry)
// + the fork-equality gate. Imported via its PUBLIC entrypoints (no CLI side effects on import).
import {
  loadEmosInputs,
  loadEvents,
  loadBucketSeries,
  assembleBids,
  forkEqualityRmse,
} from './maker-spray-feasibility.ts';

export const SCRIPT = 'm5-sharp-ensemble';

const cellKey = (eventId: string, bucketIdx: number): string => `${eventId}|${bucketIdx}`;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// crawl (with --cache to respect Polymarket rate limits — persist your own pulls, handoff §7.3)
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
  const { fills, mode, pagesFetched, windowFrom } = await crawlActivity(wallet, {
    maxPages: opts.maxPages,
    from: opts.from,
  });
  opts.log(`Crawl: mode=${mode}, pages=${pagesFetched}, earliest=${windowFrom ?? 'n/a'}, fills=${fills.length}`);
  const buys = fills.filter((f) => f.type === 'TRADE' && f.side === 'BUY');
  if (opts.cache) {
    mkdirSync(dirname(opts.cache), { recursive: true });
    writeFileSync(opts.cache, JSON.stringify(buys));
    opts.log(`Cached ${buys.length} BUY fills to ${opts.cache}`);
  }
  return buys;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the bridge: badatmath's 0x conditionId → our (event_id, bucket_idx). Read-only, chunked.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

async function bridgeConditionIds(
  db: Db,
  conditionIds: string[],
): Promise<Map<string, { eventId: string; bucketIdx: number }>> {
  const out = new Map<string, { eventId: string; bucketIdx: number }>();
  const ids = [...new Set(conditionIds.filter((c) => c !== ''))];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.query<{ condition_id: string; event_id: string; bucket_idx: number }>(
      `select condition_id, event_id, bucket_idx from market_buckets where condition_id = any($1)`,
      [chunk],
    );
    for (const r of rows) out.set(r.condition_id, { eventId: r.event_id, bucketIdx: r.bucket_idx });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// assemble: our EMOS ladder per event ⨯ the sharp's revealed per-bucket stake → EnsembleEvent[]
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface SharpCell {
  stakeUsd: number;
  entryPrice: number;
}

/**
 * Build the per-lead EnsembleEvent[] the pure study consumes: group our walk-forward EMOS ladder by
 * event, recover the winner from `bucketWon`, and attach the sharp's revealed stake/entry per bucket
 * via the bridge. The pure module owns the cheap-engine cut — we pass ALL of the sharp's revealed
 * stake, not a pre-filtered subset.
 */
function assembleEnsembleEvents(
  bids: import('../../packages/core/src/sim/maker-spray.ts').RestingBid[],
  sharpByCell: Map<string, SharpCell>,
  lead: number,
): EnsembleEvent[] {
  const byEvent = new Map<string, typeof bids>();
  for (const b of bids) {
    const arr = byEvent.get(b.conditionId);
    if (arr) arr.push(b);
    else byEvent.set(b.conditionId, [b]);
  }
  const events: EnsembleEvent[] = [];
  for (const [eventId, group] of byEvent) {
    const winner = group.find((b) => b.bucketWon);
    if (!winner) continue; // no winning bucket in our ladder view — skip
    const first = group[0]!;
    const buckets = group
      .slice()
      .sort((a, b) => a.bucketIdx - b.bucketIdx)
      .map((b) => {
        const s = sharpByCell.get(cellKey(eventId, b.bucketIdx));
        return {
          bucketIdx: b.bucketIdx,
          emosP: b.calibratedP,
          marketP: b.marketProbAtEntry,
          sharpStakeUsd: s ? s.stakeUsd : 0,
          sharpEntryPrice: s ? s.entryPrice : null,
        };
      });
    events.push({
      eventId,
      station: first.station,
      citySlug: first.citySlug ?? '',
      targetDate: first.targetDate,
      lead,
      winnerIdx: winner.bucketIdx,
      buckets,
    });
  }
  return events;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// report
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const ppf = (v: number): string => (Number.isFinite(v) ? `${v * 100 >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp` : '—');
const f4 = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : '—');

function reportArm(label: string, a: ArmScore, log: (m: string) => void): void {
  log(
    `  ${label.padEnd(7)} Brier stack ${f4(a.brierStack)}  market ${f4(a.brierBaseline)}  ` +
      `improvement(mkt−stack) ${ppf(a.improvement.mean)} 95% CI [${ppf(a.improvement.lo)}, ${ppf(a.improvement.hi)}]  p=${a.pValue.toFixed(3)} (n=${a.n})`,
  );
}

export interface M5Args {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
  mcIters: number;
  cache?: string;
  maxPages: number;
  json: boolean;
}

export async function runM5(args: M5Args, deps: { db: Db; log: (m: string) => void }): Promise<void> {
  const { db, log } = deps;
  const wallet = SHARP_WALLET_ADDRESS;

  // 1) badatmath's revealed picks → per-bucket Yes-leg stake (the cheap-longshot engine is the Yes leg)
  const buys = await loadBuyFills(wallet, { cache: args.cache, from: args.from, maxPages: args.maxPages, log });
  const positions = toPositions(buys);
  const yesPositions = positions.filter(
    (p) => p.outcome.toLowerCase() === 'yes' && Number.isFinite(p.vwapPrice) && p.vwapPrice > 0,
  );
  log(`\nbadatmath: ${buys.length} BUY fills → ${positions.length} positions → ${yesPositions.length} YES positions`);

  // 2) the bridge: their 0x conditionId → our (eventId, bucketIdx)
  const bridge = await bridgeConditionIds(db, yesPositions.map((p) => p.conditionId));
  const sharpByCell = new Map<string, SharpCell>();
  for (const p of yesPositions) {
    const br = bridge.get(p.conditionId);
    if (!br) continue;
    // a bucket can carry multiple YES positions only if conditionId repeats across outcomes — here one
    // (conditionId,Yes) → one cell; accumulate defensively if the bridge ever maps duplicates.
    const k = cellKey(br.eventId, br.bucketIdx);
    const prev = sharpByCell.get(k);
    if (prev) {
      const total = prev.stakeUsd + p.usdcSize;
      sharpByCell.set(k, {
        stakeUsd: total,
        entryPrice: total > 0 ? (prev.entryPrice * prev.stakeUsd + p.vwapPrice * p.usdcSize) / total : p.vwapPrice,
      });
    } else {
      sharpByCell.set(k, { stakeUsd: p.usdcSize, entryPrice: p.vwapPrice });
    }
  }
  log(`bridged ${sharpByCell.size} (event,bucket) cells the sharp revealed a Yes pick on`);

  // 3) OUR walk-forward EMOS ladder per (eventId, bucketIdx) for each lead — the maker-spray spine, once.
  const emos = await loadEmosInputs(db, { to: args.to, stations: args.stations, leads: args.leads });
  const events = await loadEvents(db, { from: args.from, to: args.to, icaos: emos.icaos });
  const seriesMap = await loadBucketSeries(db, { icaos: emos.icaos, from: args.from, to: args.to, lookbackDays: 1 });

  // 4) the correctness anchor — our forked EMOS == the LIVE db1 model (byte-equal RMSE)
  const forkEq = await forkEqualityRmse(db, { from: args.from, to: args.to, leads: args.leads, stations: args.stations });

  // ── report header ─────────────────────────────────────────────────────────────────────────────
  log(`\n══════════ M5 SHARP-AS-FORECASTER STACK — badatmath (${wallet}) ══════════`);
  log(`window ${args.from} → ${args.to} · leads ${args.leads.join(',')} · cheap<${SHARP_ENSEMBLE.cheapMax} · tiltλ ${SHARP_ENSEMBLE.tiltLambda} · mc-iters ${args.mcIters}`);
  log(`scope: ${emos.icaos.length} stations · ${events.length} resolved bucket events`);
  log(
    `FORK-EQUALITY: db1 ${f4(forkEq.db1Rmse)}°C vs maker fork ${f4(forkEq.makerRmse)}°C → equal=${forkEq.equal}` +
      (forkEq.equal ? '' : '  ✗ FORK MISMATCH — EMOS ladder is NOT the live model; result UNTRUSTWORTHY'),
  );

  const perLead: { lead: number; res: SharpEnsembleResult }[] = [];
  for (const lead of args.leads) {
    const { bids } = assembleBids(emos, events, seriesMap, {
      from: args.from,
      to: args.to,
      leads: [lead],
      entryLeadHours: lead * 24,
    });
    const ensembleEvents = assembleEnsembleEvents(bids, sharpByCell, lead);
    const res = runSharpEnsembleStudy(ensembleEvents, { mcIters: args.mcIters });
    perLead.push({ lead, res });

    log(`\n──────── LEAD ${lead} (entry ${lead * 24}h before resolution) ────────`);
    log(`  universe: ${res.n} sharp-touched events with all 3 forecasters defined (of ${res.nSeen} seen)`);
    log('  ── stacked arms vs the MARKET baseline (improvement = Brier_market − Brier_stack; POSITIVE ⇒ sharper) ──');
    reportArm('M+S', res.marketVsSharp, log); // the BINDING arm
    reportArm('M+E', res.marketVsEmos, log); // the EMOS control (expect ≈0/neg per KILL-GATE 2)
    reportArm('M+E+S', res.fullStack, log); // the full smart-money consensus
    log(
      `  marginal sharp (Brier_{M+E} − Brier_{M+E+S}) ${ppf(res.marginalSharp.mean)} 95% CI [${ppf(res.marginalSharp.lo)}, ${ppf(res.marginalSharp.hi)}]  ← >0 ⇒ sharp adds beyond market+our-forecast`,
    );
    log(
      `  zero-skill MC: P(PASS | shuffled sharp) ${Number.isFinite(res.zeroSkill.pPass) ? (res.zeroSkill.pPass * 100).toFixed(1) + '%' : '—'} over ${res.zeroSkill.iters} iters  ← MUST be < ${(SHARP_ENSEMBLE.zeroSkillMax * 100).toFixed(0)}% to trust the gate`,
    );
    log(`  ── VERDICT (lead ${lead}): ${res.verdict.case} ──`);
    log(`     ${res.verdict.summary}`);
    log(`     → ${res.verdict.next}`);

    if (args.json) log('\nJSON ' + JSON.stringify({ lead, ...res }));
  }

  // ── verdict stability across leads (the maker-spray / m1 discipline) ───────────────────────────
  const cases = perLead.map((x) => x.res.verdict.case);
  const stable = cases.every((c) => c === cases[0]);
  log(`\n──────── CROSS-LEAD STABILITY ────────`);
  log(`  verdicts: ${perLead.map((x) => `lead${x.lead}=${x.res.verdict.case}`).join('  ')}  → ${stable ? 'STABLE ✓' : 'UNSTABLE ✗ (lead-sensitive — do NOT trust a lone result)'}`);
  log('');
  log('  Reminder (the reframe): Move 5 is an ANALYTICS study. A PASS upgrades the FORECAST product (the');
  log('  smart-money-consensus distribution) — it does NOT reopen the live rail (the harvest is still');
  log('  adverse-selection-bound, §12). A KILL confirms the analytics-product destination (Move 10). The');
  log('  measurement IS the deliverable: the #1 weather sharp scored as a forecaster against the market.');
}

/** A tiny self-test of the frozen wiring (no network, no DB). */
function sanity(): void {
  const mkBuckets = (winner: number, sharpPick: number) =>
    [0, 1, 2].map((idx) => ({
      bucketIdx: idx,
      emosP: [0.4, 0.35, 0.25][idx]!,
      marketP: [0.4, 0.35, 0.25][idx]!,
      sharpStakeUsd: idx === sharpPick ? 100 : 0,
      sharpEntryPrice: idx === sharpPick ? 0.1 : null,
    }));
  // sharp bets the true winner → PASS; sharp always bucket 0 → KILL.
  const info: EnsembleEvent[] = Array.from({ length: 90 }, (_, i) => ({
    eventId: `e${i}`,
    station: 'EHAM',
    citySlug: 'amsterdam',
    targetDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    lead: 1,
    winnerIdx: i % 3,
    buckets: mkBuckets(i % 3, i % 3),
  }));
  const a = runSharpEnsembleStudy(info, { mcIters: 25 });
  if (a.verdict.case !== 'SHARP_ADDS_SKILL') throw new Error(`sanity: expected PASS, got ${a.verdict.case}`);
  const noise: EnsembleEvent[] = info.map((e, i) => ({ ...e, buckets: mkBuckets(i % 3, 0) }));
  const k = runSharpEnsembleStudy(noise, { mcIters: 25 });
  if (k.verdict.pass) throw new Error('sanity: expected KILL on an uncorrelated sharp pick');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      leads: { type: 'string' },
      stations: { type: 'string' },
      'mc-iters': { type: 'string' },
      cache: { type: 'string' },
      'max-pages': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: M5Args = {
      from: values.from ?? '2026-04-21',
      to: values.to ?? '2026-06-21',
      leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
      stations: splitList(values.stations),
      mcIters: values['mc-iters'] ? Number(values['mc-iters']) : SHARP_ENSEMBLE.mcIters,
      cache: values.cache ?? 'scripts/research/out/badatmath-fills.json',
      maxPages: values['max-pages'] ? Number(values['max-pages']) : 1000,
      json: Boolean(values.json),
    };
    await runM5(args, { db, log: console.log });
  } finally {
    await db.end();
  }
}
