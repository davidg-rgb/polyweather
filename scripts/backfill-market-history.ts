/**
 * scripts/backfill-market-history — closed events + prices-history, best-effort
 * (§6.22, C2).
 *
 * Gamma closed events for tag 104596 (paginated) → parseGammaEvent →
 * market_events/market_buckets (closed, resolved winner from outcomePrices) →
 * per bucket YES token: CLOB prices-history (interval=max) →
 *   1. market_snapshots at DAILY granularity (last point per UTC day), and
 *   2. market_consensus rows AT THE ADR-16 CUTOFFS ONLY — for each lead in
 *      {1, 0}, the last price point at-or-before cutoff = startUtc − lead·24h.
 *      Post-cutoff prices are NEVER used (C2: they embed the day's
 *      observations and would leak truth into the walk-forward backtest);
 *      events lacking pre-cutoff points are skipped for that lead and counted.
 *
 * Scope: cities already in the DB (discovery owns city creation — historical
 * events for unmodeled cities have no station/tz/forecasts to backtest
 * against; they are counted and skipped). Existing live rows are never
 * clobbered: events upsert by poly_event_id (slug/natural-key collisions
 * adopt the stored row), snapshots collide on (bucket_id, captured_at),
 * consensus rows on the §7.12 (event_id, source, inputs_hash) key.
 *
 * Resumable: backfill_progress scope 'ev:{poly_event_id}' marks completed
 * events — re-runs skip them without refetching prices-history (--refetch
 * overrides). --limit bounds events ingested per run.
 *
 * Run: pnpm tsx scripts/backfill-market-history.ts [--from 2025-06-01]
 *        [--limit 200] [--refetch]
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  impliedDistribution,
  localDayWindow,
  parseGammaEvent,
  parsePricesHistory,
  type ParsedEvent,
  type PricePoint,
  type RawGammaEvent,
} from '../packages/core/src/index.ts';
import { fetchJson as ioFetchJson } from '../packages/io/src/index.ts';
import { getProgress, setProgress, type Db } from './lib/backfill.ts';
import { makeScriptDb } from './lib/script-db.ts';

export const SCRIPT = 'backfill-market-history';
const PAGE_SIZE = 100;
/** ADR-16: the consensus rows the backtest time-matches against. */
const CUTOFF_LEADS = [1, 0] as const;

export interface MarketHistoryArgs {
  /** Ignore events whose target_date is before this ISO date. */
  from?: string;
  /** Max events ingested this run (prices-history calls are the budget). */
  limit?: number;
  /** Re-ingest events already marked done. */
  refetch?: boolean;
}

export interface MarketHistoryDeps {
  db: Db;
  /** One Gamma closed-events page (tag 104596, closed=true). */
  fetchPage: (offset: number) => Promise<RawGammaEvent[]>;
  /** CLOB GET /prices-history?market={token}&interval=max for a YES token. */
  fetchPricesHistory: (tokenId: string) => Promise<unknown>;
  log: (msg: string) => void;
  now: () => Date;
}

