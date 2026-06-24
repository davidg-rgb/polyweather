/**
 * whale-watch — the Polymarket large-trade alarm (migration 0055; operator ask 2026-06-24).
 *
 * Polls the GLOBAL /trades feed with a server-side CASH floor (only fills whose USDC notional ≥ whale_min_usd),
 * records new ones in whale_trades (idempotent by trade_key), and fires ONE Slack alert per NEW whale with the
 * market / side / outcome / size / price / trader + a polymarket.com/event link. Read-only — it places no
 * trades (the live-trading rail stays DORMANT per CLAUDE.md / FINDINGS.md); pure market-microstructure analytics,
 * a sibling of the 0049 sharp-wallet tracker.
 *
 * Crash-safe, at-least-once: alerts run off the whale_pending_alerts queue and only mark `alerted` on a
 * DELIVERED Slack post, so a tick that records then dies re-alerts next run. Best-effort throughout: a
 * Polymarket outage is caught and yields an empty poll — it never fails the job (which matters doubly now that
 * non-whale JOB_FAIL alerts may be paused by the 0055 gate). Schedule: every 10 min.
 */
import { fetchTrades, type FetchJsonLike, type Trade } from '../_shared/polymarket-wallet.ts';
import { notifySlack } from '../_shared/slack.ts';
import type { AlertSeverity } from '../../../packages/io/src/index.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

const POLYMARKET_EVENT_URL = 'https://polymarket.com/event/';
const POLYGONSCAN_TX_URL = 'https://polygonscan.com/tx/';
const DEFAULT_MIN_USD = 100_000;
const ALERT_KIND = 'WHALE_TRADE';

export interface WhaleWatchDeps {
  now: Date;
  /** Injected JSON fetcher (packages/io fetchJson). Omit in tests to skip the network (a no-op tick). */
  fetchJson?: FetchJsonLike;
  /** Override the DB-configured threshold (tests / ad-hoc). */
  minUsd?: number;
  /** Pages of the filtered feed to pull per tick (burst headroom; default 3). */
  maxPages?: number;
  /** Cap alerts dispatched per tick (default 25). */
  maxAlerts?: number;
}

