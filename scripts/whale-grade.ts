/**
 * scripts/whale-grade — the FORWARD one-off-insider grader (operator ask 2026-06-24, follow-up to the
 * whale-insider scan). The whale-watch alarm (0055) already CAPTURES every new ≥$whale_min_usd Polymarket
 * fill into `whale_trades`, live, every minute. This grader closes the loop the per-wallet z-test
 * structurally can't: it grades each captured big bet ONCE ITS MARKET RESOLVES and flags the
 * insider-SHAPED one-offs — a single large bet, on a NON-sports resolvable event, at non-obvious odds
 * (≤0.90), placed with lead time (>1d), that WON. That is the fingerprint of acting on information rather
 * than live-trading skill or favorite-backing (WHALE-INSIDER-SCAN.md).
 *
 * READ-ONLY: it SELECTs whale_trades and writes a local incremental ledger (no DB writes, no orders — the
 * live-trading rail stays DORMANT). Idempotent + incremental → safe to run forever on a schedule; each run
 * only grades trades whose market has newly resolved, then re-derives the flagged shortlist over the whole
 * ledger. Grading + scoring reuse the SAME shared primitives as the scan (packages/core/polymarket/insider,
 * io fetchMarketResolution), so a captured bet grades byte-identically to how the scan graded it.
 *
 * Run (schedule daily — markets resolve over hours/days):
 *   pnpm tsx scripts/whale-grade.ts [--min-age-hours 12] [--threshold 100000] [--concurrency 8]
 *                                   [--out scripts/research/out/whale-oneoffs.json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchJson } from '../packages/io/src/index.ts';
import { fetchMarketResolution, type MarketResolution } from '../packages/io/src/polymarket-wallet.ts';
import {
  categorizeMarket,
  fillHeldPnl,
  type InsiderThresholds,
  INSIDER_DEFAULTS,
  isInformativeBet,
  type MarketCategory,
} from '../packages/core/src/polymarket/insider.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';

const DAY = 86_400;

const commas = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '-$' : '$'}${commas(Math.abs(n))}`;
const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const padL = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s.padStart(n));

/** One captured whale fill from whale_trades (the forward-capture spine). */
interface WhaleTrade {
  tradeKey: string;
  conditionId: string;
  outcome: string;
  side: 'BUY' | 'SELL' | null;
  sizeShares: number;
  price: number;
  notionalUsd: number;
  title: string;
  eventSlug: string;
  trader: string;
  link: string | null;
  tradedTs: number;
}

/** A graded fill in the ledger (one per trade_key). */
interface Grade {
  tradeKey: string;
  conditionId: string;
  trader: string;
  title: string;
  category: MarketCategory;
  side: 'BUY' | 'SELL' | null;
  entryPrice: number;
  notionalUsd: number;
  tradedTs: number;
  resolved: true;
  won: boolean;
  heldPnlUsd: number;
  leadDays: number | null;
  informative: boolean;
  /** resolved && won && informative — the one-off-insider shortlist flag. */
  flagged: boolean;
  link: string | null;
  gradedAt: string;
}

interface Ledger {
  meta: { lastRunAt: string; thresholds: InsiderThresholds; note: string };
  grades: Record<string, Grade>;
}

/** Bounded-concurrency map. */
async function mapPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function gradeTrade(t: WhaleTrade, res: MarketResolution, thr: InsiderThresholds, nowIso: string): Grade {
  const heldPnlUsd = fillHeldPnl(t.side, t.outcome, t.sizeShares, t.price, res.winnerOutcome);
  const won = heldPnlUsd > 0;
  const leadDays = res.endTs != null ? Math.max(0, (res.endTs - t.tradedTs) / DAY) : null;
  const category = categorizeMarket(t.title, t.eventSlug);
  const informative = isInformativeBet(category, t.price, leadDays, thr);
  return {
    tradeKey: t.tradeKey,
    conditionId: t.conditionId,
    trader: t.trader,
    title: t.title,
    category,
    side: t.side,
    entryPrice: t.price,
    notionalUsd: t.notionalUsd,
    tradedTs: t.tradedTs,
    resolved: true,
    won,
    heldPnlUsd,
    leadDays,
    informative,
    flagged: won && informative,
    link: t.link,
    gradedAt: nowIso,
  };
}

