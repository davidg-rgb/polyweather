/**
 * opening-capture — the KEYLESS forward measurement harness for the opening-convergence bot (Phase 0,
 * ARCHITECTURE-OPENING-CONVERGENCE.md §6.10). A structural clone of cross-venue-capture.
 *
 * Each tick (~every 2 min FIRST-SEEN poll — §16-D, the flat-open window is ≤~1h):
 *   1. enumerate open near-dated Polymarket temperature ladders (Gamma tag 104596), parse (failures skipped).
 *   2. keep the §9R scoped-city near-dated 'highest' events with evVol24h ≥ the floor (the universe).
 *   3. per event: seed our house_gaussian on-demand (seedHouseDist) AND walk the TRUE CLOB depth of the
 *      tradeable buckets — concurrently, bounded — then assemble one opening_captures row (peak_mid,
 *      is_flat_open via the pure core rule, per-bucket depth + identity-aligned houseProb).
 *   4. record all rows via the service-role record_opening_captures RPC. Append-only.
 *
 * Read-only against Polymarket; no key, no packages/trading, rail-DORMANT-safe. Best-effort: a venue/seed
 * outage shrinks the panel (null houseProb / depth 0), NEVER fails the job — the flat-open depth is measured
 * regardless (the experiment). The capture_deadman_check cron alarms if it silently stops producing usable rows.
 */
import {
  executableAsk,
  isDstAwareIana,
  normalizeBook,
  parseGammaEvent,
  type ParsedEvent,
  type RawClobBook,
  type RawGammaEvent,
} from '../../../packages/core/src/index.ts';
import { parseBotConfig, type BotConfig } from '../../../packages/core/src/sim/opening-convergence.ts';
import { buildOpeningCaptureRow, type BucketDepth, type OpeningCaptureRow } from './pure.ts';
import { seedHouseDist, type SeedDeps, type SeedStation } from './seed.ts';
import { getEnv } from '../_shared/auth.ts';
import type { FetchJsonLike } from '../_shared/polymarket-wallet.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596; // "Highest temperature" — the daily-Tmax ladders
const HEADERS: Record<string, string> = { 'User-Agent': 'weather-edge/0.1 (opening-capture)', Accept: 'application/json' };
const MAX_LEAD_DAYS = 2;
const EVENT_CONCURRENCY = 4;   // F16 burst bound — cap in-flight events (each does a seed + a bucket-walk)
const SEED_TIME_BUDGET_MS = 110_000; // once exceeded, remaining events record houseProb=null rather than time out the wall-clock

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface OpeningCaptureDeps {
  now: Date;
  fetchJson: FetchJsonLike;
}

interface RawEvent {
  ev: ParsedEvent;
  polyEventId: string;
  endDate: string | null;
}

/** the scoped city's keys resolved via bot_resolve_event_keys. */
interface EventKeys {
  cityId: string;
  tz: string;
  icao: string | null;
}

/** Days until a target date (YYYY-MM-DD) from `now` (negative = past). */
function leadDaysOf(targetDate: string, now: Date): number {
  return (new Date(`${targetDate}T23:59:59Z`).getTime() - now.getTime()) / 86_400_000;
}

/** Page all active open temperature events from Gamma → parsed + the raw id/endDate (parse failures skipped). */
async function fetchOpenEvents(fetchJson: FetchJsonLike, log: JobCtx['log']): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let parseFails = 0;
  for (let offset = 0; ; offset += 100) {
    const url = `${GAMMA}/events?tag_id=${TAG}&active=true&closed=false&limit=100&offset=${offset}`;
    let page: unknown;
    try {
      page = await fetchJson(url, { headers: HEADERS } as RequestInit, { timeoutMs: 10_000, retries: 1 });
    } catch (e) {
      log('gamma page failed (non-fatal — partial universe)', { error: msg(e), offset });
      break;
    }
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page as RawGammaEvent[]) {
      try {
        out.push({ ev: parseGammaEvent(raw), polyEventId: raw.id, endDate: raw.endDate ?? null });
      } catch {
        parseFails++;
      }
    }
    if (page.length < 100) break;
  }
  log('gamma enumeration done', { parsed: out.length, parseFails });
  return out;
}

