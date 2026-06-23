/**
 * scripts/research/badatmath-replica-forward — the FORWARD paper-trade driver (the daily /loop engine)
 * for the badatmath replica (WALLET-RECON-HANDOFF.md §15; pure engine `core/sim/badatmath-replica.ts`,
 * backtest spine `badatmath-replica.ts`). Run once per day; it:
 *
 *   1. RECONCILE — for every OPEN position we placed on a prior day, check our DB for the event's
 *      resolution (`market_events.winning_bucket_idx`). When resolved, replay the bucket's full book to
 *      decide whether the rested maker bid filled (§12 ask-touch), lock the outcome, and CLOSE it.
 *   2. PLACE — find live OPEN markets in the best-performing cities whose 36h-before entry instant has
 *      arrived but which have not yet resolved, run the §15 playbook (cheap-Yes band + breadth + the
 *      daily bankroll cap), and OPEN the newly-selected buys (entry prices LOCKED at the 36h book — the
 *      identical instant the backtest prices at, so forward + backtest are one methodology). Each event
 *      is placed exactly once (deduped against state).
 *   3. PERSIST + RENDER — write the state file and re-render the live forward ledger (the day-by-day
 *      three-curve track record + the currently-open positions).
 *
 * State lives in `out/badatmath-replica-state.json` (open + closed positions, the whitelist, the strategy
 * — fully resumable). Read-only against the DB; no money; nothing ships to prod. The whitelist of
 * "his best-performing cities" is COMPUTED from the resolved backtest each run (positive maker-ideal ROI,
 * n ≥ min, top-K) so it sharpens as more data resolves — or pinned via `--cities`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type LockedBuy,
  type ReplicaStrategy,
  type ScoredBuy,
  dailyLedger,
  rankCitiesByRoi,
  scoreBuys,
  scoreLocked,
  selectBuys,
  summarize,
} from '../../packages/core/src/sim/badatmath-replica.ts';
import { snapshotAtOrAfter } from '../../packages/core/src/sim/copy-trade.ts';
import { simulateFill } from '../../packages/core/src/sim/maker-spray.ts';
import type { Db } from '../lib/backfill.ts';
import {
  type ReplicaArgs,
  type ReplicaDeps,
  type ReplicaPositionRow,
  loadCandidates,
  persistPositions,
  persistRun,
  renderCsv,
  renderLedger,
  resolveViaGamma,
} from './badatmath-replica.ts';
import { fetchResolutions } from './badatmath-purchase-map.ts';

const DEFAULT_RES_CACHE = 'scripts/research/out/badatmath-replica-resolutions.json';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// state
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One forward paper position — a LockedBuy plus the forward bookkeeping. */
export interface ForwardPosition extends LockedBuy {
  /** The actual entry snapshot's capturedAt (the placement book instant; for the fill-model window). */
  entryCapturedTs: number;
  /** ISO timestamp we placed it. */
  placedAtUtc: string;
  /** ISO timestamp we closed it (resolution observed); null while open. */
  closedAtUtc: string | null;
}

export interface ForwardState {
  version: 1;
  createdUtc: string;
  lastRunUtc: string;
  /** "his best-performing cities" — computed from the backtest (or pinned via --cities). */
  whitelist: string[];
  strat: ReplicaStrategy;
  open: ForwardPosition[];
  closed: ForwardPosition[];
}

const STATE_PATH = (outDir: string): string => `${outDir}/badatmath-replica-state.json`;