/** Tolerant row → WhaleTrade mapper. Accepts both the local DB query result and the cloud Supabase-MCP
 *  `execute_sql` rows (snake_case keys; numbers OR strings; `traded_ts` epoch OR `traded_at` ISO). */
function toWhaleTrade(r: Record<string, unknown>): WhaleTrade {
  const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const n = (v: unknown): number => (v == null || v === '' ? Number.NaN : Number(v));
  const sideRaw = s(r.side).toUpperCase();
  let tradedTs = n(r.traded_ts);
  if (!Number.isFinite(tradedTs)) {
    const ta = r.traded_at;
    tradedTs = typeof ta === 'string' ? Math.floor(Date.parse(ta) / 1000) : Number.NaN;
  }
  return {
    tradeKey: s(r.trade_key),
    conditionId: s(r.condition_id),
    outcome: s(r.outcome),
    side: sideRaw === 'BUY' ? 'BUY' : sideRaw === 'SELL' ? 'SELL' : null,
    sizeShares: n(r.size_shares),
    price: n(r.price),
    notionalUsd: n(r.notional_usd),
    title: s(r.title),
    eventSlug: s(r.event_slug),
    trader: s(r.trader) || s(r.trader_name) || s(r.proxy_wallet),
    link: r.link == null ? null : s(r.link),
    tradedTs: Number.isFinite(tradedTs) ? tradedTs : 0,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'min-age-hours': { type: 'string' },
      threshold: { type: 'string' },
      concurrency: { type: 'string' },
      out: { type: 'string' },
      // CLOUD path: a JSON array of whale_trades rows fetched via the Supabase MCP (no local DB creds needed).
      'rows-file': { type: 'string' },
    },
  });
  const minAgeHours = Number(values['min-age-hours'] ?? 12);
  const threshold = Number(values.threshold ?? 0); // 0 = grade every captured whale (already ≥ whale_min_usd)
  const concurrency = Number(values.concurrency ?? 8);
  const outPath = values.out ?? 'scripts/research/out/whale-oneoffs.json';
  const rowsFile = values['rows-file'];
  const nowIso = new Date().toISOString();
  const log = (s: string) => process.stderr.write(s + '\n');

  // load the incremental ledger (carried across local runs; cloud runs typically start fresh and re-derive)
  let ledger: Ledger = {
    meta: {
      lastRunAt: nowIso,
      thresholds: INSIDER_DEFAULTS,
      note:
        'Forward one-off-insider grades over whale_trades (whale-watch 0055 capture). flagged = a resolved, ' +
        'WON, INSIDER-SHAPED big bet (non-sports, odds ≤0.90, >1d lead). Idempotent; re-derivable from scratch.',
    },
    grades: {},
  };
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8')) as Ledger;
      if (prev && typeof prev === 'object' && prev.grades) ledger = { ...ledger, grades: prev.grades };
    } catch {
      log(`  (could not parse existing ledger at ${outPath} — starting fresh)`);
    }
  }

  // ── source the captured whales: a Supabase-MCP rows file (cloud) OR a direct DB read (local) ───────────
  const valid = (t: WhaleTrade): boolean =>
    t.tradeKey !== '' && t.conditionId !== '' && Number.isFinite(t.price) && Number.isFinite(t.sizeShares) && t.notionalUsd >= threshold;
  let trades: WhaleTrade[];
  if (rowsFile) {
    const raw = JSON.parse(readFileSync(rowsFile, 'utf8')) as unknown;
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { rows?: unknown[] })?.rows)
        ? (raw as { rows: unknown[] }).rows
        : Array.isArray((raw as { result?: unknown[] })?.result)
          ? (raw as { result: unknown[] }).result
          : [];
    trades = (arr as Record<string, unknown>[]).map(toWhaleTrade).filter(valid);
    log(`whale-grade — ${trades.length} rows from ${rowsFile} (cloud/MCP mode)`);
  } else {
    loadEnv();
    const db = makeScriptDb();
    try {
      const rows = await db.query<Record<string, unknown>>(
        `select trade_key, condition_id, outcome, side, size_shares, price, notional_usd, title, event_slug,
                coalesce(nullif(trader_name, ''), proxy_wallet) as trader, link,
                extract(epoch from traded_at)::bigint::text as traded_ts
           from public.whale_trades
          where condition_id is not null
            and notional_usd >= $1
            and traded_at < now() - make_interval(hours => $2)
          order by traded_at desc`,
        [threshold, minAgeHours],
      );
      trades = rows.map(toWhaleTrade).filter(valid);
      log(`whale-grade — ${trades.length} captured whale fills older than ${minAgeHours}h`);
    } finally {
      await db.end();
    }
  }

  const ungraded = trades.filter((t) => !ledger.grades[t.tradeKey]);
  log(`  ${ungraded.length} not yet graded → resolving their markets…`);

  // resolve each distinct market once (cache), then grade
  const cidList = [...new Set(ungraded.map((t) => t.conditionId))];
  const resByCid = new Map<string, MarketResolution>();
  let done = 0;
  const resolved = await mapPool(cidList, concurrency, async (cid) => {
    let r: MarketResolution;
    try {
      r = await fetchMarketResolution(fetchJson, cid, { timeoutMs: 12_000, retries: 2 });
    } catch {
      r = { resolved: false, winnerOutcome: null, endTs: null };
    }
    if (++done % 100 === 0) log(`    …resolved ${done}/${cidList.length}`);
    return [cid, r] as const;
  });
  for (const [cid, r] of resolved) resByCid.set(cid, r);

  let newlyGraded = 0;
  let stillOpen = 0;
  for (const t of ungraded) {
    const res = resByCid.get(t.conditionId);
    if (!res || !res.resolved) {
      stillOpen++;
      continue; // retry on a later run once it settles
    }
    ledger.grades[t.tradeKey] = gradeTrade(t, res, INSIDER_DEFAULTS, nowIso);
    newlyGraded++;
  }
  ledger.meta.lastRunAt = nowIso;

  // re-derive the flagged shortlist across the WHOLE ledger
  const all = Object.values(ledger.grades);
  const flagged = all.filter((g) => g.flagged).sort((a, b) => b.heldPnlUsd - a.heldPnlUsd);
  const informativeAll = all.filter((g) => g.informative);

  // ── persist ledger + a human report ───────────────────────────────────────────────────────────────────
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(ledger, null, 2));

  const lines: string[] = [];
  const P = (s = '') => {
    lines.push(s);
    console.log(s);
  };
  P(`# Whale one-off insider ledger — ${nowIso.slice(0, 10)}`);
  P(`Graded this run: ${newlyGraded} (still-open, retried later: ${stillOpen}) · total graded: ${all.length}`);
  P(
    `Informative bets seen (non-sports, ≤0.90, >1d lead): ${informativeAll.length} · ` +
      `of those WON & flagged: ${flagged.length}`,
  );
  P('');
  P('## ⚑ Flagged one-off candidates (resolved · won · insider-shaped) — newest-profit first');
  if (flagged.length === 0) {
    P('   (none yet — empty is the expected steady state; a hit is the signal to investigate that wallet)');
  } else {
    P('   trader              cat       @odds  size        profit       lead    market');
    for (const g of flagged.slice(0, 50)) {
      P(
        `   ${pad(g.trader, 18)} ${pad(g.category, 8)} @${g.entryPrice.toFixed(3)} ` +
          `${padL(usd(g.notionalUsd), 10)} ${padL(usd(g.heldPnlUsd), 11)} ` +
          `${padL(g.leadDays == null ? '—' : `${g.leadDays.toFixed(1)}d`, 6)}  ${pad(g.title, 40)}`,
      );
      if (g.link) P(`     ↳ ${g.link}`);
    }
  }
  P('');
  const mdPath = outPath.replace(/\.json$/, '.md');
  writeFileSync(mdPath, lines.join('\n'));
  log(`Wrote ${outPath} and ${mdPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('whale-grade crashed:', err?.stack ?? err);
    process.exit(1);
  });
}