/** Walk the TRUE CLOB /book for one YES token → {execAsk, depthUsd(+10% band), bestBid, sellbackUsd}. null on failure. */
async function walkBucketDepth(fetchJson: FetchJsonLike, token: string, perPositionUsd: number): Promise<BucketDepth | null> {
  try {
    const book = normalizeBook(
      (await fetchJson(`${CLOB}/book?token_id=${token}`, { headers: HEADERS } as RequestInit, { timeoutMs: 6000, retries: 1 })) as RawClobBook,
    );
    const bestAsk = book.asks[0]?.price ?? null;
    const bestBid = book.bids[0]?.price ?? null;
    const band = bestAsk != null && bestAsk > 0 ? bestAsk * 1.1 : Number.POSITIVE_INFINITY;
    const depthUsd = book.asks.filter((l) => l.price <= band).reduce((s, l) => s + l.price * l.size, 0);
    const targetShares = bestAsk != null && bestAsk > 0 ? perPositionUsd / bestAsk : 0;
    const exec = targetShares > 0 ? executableAsk(book, targetShares).avgPrice : NaN;
    const sellbackUsd = bestBid != null ? bestBid * (book.bids[0]?.size ?? 0) : 0;
    return { execAsk: Number.isFinite(exec) ? exec : null, depthUsd, bestBid, sellbackUsd };
  } catch {
    return null; // unfetchable book ⇒ depth 0 / null (best-effort, the experiment continues)
  }
}

