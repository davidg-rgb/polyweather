/**
 * poll-markets — price ingestion & the edge engine (ARCHITECTURE.md §6.17).
 *
 * One pass: (0) job_locks lease (C8) → (1) Gamma pages → snapshots
 * (delta-dedupe + tiered heartbeat) + liveness → (2) market consensus →
 * (3) candidates: champion distribution (≤14h fresh) → quick screen →
 * ≤15 CLOB books → (4) edges + liquidity vetoes → (5) joint Kelly over
 * PASSING buckets with fee-adjusted effective costs (W4/W20, ADR-08) →
 * caps → (6) recommendation upsert + Slack ACTION (refresh re-notifies only
 * on ≥20% stake change) → (7) ADR-09 CAS expiry → (8) hourly edge_evaluations
 * (F-038) → (9) ADR-17 position watch.
 */
import {
  GammaShapeError,
  applyKellyFraction,
  applyLiquidityFilters,
  applyRiskCaps,
  computeBucketEdges,
  exposureSummary,
  impliedDistribution,
  isZombieEvent,
  jointKellyStakes,
  leadDays,
  localDayWindow,
  minEdgeRequired,
  normalizeBook,
  parseGammaEvent,
  takerFeePerShare,
  validateRawGammaEvent,
  type AppConfig,
  type BucketDef,
  type EdgeRow,
  type NormalizedBook,
  type ParsedEvent,
  type RawClobBook,
  type RawGammaEvent,
} from '../../../packages/core/src/index.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface PollDeps {
  /** One Gamma tag page at the given offset. */
  fetchPage: (offset: number) => Promise<unknown>;
  /** CLOB order book for a YES token. */
  fetchBook: (tokenId: string) => Promise<unknown>;
  notify: (alert: Alert) => Promise<boolean>;
  /**
   * Live-mode only: pull a resting unfilled order on an expiring rec via
   * execute-bet {action:'cancel'} (§6.20a — the chokepoint stays HTTP).
   * Absent in paper mode (no resting orders exist).
   */
  cancelLiveOrder?: (betId: string) => Promise<void>;
  now: Date;
  /** Lease holder identity (the runJob run id). */
  runId: string;
}

interface BucketCtx {
  bucketId: string;
  idx: number;
  polyMarketId: string | null;
  label: string;
  low: number | null;
  high: number | null;
  feeRate: number | null;
  minOrderSize: number | null;
  tokenYes: string;
  lastMid: number | null;
  lastCapturedAt: string | null;
  openRec: { betId: string; execAsk: number; recStakeUsd: number } | null;
}

interface EventCtx {
  eventId: string;
  slug: string;
  targetDate: string;
  unit: 'C' | 'F';
  ladderOk: boolean;
  closed: boolean;
  graded: boolean;
  citySlug: string;
  tz: string;
  region: string;
  bettingEnabled: boolean;
  verified: boolean;
  buckets: BucketCtx[];
  champion: {
    id: string;
    probs: number[];
    mu: number | null;
    sigma: number | null;
    statsVersion: number | null;
    madeAt: string;
    nowcast: boolean;
  } | null;
}

const PAGE_SIZE = 100;
const MAX_BOOKS_PER_CYCLE = 15;
const CHAMPION_FRESH_MS = 14 * 3_600_000;
const DELTA_MID = 0.005;
const HEARTBEAT_CANDIDATE_MS = 30 * 60_000;
const HEARTBEAT_OTHER_MS = 2 * 3_600_000;

const sha256Hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const dateISO = (v: unknown): string =>
  typeof v === 'string' ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10);

/** Cheap structural guard run on EVERY event (full zod only on the W15 sample). */
const structurallySane = (ev: unknown): ev is RawGammaEvent =>
  typeof ev === 'object' && ev !== null &&
  typeof (ev as RawGammaEvent).id === 'string' &&
  typeof (ev as RawGammaEvent).slug === 'string' &&
  Array.isArray((ev as RawGammaEvent).markets);

