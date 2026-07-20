/**
 * diag-requote — reproduce the buy-table-tick 0114 LIVE RE-QUOTE path locally against the REAL DB + venue.
 *
 * Runs the tick's own pure halves (requoteTargets → CLOB /book fetch → executableAsk) on the live
 * convergence_capture_inputs output for the current allowlist and prints target count, per-target live
 * quotes, and what selection would gate on. Use when the tick's stats show requoted=0 unexpectedly.
 *
 *   pnpm tsx scripts/research/diag-requote.ts
 */
import postgres from 'postgres';
import { executableAsk, normalizeBook, type RawCaptureRow, type RawClobBook } from '../../packages/core/src/index.ts';
import { fetchJson } from '../../packages/io/src/index.ts';
import {
  parseBuyTableConfig,
  requoteTargets,
} from '../../supabase/functions/buy-table-tick/handler.ts';
import { loadEnv } from '../lib/load-env.ts';

async function main(): Promise<number> {
  loadEnv();
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL not set (see .env.local)');
    return 1;
  }
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20, idle_timeout: 3 });
  try {
    const cfgRows = await sql<{ key: string; value: string }[]>`select key, value from config where key like 'buy_table.%'`;
    const cfg = parseBuyTableConfig(cfgRows.map((r) => ({ key: r.key, value: r.value })));
    const [tc] = await sql<{ city_allowlist: string[]; stake_per_buy_usd: string }[]>`
      select city_allowlist, stake_per_buy_usd from trade_config`;
    const allowlist = tc!.city_allowlist;
    const stakeUsd = Number(tc!.stake_per_buy_usd);
    const [env] = await sql<{ v: { captures: RawCaptureRow[]; resolutions: { id: string; winnerIdx: number | null; gradingMismatch: boolean }[] } }[]>`
      select public.convergence_capture_inputs(${2}, ${allowlist}::text[]) as v`;
    const captures = env!.v.captures ?? [];
    const resolutions = env!.v.resolutions ?? [];
    console.log(`captures=${captures.length} resolutions=${resolutions.length} allowlist=${allowlist.join(',')} stake=$${stakeUsd}`);
    console.log(`cfg lead=[${cfg.leadMinH},${cfg.leadMaxH}] cap=${cfg.priceCap} cityCaps=${JSON.stringify(cfg.cityCaps)}`);

    const now = new Date();

    // per-latest-event gate trace (mirrors requoteTargets' checks one by one)
    const resolvedBy = new Map(resolutions.map((r) => [String(r.id), r.winnerIdx ?? null]));
    const latest = new Map<string, RawCaptureRow>();
    for (const r of captures) {
      const prev = latest.get(r.eventId);
      if (!prev || Date.parse(r.capturedAt) > Date.parse(prev.capturedAt)) latest.set(r.eventId, r);
    }
    console.log('\nper-event gate trace:');
    for (const [eventId, r] of latest) {
      const hrs = (Date.parse(r.resolvesAt ?? '') - now.getTime()) / 3_600_000;
      console.log(
        `  ${String(r.city).padEnd(14)} ${r.targetDate} resolvedBy=${JSON.stringify(resolvedBy.get(eventId))} ` +
          `resolvesAt=${r.resolvesAt} hrs=${Number.isFinite(hrs) ? hrs.toFixed(2) : 'NaN'} ` +
          `buckets=${Array.isArray(r.buckets) ? r.buckets.length : 'none'}`,
      );
    }

    const targets = requoteTargets({ captures, resolutions, cfg, now });
    console.log(`\nrequoteTargets → ${targets.length}`);
    for (const t of targets) {
      const row = captures.filter((c) => c.eventId === t.eventId).at(-1);
      try {
        const book = normalizeBook(
          (await fetchJson(`https://clob.polymarket.com/book?token_id=${t.tokenYes}`, undefined, {
            timeoutMs: 5000,
            retries: 1,
          })) as RawClobBook,
        );
        const top = book.asks[0]?.price;
        if (top == null || !Number.isFinite(top) || !(top > 0 && top <= 1)) {
          console.log(`  ${row?.city ?? t.eventId}: NO USABLE TOP ASK (asks=${book.asks.length})`);
          continue;
        }
        const estShares = Math.max(1, Math.floor(stakeUsd / top));
        const { avgPrice, fillableShares } = executableAsk(book, estShares);
        console.log(
          `  ${row?.city ?? t.eventId}: top=${top} execAsk(${estShares}sh)=${avgPrice.toFixed(4)} fillable=${fillableShares}`,
        );
      } catch (e) {
        console.log(`  ${row?.city ?? t.eventId}: FETCH FAILED — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return 0;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().then((code) => process.exit(code));