/** Bounded-concurrency async map (F16 burst bound) — at most `limit` thunks in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function openingCapture(ctx: JobCtx, deps: OpeningCaptureDeps): Promise<JobStats> {
  const { db, config, log } = ctx;
  const { now, fetchJson } = deps;
  const capturedAt = now.toISOString();
  const startMs = now.getTime();

  const botCfg: BotConfig = parseBotConfig(await db.getConfigRows());
  const citySet = new Set(botCfg.cities);

  // ── STEP 1–2: enumerate → scoped near-dated 'highest' universe with the vol floor ───────────────────────
  const all = await fetchOpenEvents(fetchJson, log);
  const universe = all.filter(
    (r) =>
      r.ev.kind === 'highest' &&
      r.ev.acceptingOrders &&
      citySet.has(r.ev.citySlug) &&
      (r.ev.eventVolume24h ?? 0) >= botCfg.minVol24hUsd &&
      leadDaysOf(r.ev.targetDate, now) >= -0.5 &&
      leadDaysOf(r.ev.targetDate, now) <= MAX_LEAD_DAYS,
  );
  log('opening universe selected', {
    polyEvents: all.length,
    universe: universe.length,
    cities: new Set(universe.map((r) => r.ev.citySlug)).size,
  });

  // shared seed inputs (fetched ONCE per tick — F16 dedupe).
  const omApiKey = getEnv('OPENMETEO_API_KEY');
  const omPrefix = omApiKey ? 'customer-' : '';
  const models = (await db.rpc<{ slug: string }>('list_enabled_models', { p_is_ensemble: false })).map((m) => m.slug);
  const stations = await db.rpc<SeedStation>('list_active_stations', {});

  // ── STEP 3: per event — resolve tz (fail-closed on Etc/*/non-IANA), seed + walk depth, build the row ────
  const rows: OpeningCaptureRow[] = [];
  let seeded = 0;
  let flatOpen = 0;
  let noTz = 0;
  const seedReasons = new Map<string, number>(); // diagnostic tally of why the seed didn't produce

  await mapLimit(universe, EVENT_CONCURRENCY, async ({ ev, polyEventId, endDate }) => {
    // resolve the scoped city's keys ONCE (tz + cityId + mapped icao) — reused by the seed.
    let keys: EventKeys | null = null;
    try {
      const r = (await db.rpc<{ bot_resolve_event_keys: EventKeys | null }>('bot_resolve_event_keys', { p_slug: ev.citySlug }))[0];
      keys = r?.bot_resolve_event_keys ?? null;
    } catch (e) {
      log('bot_resolve_event_keys failed (non-fatal)', { city: ev.citySlug, error: msg(e) });
    }
    // fail closed: a position needs a real DST-aware IANA tz (C2/C2b/ADR-OC-12). Without it, do not capture
    // (the row's tz_name is NOT NULL and a missing/Etc tz cannot drive a correct local-noon time-stop).
    if (!keys?.tz || !isDstAwareIana(keys.tz)) {
      noTz++;
      log('skip event — no DST-aware IANA tz (Etc/* or unmapped)', { city: ev.citySlug, tz: keys?.tz ?? null });
      return;
    }

    // seed on-demand (best-effort; honors a per-invocation time budget — F16). After the budget, capture the
    // depth with houseProb=null rather than risk timing out the edge wall-clock.
    const withinBudget = Date.now() - startMs < SEED_TIME_BUDGET_MS;
    const seedRes = withinBudget
      ? await seedHouseDist(ev, polyEventId, { cityId: keys.cityId, icao: ev.station?.icao ?? keys.icao }, {
          db,
          cfg: config,
          botCfg,
          fetchJson: (url: string) => fetchJson(url),
          now,
          omForecastBase: `https://${omPrefix}api.open-meteo.com`,
          ...(omApiKey ? { omApiKey } : {}),
          models,
          stations,
          log,
        } as SeedDeps)
      : { seeded: false, eventId: null, probsByLabel: new Map<string, number>(), reason: 'time_budget' };
    if (seedRes.seeded) seeded++;
    else {
      const key = (seedRes.reason ?? 'unknown').slice(0, 80);
      seedReasons.set(key, (seedReasons.get(key) ?? 0) + 1);
    }

    // walk the TRUE CLOB depth of the tradeable buckets (those with a two-sided quote) — bounded per event.
    const tradeable = ev.buckets
      .map((b, i) => ({ i, b }))
      .filter(({ b }) => b.bestBid != null && b.bestAsk != null && !(b.bestBid === 0 && b.bestAsk === 1));
    const depthByIdx = new Map<number, BucketDepth>();
    const walked = await mapLimit(tradeable, 8, async ({ i, b }) => ({
      i,
      d: await walkBucketDepth(fetchJson, b.tokenYes, botCfg.perPositionUsd),
    }));
    for (const w of walked) if (w.d) depthByIdx.set(w.i, w.d);

    const row = buildOpeningCaptureRow({
      ev,
      eventId: seedRes.eventId,
      polyEventId,
      tzName: keys.tz,
      createdAtGamma: ev.createdAt,
      resolvesAt: endDate,
      capturedAt,
      depthByIdx,
      probsByLabel: seedRes.probsByLabel,
      houseSeeded: seedRes.seeded,
      now,
      cfg: botCfg,
    });
    if (row.isFlatOpen) flatOpen++;
    rows.push(row);
  });

  // ── STEP 4: record (service-role RPC). Best-effort. ─────────────────────────────────────────────────────
  let inserted = 0;
  if (rows.length > 0) {
    try {
      const res = await db.rpc<{ record_opening_captures: number }>('record_opening_captures', { p_rows: rows });
      inserted = Number(res[0]?.record_opening_captures ?? rows.length);
    } catch (e) {
      log('record_opening_captures failed (non-fatal)', { error: msg(e) });
    }
  }

  const stats = {
    asOf: capturedAt,
    polyEvents: all.length,
    universe: universe.length,
    noTz,
    captured: rows.length,
    flatOpen,
    seeded,
    seededFlatOpen: rows.filter((r) => r.isFlatOpen && r.houseSeeded).length,
    seedReasons: Object.fromEntries(seedReasons),
    inserted,
  };
  log('opening-capture complete', stats);
  return stats;
}