export async function pollMarkets(ctx: JobCtx, deps: PollDeps): Promise<JobStats> {
  const { db, config: cfg, log } = ctx;
  const stats = {
    events: 0, pages: 0, snapshotsWritten: 0, booksFetched: 0,
    recommendationsNew: 0, refreshed: 0, expired: 0, evaluationsPersisted: 0, cpuMs: 0,
  };

  // --- (0) LEASE (C8) ---------------------------------------------------------
  const [lease] = await db.rpc<{ claim_poll_lease: boolean }>('claim_poll_lease', {
    p_holder: deps.runId,
    p_wall_sec: cfg.jobWallLimitSec,
  });
  if (!lease?.claim_poll_lease) {
    log('lease held by another run — exiting overlapped');
    return { overlapped: true };
  }

  try {
    return await pollPass(ctx, deps, stats);
  } finally {
    await db.rpc('release_poll_lease', { p_holder: deps.runId });
  }
}

async function pollPass(
  ctx: JobCtx,
  deps: PollDeps,
  stats: Record<string, number>,
): Promise<JobStats> {
  const { db, config: cfg, log } = ctx;
  const cpuStart = Date.now();

  // --- (1) PRICES -------------------------------------------------------------
  const rawEvents: RawGammaEvent[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await deps.fetchPage(offset);
    if (!Array.isArray(page)) throw new GammaShapeError(`events page at offset ${offset} is not an array`);
    stats['pages']!++;
    rawEvents.push(...(page as RawGammaEvent[]).filter(structurallySane));
    if (page.length < PAGE_SIZE) break;
  }
  if (stats['pages']! > 4) {
    await deps.notify({
      kind: 'UNIVERSE_GROWTH', severity: 'WARN',
      title: `Gamma universe grew past 4 pages (${stats['pages']})`,
      body: 'Pagination budget exceeded — review tag 104596 scope (W13)',
      dedupeKey: 'universe-growth',
    });
  }

  // W15: deep-validate exactly ONE sampled event per run (2s CPU budget).
  const todayUtcISO = deps.now.toISOString().slice(0, 10);
  const live = rawEvents.filter((ev) => !isZombieEvent(ev, todayUtcISO));
  if (live.length > 0) {
    validateRawGammaEvent(live[deps.now.getUTCMinutes() % live.length]!);
  }

  const ctxRows = await db.rpc<{ poly_event_id: string; ctx: EventCtx }>('poll_known_events', {
    p_poly_ids: live.map((e) => e.id),
    p_champion: cfg.championSource,
  });
  const known = new Map(ctxRows.map((r) => [r.poly_event_id, r.ctx]));

  const haltKeys = new Set(
    (await db.getConfigRows()).filter((r) => r.key.startsWith('halt:')).map((r) => r.key),
  );
  const halted = (ev: EventCtx, lead: number): boolean =>
    haltKeys.has('halt:global') ||
    haltKeys.has(`halt:city:${ev.citySlug}`) ||
    haltKeys.has(`halt:city_lead:${ev.citySlug}:${lead}`);

  const snapshotRows: Record<string, unknown>[] = [];
  const livenessRows: Record<string, unknown>[] = [];
  const parsedByPolyId = new Map<string, ParsedEvent>();

  for (const raw of live) {
    const evCtx = known.get(raw.id);
    // Skip closed/graded events (discovery owns ingestion of new events) AND
    // flagged/bucketless events: a known city whose ladder fails validateLadder
    // is stored ladder_ok=false with ZERO buckets (the Lucknow events). Such an
    // event has no tradeable markets — nothing to snapshot, no consensus, no
    // candidacy. Without this skip a bucketless event would fall through to the
    // `for (const bucket of evCtx.buckets)` loops below (the §0024 crash) and,
    // post-fix, would still write a degenerate empty-probs market_consensus row.
    if (!evCtx || evCtx.closed || evCtx.graded || !evCtx.buckets?.length) continue;
    stats['events']!++;

    let parsed: ParsedEvent;
    try {
      parsed = parseGammaEvent(raw, evCtx.tz);
    } catch (e) {
      log('event parse failed — skipped this tick', { slug: raw.slug, error: String(e) });
      continue;
    }
    parsedByPolyId.set(raw.id, parsed);
    livenessRows.push({
      poly_event_id: raw.id,
      accepting: parsed.acceptingOrders,
      volume24h: parsed.eventVolume24h,
      liquidity: parsed.liquidity,
    });

    const lead = leadDays(deps.now, dateISO(evCtx.targetDate), evCtx.tz);
    const isCandidateTier = lead <= 2 && parsed.acceptingOrders;
    const heartbeatMs = isCandidateTier ? HEARTBEAT_CANDIDATE_MS : HEARTBEAT_OTHER_MS;

    const byMarketId = new Map(parsed.buckets.map((b) => [b.marketId, b]));
    for (const bucket of evCtx.buckets) {
      const pb = bucket.polyMarketId ? byMarketId.get(bucket.polyMarketId) : parsed.buckets[bucket.idx];
      if (!pb) continue;
      const mid = pb.bestBid !== null && pb.bestAsk !== null ? (pb.bestBid + pb.bestAsk) / 2 : null;
      const lastAge = bucket.lastCapturedAt
        ? deps.now.getTime() - new Date(bucket.lastCapturedAt).getTime()
        : Infinity;
      const moved =
        mid !== null && (bucket.lastMid === null || Math.abs(mid - Number(bucket.lastMid)) >= DELTA_MID);
      if (moved || lastAge >= heartbeatMs) {
        snapshotRows.push({
          bucket_id: bucket.bucketId, best_bid: pb.bestBid, best_ask: pb.bestAsk,
          mid, spread: pb.spread, last_trade: null,
        });
      }
    }
  }

  if (snapshotRows.length > 0) {
    const [w] = await db.rpc<{ upsert_market_snapshots: number }>('upsert_market_snapshots', {
      p_rows: snapshotRows,
      p_captured_at: deps.now.toISOString(),
    });
    stats['snapshotsWritten'] = Number(w?.upsert_market_snapshots ?? 0);
  }
  if (livenessRows.length > 0) {
    await db.rpc('refresh_event_liveness', { p_rows: livenessRows });
  }

  // --- (2) CONSENSUS ------------------------------------------------------------
  for (const [polyId, parsed] of parsedByPolyId) {
    const evCtx = known.get(polyId)!;
    const lead = leadDays(deps.now, dateISO(evCtx.targetDate), evCtx.tz);
    if (lead < 0 || lead > cfg.maxLeadDays) continue;
    const mids = evCtx.buckets.map((bucket) => {
      const pb = bucket.polyMarketId
        ? parsed.buckets.find((p) => p.marketId === bucket.polyMarketId)
        : parsed.buckets[bucket.idx];
      return pb && pb.bestBid !== null && pb.bestAsk !== null ? (pb.bestBid + pb.bestAsk) / 2 : null;
    });
    const dist = impliedDistribution(mids);
    if (!dist) continue;
    await db.rpc('upsert_distribution', {
      p_event_id: evCtx.eventId,
      p_source: 'market_consensus',
      p_lead: lead,
      p_nowcast: false,
      p_inputs_hash: await sha256Hex(`consensus|${evCtx.eventId}|${mids.map((m) => m ?? 'x').join(',')}`),
      p_probs: dist,
      p_mu: null,
      p_sigma: null,
      p_stats_version: null,
    });
  }

  // --- (3)–(6) CANDIDATES → EDGES → SIZING → RECOMMENDATIONS ---------------------
  const exposureRows = await db.rpc<{
    event_id: string; city_slug: string; region: string; target_date: string | Date; stake_usd: string;
  }>('open_bets_exposure', {});
  const [bk] = await db.rpc<{ current_bankroll: string }>('current_bankroll', { p_mode: cfg.tradingMode });
  const bankrollUsd = Number(bk?.current_bankroll ?? 0);
  const exposure = exposureSummary(
    exposureRows.map((r) => ({
      eventId: r.event_id, citySlug: r.city_slug, cluster: r.region,
      stakeUsd: Number(r.stake_usd), targetDate: dateISO(r.target_date),
    })),
    bankrollUsd,
  );

  let staleChampions = 0;
  const edgeRowsByEvent = new Map<string, { evCtx: EventCtx; rows: EdgeRow[] }>();

  for (const [polyId, parsed] of parsedByPolyId) {
    const evCtx = known.get(polyId)!;
    const lead = leadDays(deps.now, dateISO(evCtx.targetDate), evCtx.tz);
    const bettable =
      evCtx.verified && evCtx.bettingEnabled && evCtx.ladderOk && parsed.acceptingOrders &&
      lead >= 0 && lead <= cfg.maxLeadDays && !halted(evCtx, lead);
    if (!bettable) continue;
    if (!evCtx.champion) continue;
    if (deps.now.getTime() - new Date(evCtx.champion.madeAt).getTime() > CHAMPION_FRESH_MS) {
      staleChampions++;
      continue;
    }

    const q = evCtx.champion.probs.map(Number);
    const ladder: BucketDef[] = evCtx.buckets.map((b) => ({ low: b.low, high: b.high, unit: evCtx.unit }));
    const marketRows = evCtx.buckets.map((bucket) => {
      const pb = bucket.polyMarketId
        ? parsed.buckets.find((p) => p.marketId === bucket.polyMarketId)
        : parsed.buckets[bucket.idx];
      return {
        feeRate: Number(bucket.feeRate ?? pb?.feeRate ?? 0.05),
        spread: pb?.spread ?? null,
        bestAsk: pb?.bestAsk ?? null,
        bucket,
      };
    });

    // Quick screen: q − bestAsk ≥ minEdge/2 ⇒ worth a book fetch (≤15/cycle
    // economy). Buckets carrying an OPEN recommendation are ALWAYS evaluated
    // (and prioritized in the budget) — a collapsed q must still produce the
    // edge row that step 7's edge_collapsed expiry reads.
    const books: (NormalizedBook | null)[] = evCtx.buckets.map(() => null);
    const failedBooks = new Set<number>();
    const wantBook: number[] = [];
    for (let i = 0; i < evCtx.buckets.length; i++) {
      const m = marketRows[i]!;
      if (evCtx.buckets[i]!.openRec) {
        wantBook.push(i);
        continue;
      }
      if (m.bestAsk === null) continue;
      const minEdge = minEdgeRequired(m.bestAsk, m.spread ?? 0, {
        uncertaintyMargin: cfg.uncertaintyMargin, spreadBufferMin: cfg.spreadBufferMin,
        feeRate: m.feeRate, probeStakeUsd: cfg.probeStakeUsd, maxSpread: cfg.maxSpread,
        minEventVolumeUsd: cfg.minEventVolumeUsd, minHoursBeforeClose: cfg.minHoursBeforeClose,
      });
      if ((q[i] ?? 0) - m.bestAsk >= minEdge / 2) wantBook.push(i);
    }
    for (const i of wantBook) {
      if (stats['booksFetched']! >= MAX_BOOKS_PER_CYCLE) break;
      try {
        stats['booksFetched']!++;
        const book = normalizeBook((await deps.fetchBook(evCtx.buckets[i]!.tokenYes)) as RawClobBook);
        books[i] = book;
        await db.rpc('attach_book_to_snapshot', {
          p_bucket_id: evCtx.buckets[i]!.bucketId,
          p_book: { bids: book.bids.slice(0, 3), asks: book.asks.slice(0, 3) },
        });
      } catch (e) {
        failedBooks.add(i);
        log('book fetch failed — bucket excluded', { slug: evCtx.slug, idx: i, error: String(e) });
      }
    }

    // (4) EDGES + liquidity vetoes
    const { endUtc } = localDayWindow(evCtx.tz, dateISO(evCtx.targetDate));
    const liquidityCtx = {
      volume24h: Number(parsed.eventVolume24h ?? 0),
      secondsToLocalMidnight: (endUtc.getTime() - deps.now.getTime()) / 1000,
      stationVerified: evCtx.verified,
      halted: halted(evCtx, lead),
    };
    const edgeCfg = {
      uncertaintyMargin: cfg.uncertaintyMargin, spreadBufferMin: cfg.spreadBufferMin,
      feeRate: 0.05, probeStakeUsd: cfg.probeStakeUsd, maxSpread: cfg.maxSpread,
      minEventVolumeUsd: cfg.minEventVolumeUsd, minHoursBeforeClose: cfg.minHoursBeforeClose,
    };
    const rows = computeBucketEdges(q, ladder, books, marketRows, edgeCfg)
      .map((row) => applyLiquidityFilters(row, liquidityCtx, edgeCfg))
      .map((row) => {
        // audit honesty: distinguish "never fetched" from "fetch failed" (book_unavailable per §6.17)
        if (books[row.bucketIdx] !== null) return row;
        const reason = failedBooks.has(row.bucketIdx) ? 'book_unavailable' : 'screened_out';
        return { ...row, pass: false, reasons: [reason] };
      });
    edgeRowsByEvent.set(evCtx.eventId, { evCtx, rows });

    // (5) SIZING over the PASSING buckets only (ADR-08), fee-aware (W4),
    // pre-filtered to q > p′ so a p′ ≥ 1 bucket never kills the event (W20).
    const passing = rows.filter(
      (r) => r.pass && r.execAsk !== null &&
        r.q > r.execAsk + takerFeePerShare(r.execAsk, marketRows[r.bucketIdx]!.feeRate) + cfg.paperSlippage,
    );
    if (passing.length === 0) continue;

    const effCost = passing.map(
      (r) => r.execAsk! + takerFeePerShare(r.execAsk!, marketRows[r.bucketIdx]!.feeRate) + cfg.paperSlippage,
    );
    const { fractions, c } = jointKellyStakes(passing.map((r) => r.q), effCost);
    const fractional = applyKellyFraction(fractions, cfg.kellyFraction);
    const plans = applyRiskCaps(
      passing.map((r, j) => ({
        bucketIdx: r.bucketIdx,
        frac: fractional[j]!,
        price: r.execAsk!,
        orderMinSize: Number(evCtx.buckets[r.bucketIdx]!.minOrderSize ?? 5),
      })).filter((p) => p.frac > 0),
      {
        bankrollUsd,
        eventOpenUsd: exposure.byEvent.get(evCtx.eventId) ?? 0,
        clusterOpenUsd: exposure.byCluster.get(evCtx.region) ?? 0,
        dayOpenUsd: exposure.byDay.get(dateISO(evCtx.targetDate)) ?? 0,
      },
      cfg,
    );

    // (6) RECOMMENDATIONS
    for (const plan of plans) {
      const row = rows[plan.bucketIdx]!;
      const bucket = evCtx.buckets[plan.bucketIdx]!;
      const j = passing.findIndex((r) => r.bucketIdx === plan.bucketIdx);
      const existing = bucket.openRec;

      if (existing && Math.abs(row.execAsk! - Number(existing.execAsk)) <= 0.01) continue; // unmoved — keep

      const audit = {
        q: row.q, execAsk: row.execAsk, bestAsk: row.bestAsk,
        bookHash: books[plan.bucketIdx]?.hash ?? null,
        mu: evCtx.champion!.mu, sigma: evCtx.champion!.sigma,
        statsVersion: evCtx.champion!.statsVersion, distRowId: evCtx.champion!.id,
        nowcast: evCtx.champion!.nowcast, leadDays: lead,
        kellyC: c, kellyRaw: fractions[j], kellyFrac: fractional[j],
        effectiveCost: effCost[j], feePerShare: row.feePerShare, paperSlippage: cfg.paperSlippage,
        capAudit: plan.capAudit,
        // config values used VERBATIM — the audit derives the stake without a config-version lookup
        config: {
          kellyFraction: cfg.kellyFraction, perTradeCapPct: cfg.perTradeCapPct,
          perEventCapPct: cfg.perEventCapPct, clusterCapPct: cfg.clusterCapPct,
          dailyCapPct: cfg.dailyCapPct, uncertaintyMargin: cfg.uncertaintyMargin,
          spreadBufferMin: cfg.spreadBufferMin, probeStakeUsd: cfg.probeStakeUsd,
          minStakeUsd: cfg.minStakeUsd, bankrollUsd,
        },
      };
      const [rec] = await db.rpc<{ bet_id: string; was_insert: boolean }>('upsert_recommendation', {
        p_event_id: evCtx.eventId, p_bucket_id: bucket.bucketId, p_mode: cfg.tradingMode,
        p_our_q: row.q, p_best_ask: row.bestAsk, p_exec_ask: row.execAsk,
        p_edge: row.edge, p_min_edge: row.minEdge, p_fee_per_share: row.feePerShare,
        p_kelly_raw: fractions[j], p_kelly_frac: fractional[j],
        p_capped_frac: bankrollUsd > 0 ? plan.stakeUsd / bankrollUsd : 0,
        p_stake: plan.stakeUsd, p_shares: plan.shares,
        p_audit: audit, p_dist_row_id: evCtx.champion!.id,
      });

      const stakeChanged = existing
        ? Math.abs(plan.stakeUsd - Number(existing.recStakeUsd)) / Number(existing.recStakeUsd) >= 0.2
        : true;
      if (rec?.was_insert) stats['recommendationsNew']!++;
      else stats['refreshed']!++;
      if (rec?.was_insert || stakeChanged) {
        const band = Math.round(row.execAsk! * 20) / 20; // 5¢ price band for the dedupe key
        const delivered = await deps.notify({
          kind: 'BET_REC', severity: 'ACTION',
          title: `${rec?.was_insert ? 'BET' : 'UPDATED'}: ${evCtx.slug} · ${bucket.label}`,
          body:
            `q ${row.q.toFixed(3)} vs ask ${row.execAsk!.toFixed(3)} (edge ${row.edge!.toFixed(3)} ≥ min ${row.minEdge!.toFixed(3)})\n` +
            `stake $${plan.stakeUsd.toFixed(2)} (${plan.shares} shares) · lead ${lead} · ${cfg.tradingMode}`,
          dedupeKey: `bet-rec:${bucket.bucketId}:${band}`,
        });
        // §6.12: BET_REC additionally records delivery status on the bet.
        if (rec) {
          await db.rpc('note_bet_slack_delivery', { p_bet_id: rec.bet_id, p_delivered: delivered });
        }
      }
    }
  }
  stats['staleChampions'] = staleChampions;

  // --- (3b) ANALYTICS EDGE PASS (EDGE-1 / DF-4A, ADR-18) -------------------------
  // Compute the PURE model-vs-market edge (computeBucketEdges only — NO liquidity
  // vetoes) for EVERY open event with a fresh champion, regardless of betting
  // authorization, and merge into edgeRowsByEvent so step (8) records the
  // analytics time-series (q vs execAsk per bucket per hour). `bettable` gates
  // ONLY the bet/recommendation/expiry path above; verified/betting_enabled are
  // live-trading gates (Issue #4) — this audit writes ONLY edge_evaluations (a
  // read-only sink: no FK to bets, no path to bankroll), so no bet or fill can
  // result. applyLiquidityFilters is deliberately NOT applied here: its
  // station_unverified / volume_below_min / halted vetoes would mark every
  // analytics row pass=false and poison the "did the model have an edge" signal;
  // the dashboard display recompute (edge-display.ts) is also computeBucketEdges-
  // only, so stored rows match it on q/execAsk/edge/minEdge (§15 no-drift).
  //
  // DORMANT until house_gaussian champions exist (Phase 2 capture fix + Phase 3
  // de-gate): with 0 house rows today, evCtx.champion is null for every event and
  // this loop is a no-op — it lights up automatically when the model side appears.
  for (const [polyId, parsed] of parsedByPolyId) {
    const evCtx = known.get(polyId)!;
    if (edgeRowsByEvent.has(evCtx.eventId)) continue; // already computed in the candidate loop — keep those rows
    if (evCtx.closed || evCtx.graded || !evCtx.buckets?.length) continue;
    if (!evCtx.champion) continue;
    if (deps.now.getTime() - new Date(evCtx.champion.madeAt).getTime() > CHAMPION_FRESH_MS) continue;
    const lead = leadDays(deps.now, dateISO(evCtx.targetDate), evCtx.tz);
    if (lead < 0 || lead > cfg.maxLeadDays) continue;

    const q = evCtx.champion.probs.map(Number);
    if (q.length !== evCtx.buckets.length) {
      log('analytics edge skipped — champion/bucket length mismatch', {
        slug: evCtx.slug, q: q.length, buckets: evCtx.buckets.length,
      });
      continue;
    }
    const ladder: BucketDef[] = evCtx.buckets.map((b) => ({ low: b.low, high: b.high, unit: evCtx.unit }));
    const marketRows = evCtx.buckets.map((bucket) => {
      const pb = bucket.polyMarketId
        ? parsed.buckets.find((p) => p.marketId === bucket.polyMarketId)
        : parsed.buckets[bucket.idx];
      return {
        feeRate: Number(bucket.feeRate ?? pb?.feeRate ?? 0.05),
        spread: pb?.spread ?? null,
        bestAsk: pb?.bestAsk ?? null,
        bucket,
      };
    });
    // The ≤15/cycle book budget is spent on candidates; non-candidate events
    // fetch NO book → books=[null,...] → computeBucketEdges marks each row
    // reasons=['no_book'], edge=null (honest: the model prob existed, no live
    // book this tick — q-vs-mid is still recoverable from market_consensus).
    const books: (NormalizedBook | null)[] = evCtx.buckets.map(() => null);
    const edgeCfg = {
      uncertaintyMargin: cfg.uncertaintyMargin, spreadBufferMin: cfg.spreadBufferMin,
      feeRate: 0.05, probeStakeUsd: cfg.probeStakeUsd, maxSpread: cfg.maxSpread,
      minEventVolumeUsd: cfg.minEventVolumeUsd, minHoursBeforeClose: cfg.minHoursBeforeClose,
    };
    const rows = computeBucketEdges(q, ladder, books, marketRows, edgeCfg);
    edgeRowsByEvent.set(evCtx.eventId, { evCtx, rows });
  }

  // --- (7) EXPIRY (ADR-09 CAS) ---------------------------------------------------
  const expiredLines: string[] = [];
  for (const evCtx of known.values()) {
    for (const bucket of evCtx.buckets) {
      if (!bucket.openRec) continue;
      const { endUtc } = localDayWindow(evCtx.tz, dateISO(evCtx.targetDate));
      const secsToClose = (endUtc.getTime() - deps.now.getTime()) / 1000;
      const fresh = edgeRowsByEvent.get(evCtx.eventId)?.rows[bucket.idx];
      let reason: string | null = null;
      if (secsToClose < cfg.minHoursBeforeClose * 3600) reason = 'too_close_to_resolution';
      else if (fresh && fresh.edge !== null && fresh.minEdge !== null && fresh.edge < fresh.minEdge / 2) {
        reason = 'edge_collapsed';
      }
      if (!reason) continue;
      const [done] = await db.rpc<{ expire_recommendation: boolean }>('expire_recommendation', {
        p_bet_id: bucket.openRec.betId,
        p_reason: reason,
      });
      if (done?.expire_recommendation) {
        stats['expired']!++;
        expiredLines.push(`${evCtx.slug} · ${bucket.label} (${reason})`);
        if (cfg.tradingMode === 'live' && deps.cancelLiveOrder) {
          await deps.cancelLiveOrder(bucket.openRec.betId); // §6.20a chokepoint
        }
      }
    }
  }
  if (expiredLines.length > 0) {
    await deps.notify({
      kind: 'BET_EXPIRED', severity: 'INFO',
      title: `${expiredLines.length} recommendation(s) expired`,
      body: expiredLines.join('\n'),
    });
  }

  // --- (8) HOURLY AUDIT (F-038) -----------------------------------------------
  // EDGE-2 / ADR-20 — persist on EVERY tick (the getUTCMinutes()<5 clock gate is
  // gone). captured_hour stays hour-truncated, and persist_edge_evaluations'
  // ON CONFLICT (event_id,bucket_idx,captured_hour) DO NOTHING makes every tick
  // idempotent → exactly 1 row per (event,bucket,hour): the first tick of the
  // hour inserts, later ticks no-op. This makes the audit RELIABLE, not denser
  // (X-3b): the old gate wasn't "once an hour", it was "never on the real
  // schedule" — the live poll cron is `15 10,22` (minute 15), which never
  // satisfied minute<5, so the audit previously never fired on the schedule.
  // (A genuinely sub-hour series would need captured_hour=tick-timestamp + a
  // changed unique key + retention/read changes — a separate decision, ADR-20.)
  if (edgeRowsByEvent.size > 0) {
    const hour = new Date(deps.now);
    hour.setUTCMinutes(0, 0, 0);
    const auditRows = [...edgeRowsByEvent.values()].flatMap(({ evCtx, rows }) =>
      rows.map((r) => ({
        event_id: evCtx.eventId, bucket_idx: r.bucketIdx, captured_hour: hour.toISOString(),
        q: r.q, exec_ask: r.execAsk, edge: r.edge, min_edge: r.minEdge,
        pass: r.pass, reasons: r.reasons,
      })),
    );
    const [n] = await db.rpc<{ persist_edge_evaluations: number }>('persist_edge_evaluations', {
      p_rows: auditRows,
    });
    stats['evaluationsPersisted'] = Number(n?.persist_edge_evaluations ?? 0);
  }

  // --- (9) POSITION WATCH (ADR-17 — display + alert only, never auto-exit) -------
  const watch = await db.rpc<{ bet_id: string; slug: string; label: string; entry_q: string; current_q: string }>(
    'position_watch',
    { p_champion: cfg.championSource },
  );
  for (const w of watch) {
    if (Number(w.current_q) < Number(w.entry_q) / 2) {
      await deps.notify({
        kind: 'POSITION_WATCH', severity: 'WARN',
        title: `Position deteriorated: ${w.slug} · ${w.label}`,
        body: `champion q fell to ${Number(w.current_q).toFixed(3)} (entry ${Number(w.entry_q).toFixed(3)}) — review (ADR-17: no auto-exit)`,
        dedupeKey: `position-watch:${w.bet_id}`,
      });
    }
  }

  stats['cpuMs'] = Date.now() - cpuStart;
  log('poll complete', stats);
  return stats;
}