export interface MarketHistoryStats {
  pages: number;
  eventsSeen: number;
  ingested: number;
  skippedAlreadyDone: number;
  skippedNotClosed: number;
  skippedBeforeFrom: number;
  skippedParse: number;
  skippedUnknownCity: number;
  eventsErrored: number;
  winnersRecorded: number;
  historyCalls: number;
  snapshotRows: number;
  consensusRows: number;
  leadsSkippedNoPreCutoff: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Last point per UTC day — the daily snapshot series. */
export function dailyLastPoints(points: PricePoint[]): PricePoint[] {
  const byDay = new Map<string, PricePoint>();
  for (const pt of points) {
    byDay.set(new Date(pt.t * 1000).toISOString().slice(0, 10), pt); // ascending input ⇒ last wins
  }
  return [...byDay.values()];
}

/** Last point at-or-before the cutoff — null when none exists (C2). */
export function lastPreCutoff(points: PricePoint[], cutoffMs: number): PricePoint | null {
  let best: PricePoint | null = null;
  for (const pt of points) {
    if (pt.t * 1000 > cutoffMs) break; // ascending
    best = pt;
  }
  return best;
}

interface CityRow {
  id: string;
  tz: string;
}

async function adoptOrInsertEvent(
  db: Db,
  ev: RawGammaEvent,
  parsed: ParsedEvent,
  city: CityRow,
  winnerIdx: number | null,
  now: Date,
): Promise<string> {
  const resolvedAt = ev.closedTime ?? ev.endDate ?? null;
  // Prefer the stored row when discovery already saw this event under ANY of
  // its three unique identities (poly id, slug, city×date×kind) — backfill
  // fills the resolved/closed fields and never rewrites identity.
  const [existing] = await db.query<{ id: string }>(
    `select id from market_events
     where poly_event_id = $1 or slug = $2
        or (city_id = $3 and target_date = $4 and kind = $5)
     limit 1`,
    [String(ev.id), parsed.slug, city.id, parsed.targetDate, parsed.kind],
  );
  if (existing) {
    await db.query(
      `update market_events
       set closed = true, accepting_orders = false,
           poly_resolved_winner_idx = coalesce($2, poly_resolved_winner_idx),
           resolved_at = coalesce(resolved_at, $3),
           volume24h = coalesce(volume24h, $4), liquidity = coalesce(liquidity, $5),
           last_seen = greatest(coalesce(last_seen, $6), $6)
       where id = $1`,
      [existing.id, winnerIdx, resolvedAt, parsed.eventVolume24h, parsed.liquidity, now.toISOString()],
    );
    return existing.id;
  }
  const [station] = await db.query<{ icao: string }>(`select icao from stations where icao = $1`, [
    parsed.station?.icao ?? '',
  ]);
  const [row] = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, kind, city_id, icao_at_creation, target_date, unit,
                                neg_risk_market_id, accepting_orders, volume24h, liquidity,
                                ladder_ok, ladder_problems, poly_resolved_winner_idx, resolved_at,
                                closed, first_seen, last_seen)
     values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11, $12, $13, $14, true, $15, $15)
     returning id`,
    [
      String(ev.id), parsed.slug, parsed.kind, city.id, station?.icao ?? null, parsed.targetDate,
      parsed.unit, parsed.negRiskMarketId, parsed.eventVolume24h, parsed.liquidity,
      parsed.ladderProblems.length === 0, parsed.ladderProblems, winnerIdx, resolvedAt,
      now.toISOString(),
    ],
  );
  return row!.id;
}

export async function backfillMarketHistory(
  args: MarketHistoryArgs,
  deps: MarketHistoryDeps,
): Promise<MarketHistoryStats> {
  const { db, log } = deps;
  const limit = args.limit ?? Infinity;
  const stats: MarketHistoryStats = {
    pages: 0, eventsSeen: 0, ingested: 0, skippedAlreadyDone: 0, skippedNotClosed: 0,
    skippedBeforeFrom: 0, skippedParse: 0, skippedUnknownCity: 0, eventsErrored: 0,
    winnersRecorded: 0, historyCalls: 0, snapshotRows: 0, consensusRows: 0,
    leadsSkippedNoPreCutoff: 0,
  };

  paging: for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await deps.fetchPage(offset);
    stats.pages++;
    for (const ev of page) {
      stats.eventsSeen++;
      if (stats.ingested >= limit) break paging;
      if (ev.closed !== true) {
        stats.skippedNotClosed++;
        continue;
      }

      // city first (cheap), then the progress gate, then the parse.
      const scope = `ev:${String(ev.id)}`;
      if (!args.refetch && (await getProgress(db, SCRIPT, scope)).status === 'done') {
        stats.skippedAlreadyDone++;
        continue;
      }

      let parsed: ParsedEvent;
      let city: CityRow | undefined;
      try {
        const slugCity = /^(?:highest|lowest)-temperature-in-(.+)-on-[a-z]+-\d{1,2}-\d{4}$/.exec(ev.slug)?.[1] ?? '';
        [city] = await db.query<CityRow>(`select id, tz from cities where slug = $1`, [slugCity]);
        parsed = parseGammaEvent(ev, city?.tz);
      } catch (e) {
        stats.skippedParse++;
        log(`parse failed — skipped: ${ev.slug} (${String(e)})`);
        continue;
      }
      if (args.from && parsed.targetDate < args.from) {
        stats.skippedBeforeFrom++;
        continue;
      }
      if (!city) {
        stats.skippedUnknownCity++;
        log(`unknown city '${parsed.citySlug}' — skipped (discovery owns city creation): ${ev.slug}`);
        continue;
      }

      try {
        const winnerIdx = parsed.buckets.findIndex((b) => b.outcomePricesResolved?.[0] === 1);
        const eventId = await adoptOrInsertEvent(
          db, ev, parsed, city, winnerIdx >= 0 ? winnerIdx : null, deps.now(),
        );
        if (winnerIdx >= 0) stats.winnersRecorded++;

        // buckets (idempotent on the (event_id, bucket_idx) natural key)
        const bucketIds: string[] = [];
        for (let i = 0; i < parsed.buckets.length; i++) {
          const b = parsed.buckets[i]!;
          const outcome =
            b.outcomePricesResolved === null ? null : b.outcomePricesResolved[0] === 1 ? 'win' : 'lose';
          const [row] = await db.query<{ id: string }>(
            `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native,
                                         poly_market_id, condition_id, token_yes, token_no,
                                         tick_size, min_order_size, fee_rate, resolved_outcome)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             on conflict (event_id, bucket_idx) do update
               set resolved_outcome = excluded.resolved_outcome,
                   fee_rate = coalesce(market_buckets.fee_rate, excluded.fee_rate)
             returning id`,
            [
              eventId, i, b.label,
              b.def.low === null || !Number.isFinite(b.def.low) ? null : b.def.low,
              b.def.high === null || !Number.isFinite(b.def.high) ? null : b.def.high,
              b.marketId, b.conditionId, b.tokenYes, b.tokenNo,
              b.tickSize, b.minOrderSize, b.feeRate, outcome,
            ],
          );
          bucketIds.push(row!.id);
        }

        // prices-history per bucket → daily snapshots + per-bucket point series
        const series: PricePoint[][] = [];
        for (let i = 0; i < parsed.buckets.length; i++) {
          const points = parsePricesHistory(
            await deps.fetchPricesHistory(parsed.buckets[i]!.tokenYes),
          );
          stats.historyCalls++;
          series.push(points);
          for (const pt of dailyLastPoints(points)) {
            const r = await db.query<{ id: string }>(
              `insert into market_snapshots (bucket_id, mid, captured_at)
               values ($1, $2, $3)
               on conflict (bucket_id, captured_at) do nothing
               returning id`,
              [bucketIds[i]!, pt.p, new Date(pt.t * 1000).toISOString()],
            );
            stats.snapshotRows += r.length;
          }
        }

        // consensus AT THE CUTOFFS (C2: pre-cutoff points only, ever)
        const { startUtc } = localDayWindow(city.tz, parsed.targetDate);
        for (const lead of CUTOFF_LEADS) {
          const cutoffMs = startUtc.getTime() - lead * 86_400_000;
          const picks = series.map((pts) => lastPreCutoff(pts, cutoffMs));
          const mids = picks.map((pt) => (pt ? pt.p : null));
          const dist = impliedDistribution(mids);
          if (!dist) {
            stats.leadsSkippedNoPreCutoff++;
            continue;
          }
          const madeAtMs = Math.max(...picks.filter((p): p is PricePoint => p !== null).map((p) => p.t * 1000));
          const hash = sha256(`mkthist|${eventId}|${lead}|${mids.map((m) => m ?? 'x').join(',')}`);
          const r = await db.query<{ id: string }>(
            `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs)
             values ($1, 'market_consensus', $2, false, $3, $4, $5)
             on conflict (event_id, source, inputs_hash) do nothing
             returning id`,
            [eventId, lead, new Date(madeAtMs).toISOString(), hash, dist],
          );
          stats.consensusRows += r.length;
        }

        await setProgress(db, SCRIPT, scope, parsed.targetDate, 'done');
        stats.ingested++;
      } catch (e) {
        stats.eventsErrored++;
        await setProgress(db, SCRIPT, scope, null, 'error');
        log(`event errored — continuing: ${ev.slug} (${String(e)})`);
      }
    }
    if (page.length < PAGE_SIZE) break;
  }

  log(
    `${SCRIPT} complete: ${stats.ingested} ingested of ${stats.eventsSeen} seen — ` +
      `winners ${stats.winnersRecorded} · snapshots ${stats.snapshotRows} · consensus ${stats.consensusRows} · ` +
      `leads skipped (no pre-cutoff) ${stats.leadsSkippedNoPreCutoff} · unknown-city ${stats.skippedUnknownCity} · ` +
      `parse-skipped ${stats.skippedParse} · errored ${stats.eventsErrored}`,
  );
  return stats;
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      limit: { type: 'string' },
      refetch: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  // Cloudflare fronts the CLOB host and rejects bare library user agents.
  const headers = { 'User-Agent': 'weather-edge/0.1 (research backfill)', Accept: 'application/json' };
  try {
    await backfillMarketHistory(
      {
        from: values.from,
        limit: values.limit ? Number(values.limit) : undefined,
        refetch: values.refetch ?? false,
      },
      {
        db,
        fetchPage: (offset) =>
          ioFetchJson(
            `https://gamma-api.polymarket.com/events?tag_id=104596&closed=true&limit=${PAGE_SIZE}&offset=${offset}`,
            { headers },
          ) as Promise<RawGammaEvent[]>,
        fetchPricesHistory: (tokenId) =>
          ioFetchJson(
            `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=10`,
            { headers },
          ),
        log: console.log,
        now: () => new Date(),
      },
    );
  } finally {
    await db.end();
  }
}
