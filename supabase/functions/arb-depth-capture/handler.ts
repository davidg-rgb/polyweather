/**
 * arb-depth-capture — Move 1 forward depth-capture + Move 3 fee-structure reopening monitor
 * for the complete-set arbitrage (8th signal, COMPLETE-SET-ARB.md, migration 0060).
 *
 * Each tick (every 30 min):
 *   STEP 1 — enumerate all open temperature ladders from Gamma (tag 104596, active, not closed).
 *   STEP 2 — select the deep-capture set with ZERO CLOB calls: lead≤2d + ≥3 buckets, then pre-rank on
 *            the FREE Gamma top-of-book Σask and keep only the thinnest candidates (the wall-time bound;
 *            a richly-quoted ladder can't be an underround dislocation regardless of depth).
 *   STEP 3 — for each selected ladder, fetch the full CLOB book for every bucket's YES token.
 *   STEP 4 — compute Σ best-ask, underNet (per-leg taker fee), executableArb (profit-maximising
 *            set count by walking the full depth). Bulk-insert via record_complete_set_depth_captures.
 *   STEP 5 (Move 3, once per day at DAILY_ALERT_UTC_HOUR) — check the FULL universe (all open
 *            ladders, top-of-book only) for any fee-clearing dislocation and Slack-alert if found.
 *            This is the mechanical reopening trigger: if the weather taker fee ever drops or is
 *            restructured, this fires within 30 min and reopens the signal (COMPLETE-SET-ARB.md).
 *
 * Read-only against Polymarket. No orders, no packages/trading. Rail DORMANT. Best-effort:
 * a Polymarket outage yields an empty capture, never a failed job.
 */
import {
  normalizeBook,
  parseGammaEvent,
  type NormalizedBook,
  type ParsedEvent,
  type RawClobBook,
  type RawGammaEvent,
} from '../../../packages/core/src/index.ts';
import {
  FEE_RATE_WEATHER,
  completeSetEdge,
  underroundExecutable,
} from '../../../packages/core/src/sim/complete-set-arb.ts';
import {
  buildPerLegDepth,
  computeLeadDays,
  type PerLegDepth,
  selectDeepCandidates,
} from './pure.ts';
import type { FetchJsonLike } from '../_shared/polymarket-wallet.ts';
import { notifySlack } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596; // "Highest temperature" — the daily-Tmax ladders
const HEADERS: Record<string, string> = {
  'User-Agent': 'weather-edge/0.1 (arb-depth-capture)',
  Accept: 'application/json',
};

// The deep-capture selection constants (MAX_LEAD_DAYS, CAPTURE_SUM_ASK_MAX, MAX_DEEP_CAPTURES) + the
// pure selection logic live in ./pure.ts so they are unit-testable in Node (handler.test.ts).
/** UTC hour at which the once-daily full-universe reopening check fires (Move 3). */
const DAILY_ALERT_UTC_HOUR = 10;
/** Slack alert kind for the reopening monitor. */
const ALERT_KIND = 'ARB_REOPEN';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ArbDepthCaptureDeps {
  now: Date;
  fetchJson: FetchJsonLike;
}

interface CaptureRow {
  capturedAt: string;
  eventSlug: string;
  leadDays: number | null;
  ageHours: number | null;
  nBuckets: number;
  sumBestAsk: number | null;
  underNet: number | null;
  execSets: number;
  execCostUsd: number | null;
  execProfitUsd: number | null;
  perLegDepth: PerLegDepth[];
  rawUnderround: boolean;
  feeCleared: boolean;
}

/** Page all active open temperature events from Gamma, returning raw+parsed pairs. */
async function fetchOpenEvents(
  fetchJson: FetchJsonLike,
  log: JobCtx['log'],
): Promise<Array<{ raw: RawGammaEvent; parsed: ParsedEvent }>> {
  const results: Array<{ raw: RawGammaEvent; parsed: ParsedEvent }> = [];
  let parseFails = 0;
  for (let offset = 0; ; offset += 100) {
    const url = `${GAMMA}/events?tag_id=${TAG}&active=true&closed=false&limit=100&offset=${offset}`;
    let page: unknown;
    try {
      page = await fetchJson(
        url,
        { headers: HEADERS } as RequestInit,
        { timeoutMs: 10_000, retries: 1 },
      );
    } catch (e) {
      log('gamma page failed (non-fatal — partial universe)', { error: msg(e), offset });
      break;
    }
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page as RawGammaEvent[]) {
      try {
        results.push({ raw, parsed: parseGammaEvent(raw) });
      } catch {
        parseFails++;
      }
    }
    if (page.length < 100) break;
  }
  log('gamma enumeration done', { events: results.length, parseFails });
  return results;
}

/** Fetch the full CLOB book for a single YES token id. */
async function fetchBook(
  fetchJson: FetchJsonLike,
  tokenId: string,
): Promise<NormalizedBook> {
  const raw = (await fetchJson(
    `${CLOB}/book?token_id=${tokenId}`,
    { headers: HEADERS } as RequestInit,
    { timeoutMs: 8_000, retries: 1 },
  )) as RawClobBook;
  return normalizeBook(raw);
}