export function loadState(outDir: string): ForwardState | null {
  const p = STATE_PATH(outDir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as ForwardState;
}

export function saveState(outDir: string, state: ForwardState): void {
  const p = STATE_PATH(outDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

const isoNow = (nowSec: number): string => new Date(nowSec * 1000).toISOString();
const isoDayUtc = (unixSec: number): string => new Date(unixSec * 1000).toISOString().slice(0, 10);
const posKey = (p: { eventId: string; bucketIdx: number }): string => `${p.eventId}|${p.bucketIdx}`;

/** Map a forward position (open or closed) → a persisted-position row for /replica (migration 0053). */
function forwardToRow(p: ForwardPosition): ReplicaPositionRow {
  return {
    conditionId: p.conditionId,
    eventId: p.eventId,
    citySlug: p.citySlug,
    region: p.region,
    targetDate: p.targetDate,
    bucketIdx: p.bucketIdx,
    bucketLabel: p.bucketLabel,
    resolutionTs: p.resolutionTs,
    entryTs: p.entryTs,
    entryDayUtc: p.entryDayUtc,
    makerPrice: p.makerPrice,
    takerPrice: p.takerPrice,
    stakeUsd: p.stakeUsd,
    feeRate: p.feeRate,
    bucketWon: p.bucketWon,
    makerRealisticFilled: p.makerRealisticFilled,
    status: p.bucketWon == null ? 'open' : 'resolved',
    placedAtUtc: p.placedAtUtc,
    closedAtUtc: p.closedAtUtc,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// whitelist — "his best-performing cities", computed from the resolved backtest
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Compute the best-performing-city whitelist from the resolved backtest history: cities with a POSITIVE
 * maker-ideal ROI over n ≥ minResolved positions, ranked, capped at topK. This is the data's own answer
 * to "his best cities" and sharpens as more events resolve. Read-only.
 */
export async function computeWhitelist(
  db: Db,
  args: { from: string; to: string; strat: ReplicaStrategy; minResolved: number; topK: number; gamma?: boolean; resCache?: string },
  log: (m: string) => void = () => {},
): Promise<CityWhitelist> {
  const candidates = await loadCandidates(db, { from: args.from, to: args.to, resolvedOnly: !args.gamma });
  const buys = selectBuys(candidates, args.strat);
  if (args.gamma) {
    await resolveViaGamma(
      buys.filter((b) => b.allocated).map((b) => b.candidate),
      { resCache: args.resCache ?? 'scripts/research/out/badatmath-replica-resolutions.json', log },
    );
  }
  const scored = scoreBuys(buys, args.strat);
  const ranked = rankCitiesByRoi(scored, { leg: 'makerIdeal', minResolved: args.minResolved });
  const positive = ranked.filter((c) => Number.isFinite(c.roiGross) && c.roiGross > 0);
  return {
    cities: positive.slice(0, args.topK).map((c) => c.city),
    ranked: ranked.slice(0, args.topK),
  };
}

export interface CityWhitelist {
  cities: string[];
  ranked: { city: string; region: string; nResolved: number; roiGross: number; hitRate: number }[];
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// reconcile — close resolved open positions
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Re-load a bucket's ask series (by conditionId) for the maker-realistic fill decision. Read-only. */
async function reloadAskSeries(db: Db, conditionId: string): Promise<{ capturedAt: number; ask: number | null; bid: number | null; mid: number | null }[]> {
  if (!conditionId) return [];
  const rows = await db.query<{ captured_at: string | Date; best_bid: string | null; best_ask: string | null; mid: string | null }>(
    `select ms.captured_at, ms.best_bid, ms.best_ask, ms.mid
     from market_snapshots ms
     join market_buckets mb on mb.id = ms.bucket_id
     where mb.condition_id = $1
     order by ms.captured_at asc`,
    [conditionId],
  );
  return rows.map((r) => ({
    capturedAt: Math.floor(new Date(r.captured_at).getTime() / 1000),
    bid: r.best_bid == null ? null : Number(r.best_bid),
    ask: r.best_ask == null ? null : Number(r.best_ask),
    mid: r.mid == null ? null : Number(r.mid),
  }));
}

/**
 * Look up resolutions for a set of events: eventId → winning_bucket_idx (only the resolved ones). The
 * §15 trusted basis (the resolution pipeline). Chunked, read-only.
 */
async function loadResolutions(db: Db, eventIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(eventIds)];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.query<{ id: string; winning_bucket_idx: number | null }>(
      `select id, winning_bucket_idx from market_events where id = any($1) and winning_bucket_idx is not null`,
      [chunk],
    );
    for (const r of rows) if (r.winning_bucket_idx != null) out.set(r.id, r.winning_bucket_idx);
  }
  return out;
}

/**
 * Reconcile open positions against resolution. DB `winning_bucket_idx` is primary; when `gamma` is set,
 * positions our (lagging, ~45%) DB hasn't resolved are checked against Polymarket Gamma (~97%, timely) by
 * conditionId — so forward positions actually CLOSE promptly instead of waiting on the DB pipeline. For
 * each newly-resolved one: set bucketWon, replay the full book to decide the maker-realistic fill (§12
 * ask-touch), and move it to closed. Gamma degrades cleanly (a fetch failure just leaves it open for next
 * run). Mutates `state` in place; returns how many closed.
 */
export async function reconcile(
  db: Db,
  state: ForwardState,
  nowSec: number,
  opts: { gamma?: boolean; resCache?: string; log?: (m: string) => void } = {},
): Promise<number> {
  if (state.open.length === 0) return 0;
  const dbWinners = await loadResolutions(db, state.open.map((p) => p.eventId));

  // Gamma fallback for positions the DB hasn't resolved (timelier + wider coverage).
  let gammaWin = new Map<string, 'Yes' | 'No'>();
  if (opts.gamma) {
    const need = state.open
      .filter((p) => !dbWinners.has(p.eventId) && p.conditionId)
      .map((p) => p.conditionId);
    if (need.length > 0) {
      // quiet log: the shared resolver reports whole-cache counts (misleading next to a 16-id call); the
      // forward run prints its own accurate "Reconciled N" summary instead.
      gammaWin = await fetchResolutions([...new Set(need)], {
        cache: opts.resCache ?? DEFAULT_RES_CACHE,
        log: () => {},
      });
    }
  }

  const stillOpen: ForwardPosition[] = [];
  let closedCount = 0;
  for (const p of state.open) {
    let won: boolean | null = null;
    const dbw = dbWinners.get(p.eventId);
    if (dbw !== undefined) won = p.bucketIdx === dbw;
    else if (p.conditionId) {
      const g = gammaWin.get(p.conditionId);
      if (g !== undefined) won = g === 'Yes';
    }
    if (won === null) {
      stillOpen.push(p);
      continue;
    }
    // resolved → lock the outcome + the maker-realistic fill from the now-complete book
    const series = await reloadAskSeries(db, p.conditionId);
    const postEntry = series.filter((s) => s.capturedAt >= p.entryCapturedTs);
    const fill = simulateFill(p.makerPrice, postEntry, 'ask_touch');
    p.bucketWon = won;
    p.makerRealisticFilled = fill.filled;
    p.closedAtUtc = isoNow(nowSec);
    state.closed.push(p);
    closedCount++;
  }
  state.open = stillOpen;
  return closedCount;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// place — open new buys on live markets at the 36h entry instant
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Place today's buys: load OPEN markets (unresolved) in the whitelist cities whose 36h-before entry
 * instant has arrived (entryTs ≤ now < resolutionTs), run the §15 playbook, dedupe against everything
 * already placed, and OPEN the newly-allocated buys with their entry prices LOCKED at the 36h book.
 * Mutates `state.open`; returns the number opened.
 */
export async function placeBuys(db: Db, state: ForwardState, nowSec: number): Promise<number> {
  const strat = state.strat;
  // load a forward window: events resolving from ~now out to a few days, in the whitelist cities.
  const fromISO = isoDayUtc(nowSec - 2 * 86400);
  const toISO = isoDayUtc(nowSec + 4 * 86400);
  const candidates = await loadCandidates(db, {
    from: fromISO,
    to: toISO,
    cities: state.whitelist.length > 0 ? state.whitelist : undefined,
    resolvedOnly: false,
  });
  // only OPEN events whose entry instant has arrived but not yet resolved
  const entryLeadSec = strat.entryLeadHours * 3600;
  const live = candidates.filter(
    (c) => c.bucketWon === null && c.resolutionTs > nowSec && c.resolutionTs - entryLeadSec <= nowSec,
  );
  const buys = selectBuys(live, strat);

  const placed = new Set<string>([...state.open, ...state.closed].map(posKey));
  let opened = 0;
  for (const b of buys) {
    if (!b.allocated) continue;
    const c = b.candidate;
    if (placed.has(posKey({ eventId: c.eventId, bucketIdx: c.bucketIdx }))) continue;
    placed.add(posKey({ eventId: c.eventId, bucketIdx: c.bucketIdx }));
    state.open.push({
      conditionId: c.conditionId,
      eventId: c.eventId,
      citySlug: c.citySlug,
      region: c.region,
      targetDate: c.targetDate,
      bucketIdx: c.bucketIdx,
      bucketLabel: c.bucketLabel,
      resolutionTs: c.resolutionTs,
      entryTs: b.entryTs,
      entryDayUtc: b.entryDayUtc,
      entryCapturedTs: b.entrySnapshot.capturedAt,
      makerPrice: b.makerPrice,
      takerPrice: b.takerPrice,
      stakeUsd: b.stakeUsd,
      feeRate: Number.isFinite(c.feeRate) && c.feeRate > 0 ? c.feeRate : strat.feeRate,
      bucketWon: null,
      makerRealisticFilled: false,
      placedAtUtc: isoNow(nowSec),
      closedAtUtc: null,
    });
    opened++;
  }
  return opened;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// render the open-positions section
// ──────────────────────────────────────────────────────────────────────────────────────────────────

function renderOpenSection(open: ForwardPosition[]): string {
  const L: string[] = [];
  L.push('## Currently open (placed, awaiting resolution)');
  L.push('');
  if (open.length === 0) {
    L.push('_No open positions._');
    return L.join('\n');
  }
  const stake = open.reduce((a, p) => a + p.stakeUsd, 0);
  L.push(`${open.length} open · $${stake.toFixed(0)} at risk (maker-ideal basis).`);
  L.push('');
  L.push('| placed | city | target | bucket | maker px | taker px | stake |');
  L.push('|---|---|---|---|--:|--:|--:|');
  for (const p of [...open].sort((a, b) => a.resolutionTs - b.resolutionTs).slice(0, 40)) {
    L.push(
      `| ${p.placedAtUtc.slice(0, 10)} | ${p.citySlug} | ${p.targetDate} | ${p.bucketLabel} | ${p.makerPrice.toFixed(
        3,
      )} | ${p.takerPrice.toFixed(3)} | $${p.stakeUsd.toFixed(0)} |`,
    );
  }
  if (open.length > 40) L.push(`\n_…and ${open.length - 40} more._`);
  return L.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// run
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The daily forward run: reconcile → place → persist → render. Initializes state (computing the
 * whitelist from the resolved backtest) on first run. Read-only against the DB.
 */
export async function runForward(args: ReplicaArgs, deps: ReplicaDeps): Promise<ForwardState> {
  const { db, log, nowSec } = deps;
  const outDir = args.outDir;

  let state = loadState(outDir);
  if (state === null) {
    log('No forward state — initializing (computing the best-cities whitelist from the resolved backtest) …');
    const wl =
      args.cities && args.cities.length > 0
        ? { cities: args.cities, ranked: [] as CityWhitelist['ranked'] }
        : await computeWhitelist(
            db,
            { from: args.from, to: isoDayUtc(nowSec), strat: args.strat, minResolved: args.minCityN, topK: args.top, gamma: args.gamma, resCache: args.resCache },
            log,
          );
    state = {
      version: 1,
      createdUtc: isoNow(nowSec),
      lastRunUtc: isoNow(nowSec),
      whitelist: wl.cities,
      strat: args.strat,
      open: [],
      closed: [],
    };
    log(`  whitelist (${state.whitelist.length}): ${state.whitelist.join(', ') || '(all — none cleared the bar yet)'}`);
  } else {
    // keep the strategy in step with the CLI (lets the operator tune mid-trial); whitelist is sticky.
    state.strat = args.strat;
    if (args.cities && args.cities.length > 0) state.whitelist = args.cities;
  }

  const closed = await reconcile(db, state, nowSec, { gamma: args.gamma, resCache: args.resCache, log });
  const opened = await placeBuys(db, state, nowSec);
  state.lastRunUtc = isoNow(nowSec);
  saveState(outDir, state);

  log(`Reconciled ${closed} newly-resolved · opened ${opened} new · ${state.open.length} open · ${state.closed.length} closed total.`);

  // score the closed (resolved) forward positions through the SAME engine the backtest uses
  const scored: ScoredBuy[] = state.closed.map((p) => scoreLocked(p, state!.strat));
  const summary = summarize(scored, { nCandidates: state.closed.length + state.open.length, nBandEligible: state.closed.length + state.open.length });
  const daily = dailyLedger(scored, { net: args.net });
  const cities = rankCitiesByRoi(scored, { leg: 'makerIdeal', minResolved: Math.min(args.minCityN, 3) });

  const subtitle =
    `FORWARD live paper-trade · ${state.closed.length} resolved / ${state.open.length} open · ` +
    `whitelist ${state.whitelist.length} cities · seeded ${args.from} · run ${isoNow(nowSec).slice(0, 16)}Z`;
  const totalPlaced = state.open.length + state.closed.length;
  const funnel =
    `**Track record:** ${totalPlaced} positions placed → **${state.closed.length} resolved** ` +
    `(scored below) · **${state.open.length} still open** (awaiting resolution). ` +
    `Cumulative $${state.closed.reduce((a, p) => a + p.stakeUsd, 0).toFixed(0)} resolved stake.`;
  const ledger = renderLedger({
    title: 'badatmath replica — LIVE forward ledger',
    subtitle,
    strat: state.strat,
    summary,
    daily,
    cities,
    topCities: args.top,
    net: args.net,
    funnel,
    extra: renderOpenSection(state.open),
  });
  const mdPath = `${outDir}/badatmath-replica-forward-ledger.md`;
  const csvPath = `${outDir}/badatmath-replica-forward-positions.csv`;
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, ledger);
  writeFileSync(csvPath, renderCsv(scored));
  log('');
  log(`Forward ledger → ${mdPath}`);
  log(`Closed-position CSV → ${csvPath} (${scored.length} rows)`);

  // Project the live state (open + closed) into Postgres for /replica. Wrapped so a DB hiccup never fails the
  // reconcile/place that already succeeded above. replace=true → the DB is an exact mirror of the state file.
  if (args.persist) {
    try {
      const rows = [...state.open, ...state.closed].map(forwardToRow);
      const n = await persistPositions(db, 'forward', rows);
      await persistRun(db, {
        mode: 'forward',
        ranAt: isoNow(nowSec),
        seedFrom: args.from,
        seedTo: '',
        whitelist: state.whitelist,
        strat: state.strat,
        nCandidates: summary.nCandidates,
        nBand: summary.nBandEligible,
        nSelected: summary.nSelected,
        nAllocated: summary.nAllocated,
        nOpen: state.open.length,
        nClosed: state.closed.length,
        nOpened: opened,
        nReconciled: closed,
      });
      log(`Persisted ${n} forward positions → replica_positions (source=forward) for /replica.`);
    } catch (e) {
      log(`WARN: forward persistence skipped (${String(e)}). The state file + ledger were still written.`);
    }
  }

  if (args.json) log('\nJSON ' + JSON.stringify({ closed, opened, open: state.open.length, summary, daily }));
  return state;
}