interface PendingWhale {
  tradeKey: string;
  txHash: string;
  proxyWallet: string;
  trader: string;
  side: string | null;
  outcome: string | null;
  title: string | null;
  sizeShares: number;
  price: number;
  notionalUsd: number;
  link: string | null;
  tradedAt: string;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Thousands separator without locale data (Deno-portable). */
const commas = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const usd = (n: number): string => `$${commas(n)}`;
/** Compact USD for the alert title: $1.25M / $255k / $900. */
function usdShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

/** Bigger trades shout louder. $100k floor → ACTION; ≥$250k → WARN; ≥$1M → CRITICAL. */
function severityFor(notionalUsd: number): AlertSeverity {
  if (notionalUsd >= 1_000_000) return 'CRITICAL';
  if (notionalUsd >= 250_000) return 'WARN';
  return 'ACTION';
}

/** Deterministic per-fill id (dedup spine) — stable across re-polls of the same row. */
const tradeKey = (t: Trade): string =>
  `${t.transactionHash}:${t.asset}:${t.side ?? ''}:${t.sizeShares}:${t.price}:${t.timestamp}`;

/** The clickable bet link: the event page when we have a slug, else the on-chain tx as a guaranteed fallback. */
const linkFor = (t: Trade): string =>
  t.eventSlug ? `${POLYMARKET_EVENT_URL}${t.eventSlug}` : `${POLYGONSCAN_TX_URL}${t.transactionHash}`;

/** The Slack message body — what was bet, by whom, how much, and where (with the link). */
function alertBody(w: PendingWhale): string {
  const price = Number(w.price);
  const prob = Number.isFinite(price) ? `${Math.round(price * 100)}%` : '—';
  const lines = [
    `*${w.trader}* ${w.side ?? ''} *${w.outcome ?? '?'}* on _${w.title ?? 'a market'}_`,
    `Notional *${usd(Number(w.notionalUsd))}*  ·  ${commas(Number(w.sizeShares))} shares @ ${price.toFixed(3)} (${prob} implied)`,
  ];
  if (w.link) lines.push(`<${w.link}|View the bet on Polymarket →>`);
  lines.push(`<${POLYGONSCAN_TX_URL}${w.txHash}|tx on Polygonscan>`);
  return lines.join('\n');
}

export async function whaleWatch(ctx: JobCtx, deps: WhaleWatchDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const asOf = deps.now.toISOString();
  const maxPages = deps.maxPages ?? 3;
  const maxAlerts = deps.maxAlerts ?? 25;

  if (!deps.fetchJson) {
    log('whale-watch skipped (no fetchJson injected)');
    return { asOf, minUsd: 0, fetched: 0, newRecorded: 0, pending: 0, alerted: 0 };
  }
  const fetchJson = deps.fetchJson;

  // threshold: explicit dep > DB config (whale_min_usd) > default. DB-tunable, no redeploy.
  let minUsd = deps.minUsd ?? DEFAULT_MIN_USD;
  if (deps.minUsd === undefined) {
    try {
      const s = await db.rpc<{ whale_settings: { minUsd: number | string } }>('whale_settings', {});
      const v = Number(s[0]?.whale_settings?.minUsd);
      if (Number.isFinite(v) && v > 0) minUsd = v;
    } catch (e) {
      log('whale_settings read failed — using default threshold (non-fatal)', { error: msg(e) });
    }
  }

  // --- poll the global whale feed (best-effort: an outage is an empty poll, never a job failure) ---
  let trades: Trade[] = [];
  try {
    trades = await fetchTrades(fetchJson, {
      filterType: 'CASH',
      filterAmount: minUsd,
      takerOnly: true,
      limit: 100,
      maxPages,
      timeoutMs: 8000,
      retries: 1,
    });
  } catch (e) {
    log('whale feed fetch failed (non-fatal — empty poll)', { error: msg(e) });
  }

  // Belt-and-braces: the server already filters by CASH ≥ minUsd, but a drifted filter must never let
  // sub-threshold noise through. Keep only fills that clear the floor.
  const whales = trades.filter((t) => t.notionalUsd >= minUsd);

  // --- record (idempotent by trade_key) ----------------------------------------------------------
  let newRecorded = 0;
  if (whales.length > 0) {
    const rows = whales.map((t) => ({
      tradeKey: tradeKey(t),
      transactionHash: t.transactionHash,
      proxyWallet: t.proxyWallet,
      traderName: t.traderName,
      asset: t.asset,
      conditionId: t.conditionId,
      outcome: t.outcome,
      side: t.side,
      sizeShares: t.sizeShares,
      price: t.price,
      notionalUsd: t.notionalUsd,
      title: t.title,
      eventSlug: t.eventSlug,
      marketSlug: t.slug,
      link: linkFor(t),
      timestamp: t.timestamp,
    }));
    try {
      const r = await db.rpc<{ whale_record_trades: number }>('whale_record_trades', { p_rows: rows });
      newRecorded = Number(r[0]?.whale_record_trades ?? 0);
    } catch (e) {
      log('whale_record_trades failed (non-fatal)', { error: msg(e) });
    }
  }

  // --- alert off the durable queue (crash-safe; mark only on a delivered post) --------------------
  let pending: PendingWhale[] = [];
  try {
    const p = await db.rpc<{ whale_pending_alerts: PendingWhale[] }>('whale_pending_alerts', { p_limit: maxAlerts });
    pending = p[0]?.whale_pending_alerts ?? [];
  } catch (e) {
    log('whale_pending_alerts read failed (non-fatal)', { error: msg(e) });
  }

  const delivered: string[] = [];
  for (const w of pending) {
    const ok = await notifySlack(db, {
      kind: ALERT_KIND,
      severity: severityFor(Number(w.notionalUsd)),
      title: `${usdShort(Number(w.notionalUsd))}${w.side ? ` ${w.side}` : ''} — ${w.title ?? 'Polymarket trade'}`,
      body: alertBody(w),
      dedupeKey: w.tradeKey, // one alert per fill, ever (claim_alert per-day dedupe over the durable queue)
    });
    if (ok) delivered.push(w.tradeKey);
  }

  if (delivered.length > 0) {
    try {
      await db.rpc('whale_mark_alerted', { p_keys: delivered });
    } catch (e) {
      log('whale_mark_alerted failed (non-fatal — re-alerts next tick)', { error: msg(e) });
    }
  }

  const stats = {
    asOf,
    minUsd,
    fetched: trades.length,
    newRecorded,
    pending: pending.length,
    alerted: delivered.length,
  };
  log('whale-watch complete', stats);
  return stats;
}
