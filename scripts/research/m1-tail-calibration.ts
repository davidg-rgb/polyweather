/**
 * scripts/research/m1-tail-calibration — the M1 calibration DIAGNOSIS spine (BADATMATH-GAP-PLAN.md
 * Move 1, §6 "the single next concrete action"). The impure twin of `core/sim/tail-calibration.ts`.
 *
 * THE QUESTION (the one router arm never measured). All four replication angles are falsified
 * (WALLET-RECON-HANDOFF.md §10–§12) — and every one used OUR forecast as the SELECTOR. The reverse,
 * never asked: **do badatmath's REVEALED cheap picks resolve more often than OUR EMOS predicts?** If
 * yes (≥+3pp, CI>0) our tail is underweighted — a fixable forecast (Case A → Move 7). If no (<+1pp,
 * with M2 already FAIL) the forecast is NOT the gap → the analytics product (Move 10). This script
 * scores it on data we already own: badatmath's public `/activity` picks ⨯ our walk-forward EMOS_p.
 *
 * POSTURE: analytics diagnosis, NOT a trading green-light. Ships nothing to prod, no migration, never
 * imports `packages/trading`, read-only DB. A PASS routes to a recalibration EXPERIMENT (Move 7) whose
 * harvest is re-tested by the existing maker-spray sim — it does NOT reopen the live rail. The result
 * feeds the analytics product (the only forensic reconstruction of the #1 weather sharp, scored
 * against a calibrated model) either way. Pre-registered thresholds frozen in core (WO-5 discipline).
 *
 * THE DATA PATH (all reused, nothing re-derived):
 *   • badatmath picks  — `crawlActivity` (the windowed /activity crawler) → BUY fills → `toPositions`
 *                        (copytrade's per-(condition,outcome) aggregator: one position, not micro-fills).
 *   • OUR EMOS_p       — the maker-spray spine's `assembleBids` (the db1-forked walk-forward EMOS):
 *                        calibratedP + bucketWon + marketProbAtEntry per (eventId, bucketIdx, lead).
 *   • the bridge       — `market_buckets.condition_id → (event_id, bucket_idx)` joins their 0x
 *                        conditionId to our event/bucket so the two sides meet.
 *   • the anchor       — `forkEqualityRmse` proves our forked EMOS == the LIVE db1 model (byte-equal).
 *
 * Run: pnpm tsx scripts/research/m1-tail-calibration.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--leads 1,2] [--stations EHAM,EGLC] [--cheap-max 0.25] [--cache out/badatmath-fills.json]
 *        [--max-pages N] [--json]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  TAIL_CALIB,
  type TailPick,
  m1TailCalibration,
  m3TailBrier,
  m4EntryDeciles,
  tailCalibrationVerdict,
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

export const SCRIPT = 'm1-tail-calibration';

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
// EMOS_p map per lead: (eventId|bucketIdx) → our walk-forward forecast for that bucket
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface EmosCell {
  calibratedP: number;
  bucketWon: boolean;
  marketProbAtEntry: number | null;
  station: string;
  citySlug: string;
  targetDate: string;
}

const cellKey = (eventId: string, bucketIdx: number): string => `${eventId}|${bucketIdx}`;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
const ppf = (v: number): string => (Number.isFinite(v) ? `${(v * 100 >= 0 ? '+' : '')}${(v * 100).toFixed(2)}pp` : '—');
const f4 = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : '—');

export interface M1Args {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
  cheapMax: number;
  cache?: string;
  maxPages: number;
  json: boolean;
}

export async function runM1(args: M1Args, deps: { db: Db; log: (m: string) => void }): Promise<void> {
  const { db, log } = deps;
  const wallet = SHARP_WALLET_ADDRESS;

  // 1) badatmath's revealed picks (cheap Yes positions)
  const buys = await loadBuyFills(wallet, {
    cache: args.cache,
    from: args.from,
    maxPages: args.maxPages,
    log,
  });
  const positions = toPositions(buys);
  // the cheap longshot ENGINE is the Yes leg (§3): cheap-priced Yes buys on a specific bucket.
  const cheapYes = positions.filter(
    (p) =>
      p.outcome.toLowerCase() === 'yes' &&
      Number.isFinite(p.vwapPrice) &&
      p.vwapPrice > 0 &&
      p.vwapPrice < args.cheapMax,
  );
  log(
    `\nbadatmath: ${buys.length} BUY fills → ${positions.length} positions → ${cheapYes.length} cheap (<${args.cheapMax}) YES positions`,
  );

  // 2) the bridge: their 0x conditionId → our (eventId, bucketIdx)
  const bridge = await bridgeConditionIds(db, cheapYes.map((p) => p.conditionId));

  // 3) OUR walk-forward EMOS_p per (eventId, bucketIdx) for each lead — the maker-spray spine, once.
  const emos = await loadEmosInputs(db, { to: args.to, stations: args.stations, leads: args.leads });
  const events = await loadEvents(db, { from: args.from, to: args.to, icaos: emos.icaos });
  const seriesMap = await loadBucketSeries(db, {
    icaos: emos.icaos,
    from: args.from,
    to: args.to,
    lookbackDays: 1,
  });
  const cellByLead = new Map<number, Map<string, EmosCell>>();
  for (const lead of args.leads) {
    const { bids } = assembleBids(emos, events, seriesMap, {
      from: args.from,
      to: args.to,
      leads: [lead],
      entryLeadHours: lead * 24,
    });
    const cells = new Map<string, EmosCell>();
    for (const b of bids) {
      cells.set(cellKey(b.conditionId, b.bucketIdx), {
        calibratedP: b.calibratedP,
        bucketWon: b.bucketWon,
        marketProbAtEntry: b.marketProbAtEntry,
        station: b.station,
        citySlug: b.citySlug ?? '',
        targetDate: b.targetDate,
      });
    }
    cellByLead.set(lead, cells);
  }

  // 4) the correctness anchor — our forked EMOS == the LIVE db1 model (byte-equal RMSE)
  const forkEq = await forkEqualityRmse(db, {
    from: args.from,
    to: args.to,
    leads: args.leads,
    stations: args.stations,
  });

  // ── report ──────────────────────────────────────────────────────────────────────────────────────
  log(`\n══════════ M1 TAIL-CALIBRATION DIAGNOSIS — badatmath (${wallet}) ══════════`);
  log(`window ${args.from} → ${args.to} · leads ${args.leads.join(',')} · cheap<${args.cheapMax} · EMOS-tail<${TAIL_CALIB.emosTailMax}`);
  log(`scope: ${emos.icaos.length} stations · ${events.length} resolved bucket events`);
  log(
    `FORK-EQUALITY: db1 ${f4(forkEq.db1Rmse)}°C vs maker fork ${f4(forkEq.makerRmse)}°C → equal=${forkEq.equal}` +
      (forkEq.equal ? '' : '  ✗ FORK MISMATCH — EMOS_p is NOT the live model; result UNTRUSTWORTHY'),
  );

  const perLead: { lead: number; verdict: ReturnType<typeof tailCalibrationVerdict> }[] = [];
  for (const lead of args.leads) {
    const cells = cellByLead.get(lead)!;
    const picks: TailPick[] = [];
    let joined = 0;
    for (const p of cheapYes) {
      const br = bridge.get(p.conditionId);
      if (!br) continue;
      const cell = cells.get(cellKey(br.eventId, br.bucketIdx));
      if (!cell) continue; // no EMOS forecast for this (station,day,bucket) at this lead
      joined++;
      picks.push({
        entryPrice: p.vwapPrice,
        emosP: cell.calibratedP,
        marketP: cell.marketProbAtEntry,
        won: cell.bucketWon,
        station: cell.station,
        citySlug: cell.citySlug,
        targetDate: cell.targetDate,
      });
    }

    const m1 = m1TailCalibration(picks);
    const m3 = m3TailBrier(picks);
    const m4 = m4EntryDeciles(picks);
    // M2 (maker-spray, §12) is ALREADY FAIL (its lower-CI < 0). Pass it explicitly so the combined
    // kill is auditable rather than hidden.
    const verdict = tailCalibrationVerdict(m1, { m2Failed: true });
    perLead.push({ lead, verdict });

    log(`\n──────── LEAD ${lead} (entry ${lead * 24}h before resolution) ────────`);
    log(`  joined: ${joined}/${cheapYes.length} cheap-Yes positions had an EMOS forecast (coverage)`);
    log('  ── M1 (BINDING): our-tail calibration on THEIR cheap picks (EMOS_p<0.15) ──');
    log(
      `     cheap-tail picks n=${m1.n}  empirical freq ${pctf(m1.empiricalFreq)} [${pctf(m1.freqCiLo)}, ${pctf(m1.freqCiHi)}]  mean EMOS_p ${pctf(m1.meanEmosP)}`,
    );
    log(
      `     ★ pooled gap (won − EMOS_p) ${ppf(m1.gap)}  95% CI [${ppf(m1.gapCiLo)}, ${ppf(m1.gapCiHi)}]   ← PASS ≥ +3pp ∧ CI-lo > 0`,
    );
    log('  ── M3: tail-local Brier deficit (ours vs market on EMOS_p<0.15) ──');
    log(
      `     Brier ours ${f4(m3.brierOurs)}  market ${f4(m3.brierMarket)}  delta(ours−mkt) ${ppf(m3.delta)} [${ppf(m3.deltaCiLo)}, ${ppf(m3.deltaCiHi)}] (n=${m3.n})  ← negative ⇒ ours sharper`,
    );
    log('  ── M4: badatmath realized edge by entry-price decile (cheap Yes picks) ──');
    log('     decile   n   meanEntry   hitRate   edge(hit−entry)');
    for (const d of m4) {
      log(
        `     ${String(d.decile).padStart(4)}  ${String(d.n).padStart(4)}    ${pctf(d.meanEntry).padStart(7)}   ${pctf(d.hitRate).padStart(7)}   ${ppf(d.edge).padStart(9)}`,
      );
    }
    log(`  ── VERDICT (lead ${lead}): ${verdict.case} ──`);
    log(`     ${verdict.summary}`);
    log(`     → ${verdict.next}`);

    if (args.json) {
      log('\nJSON ' + JSON.stringify({ lead, joined, nCheapYes: cheapYes.length, m1, m3, m4, verdict }));
    }
  }

  // ── verdict stability across leads (the maker-spray discipline) ──────────────────────────────────
  const cases = perLead.map((x) => x.verdict.case);
  const stable = cases.every((c) => c === cases[0]);
  log(`\n──────── CROSS-LEAD STABILITY ────────`);
  log(`  verdicts: ${perLead.map((x) => `lead${x.lead}=${x.verdict.case}`).join('  ')}  → ${stable ? 'STABLE ✓' : 'UNSTABLE ✗ (lead-sensitive — do NOT trust a lone result)'}`);
  log('');
  log('  Reminder (the reframe): M1 is an ANALYTICS diagnosis. A PASS routes to a recalibration');
  log('  EXPERIMENT (Move 7) re-tested by the existing maker-spray sim — it does NOT reopen the live');
  log('  rail. A KILL/AMBIGUOUS confirms the analytics-product destination (Move 10). The number is');
  log('  itself the deliverable: the #1 weather sharp scored against our calibrated tail.');
}

/** A tiny self-test of the frozen wiring (the db1/maker-spray CLI idiom — no network, no DB). */
function sanity(): void {
  const mk = (n: number, wins: number, emosP: number): TailPick[] =>
    Array.from({ length: n }, (_, i) => ({
      entryPrice: 0.08,
      emosP,
      marketP: 0.07,
      won: i < wins,
      station: 'EHAM',
      citySlug: 'amsterdam',
      targetDate: '2026-06-22',
    }));
  // a clean +15pp gap at n=400 → Case A
  const a = tailCalibrationVerdict(m1TailCalibration(mk(400, 80, 0.05)), { m2Failed: true });
  if (a.case !== 'A_FIXABLE_FORECAST') throw new Error(`sanity: expected Case A, got ${a.case}`);
  // a +0.5pp gap at n=400 with M2 FAIL → combined KILL
  const k = tailCalibrationVerdict(m1TailCalibration(mk(400, 22, 0.05)), { m2Failed: true });
  if (k.case !== 'KILL_NOT_THE_GAP') throw new Error(`sanity: expected KILL, got ${k.case}`);
  if (m4EntryDeciles([]).length !== 0) throw new Error('sanity: empty deciles must be []');
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
      'cheap-max': { type: 'string' },
      cache: { type: 'string' },
      'max-pages': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: M1Args = {
      from: values.from ?? '2026-04-21',
      to: values.to ?? '2026-06-21',
      leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
      stations: splitList(values.stations),
      cheapMax: values['cheap-max'] ? Number(values['cheap-max']) : 0.25,
      cache: values.cache ?? 'scripts/research/out/badatmath-fills.json',
      maxPages: values['max-pages'] ? Number(values['max-pages']) : 1000,
      json: Boolean(values.json),
    };
    await runM1(args, { db, log: console.log });
  } finally {
    await db.end();
  }
}