export async function arbDepthCapture(ctx: JobCtx, deps: ArbDepthCaptureDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const { now, fetchJson } = deps;
  const capturedAt = now.toISOString();

  // ── STEP 1: enumerate open ladders (raw+parsed) ──────────────────────────────────────────────
  const allEvents = await fetchOpenEvents(fetchJson, log);

  // ── STEP 2: select the deep-capture set (lead ≤ 2d + thinnest top-of-book), ZERO CLOB calls ──
  // selectDeepCandidates encapsulates the wall-time bound: ≥3 buckets, lead ≤ MAX_LEAD_DAYS, then the
  // FREE Gamma-top-of-book Σask pre-rank (Σask ≤ CAPTURE_SUM_ASK_MAX, capped). See pure.ts (+ tests).
  const ranked = selectDeepCandidates(allEvents, now);
  log('thin-candidate pre-rank (deep-capture set)', {
    total: allEvents.length,
    deepCandidates: ranked.length,
  });

  // ── STEPS 3 & 4: fetch CLOB books + compute depth (buckets concurrently per ladder) ──────────
  const captureRows: CaptureRow[] = [];
  for (const { ev: { parsed } } of ranked) {
    let books: NormalizedBook[];
    try {
      books = await Promise.all(parsed.buckets.map((bucket) => fetchBook(fetchJson, bucket.tokenYes)));
    } catch (e) {
      log('book fetch failed (non-fatal)', { error: msg(e), slug: parsed.slug });
      continue;
    }

    const asks = books.map((bk) => bk.asks[0]?.price ?? null);
    const bids = books.map((bk) => bk.bids[0]?.price ?? null);
    const edge = completeSetEdge(asks, bids, FEE_RATE_WEATHER);
    const exec = underroundExecutable(books.map((bk) => bk.asks), FEE_RATE_WEATHER);
    const lead = computeLeadDays(parsed.targetDate, now);

    captureRows.push({
      capturedAt,
      eventSlug: parsed.slug,
      leadDays: lead,
      // age_hours is reserved/null: Gamma gameStartTime is target-day midnight, not market-open, so a
      // real "age since open" can't be derived from it (see pure.ts selectDeepCandidates note).
      ageHours: null,
      nBuckets: parsed.buckets.length,
      sumBestAsk: edge.sumAsk,
      underNet: edge.underNet,
      execSets: exec.sets,
      execCostUsd: exec.costUsd > 0 ? exec.costUsd : null,
      execProfitUsd: exec.profitUsd > 0 ? exec.profitUsd : null,
      perLegDepth: buildPerLegDepth(books),
      rawUnderround: (edge.rawUnder ?? -1) > 0,
      feeCleared: edge.side === 'under',
    });
  }

  // ── Bulk insert via service-role RPC ─────────────────────────────────────────────────────────
  let inserted = 0;
  if (captureRows.length > 0) {
    try {
      const res = await db.rpc<{ record_complete_set_depth_captures: number }>(
        'record_complete_set_depth_captures',
        { p_rows: captureRows },
      );
      inserted = Number(res[0]?.record_complete_set_depth_captures ?? captureRows.length);
    } catch (e) {
      log('record_complete_set_depth_captures failed (non-fatal)', { error: msg(e) });
    }
  }

  // ── STEP 5 (Move 3): daily reopening check (top-of-book, full universe) ──────────────────────
  // Once per day at DAILY_ALERT_UTC_HOUR: re-run the complete-set edge on ALL open ladders
  // using the Gamma top-of-book prices (fast, no per-bucket CLOB call). If ANY ladder shows
  // a fee-clearing dislocation, that's the mechanical trigger — the weather fee restructured.
  let reopenAlerted = false;
  if (now.getUTCHours() === DAILY_ALERT_UTC_HOUR) {
    const reopenEdges = allEvents
      .filter(({ parsed }) => parsed.buckets.length >= 3)
      .map(({ parsed }) => ({
        slug: parsed.slug,
        edge: completeSetEdge(
          parsed.buckets.map((b) => b.bestAsk),
          parsed.buckets.map((b) => b.bestBid),
          FEE_RATE_WEATHER,
        ),
      }));

    const underClearing = reopenEdges.filter((x) => x.edge.side === 'under');
    const overClearing = reopenEdges.filter((x) => x.edge.side === 'over');

    if (underClearing.length > 0 || overClearing.length > 0) {
      const slugList = [...underClearing, ...overClearing]
        .slice(0, 5)
        .map((x) => x.slug.replace('highest-temperature-in-', ''))
        .join(', ');

      reopenAlerted = await notifySlack(db, {
        kind: ALERT_KIND,
        severity: 'ACTION',
        title: `Complete-set arb REOPENED — fee wall may have dropped (${underClearing.length} UNDER, ${overClearing.length} OVER clearing)`,
        body:
          `*Fee-clearing dislocations detected on the full open-ladder universe (top-of-book).*\n` +
          `UNDER: ${underClearing.length}/${reopenEdges.length} · OVER: ${overClearing.length}/${reopenEdges.length}\n` +
          `Top slugs: ${slugList}\n\n` +
          `This is the mechanical reopening trigger for the complete-set arbitrage (8th signal, COMPLETE-SET-ARB.md). ` +
          `Verify with full depth: \`pnpm tsx scripts/research/complete-set-arb-live.ts\`. ` +
          `Read depth verdict: call \`dash_complete_set_depth(7)\` to see the week's exec_sets.`,
        dedupeKey: `arb-reopen:${now.toISOString().slice(0, 10)}`,
      });
    } else {
      log('Move 3 reopening check: no fee-clearing dislocations (rail stays dormant)', {
        checked: reopenEdges.length,
        underClearing: 0,
        overClearing: 0,
      });
    }
  }

  const feeClearedCount = captureRows.filter((r) => r.feeCleared).length;
  const execSetsCount = captureRows.filter((r) => r.execSets > 0).length;

  const stats = {
    asOf: capturedAt,
    eventsTotal: allEvents.length,
    deepCandidates: ranked.length,
    captured: captureRows.length,
    inserted,
    feeCleared: feeClearedCount,
    execSets: execSetsCount,
    reopenAlerted,
  };
  log('arb-depth-capture complete', stats);
  return stats;
}
