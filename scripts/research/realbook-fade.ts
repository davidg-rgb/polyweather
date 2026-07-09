/**
 * scripts/research/realbook-fade — the DECISIVE real-vs-synthetic test for the cheap-longshot NO-fade.
 *
 * The mid-based backtest (nonprice_fade_gate.py) says the cheap-longshot fade nets +1.8–3.5% (OOS + spread
 * ×2 robust). But that prices the fade off the MID via the CALIBRATED_BOOK synthetic spread. The faded
 * cohort is the least-liquid "unmoved" cheap buckets — exactly where the mid is most likely a STALE
 * one-sided mark you cannot transact at (trap #1: synthetic-book vs real-book). This prices the SAME fade
 * off the REAL observed bid/ask in the `opening_captures` archive (the only raw-book archive) and reports
 * the executable bid-side depth — the honest test.
 *
 * Fade a cheap bucket = buy NO at the real NO ask = (1 − bestBid). Held to resolution: NO redeems $1 iff
 * the bucket LOST. Real cost = (1−bestBid) + fee. Synthetic cost (same instant) = 1 − execBid(mid) via
 * CALIBRATED_BOOK, for the apples-to-apples spread comparison. Winner joined from the DB by
 * (city, target_date) → winning bucket LABEL (normalized; the archive event_id is often null). Depth =
 * sellbackUsd (the bid-side $ you'd lift — the fade's real capacity).
 *
 * Read-only (one bounded winner SELECT); writes only out/. Run:
 *   pnpm tsx scripts/research/realbook-fade.ts
 * Output: out/realbook-fade-REAL.csv, out/realbook-fade-SYNTH.csv, printed join-rate + depth summary.
 */
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { CALIBRATED_BOOK, synthBook } from '../../packages/core/src/sim/history-replay-ingest.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = join(HERE, 'out', 'opening-captures-archive');
const OUT_DIR = join(HERE, 'out');
const FEE = 0.05;
const BAND_LO = 0.05;
const BAND_HI = 0.35; // the cheap-longshot zone the mid-based fade lives in (mean 0.194)

/** normalize a bucket label for a semantic join: drop non-ascii (° / mojibake), lowercase, keep alnum. */
export function normLabel(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface CaptureBucket {
  label?: string | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  mid?: number | null;
  sellbackUsd?: number | null;
  depthUsd?: number | null;
}
interface CaptureRow {
  city?: string;
  target_date?: string;
  captured_at?: string;
  buckets?: CaptureBucket[];
}

async function main(): Promise<void> {
  if (!existsSync(ARCHIVE)) throw new Error(`no archive at ${ARCHIVE}`);
  loadEnv();
  const db = makeScriptDb();
  try {
    // 1) winners from the DB (authoritative), keyed by city|target_date -> winner label (normalized)
    const wrows = await db.query<{ city: string; target_date: string | Date; winner_label: string | null }>(
      `select c.slug as city, me.target_date, mb.label as winner_label
         from market_events me
         join market_buckets mb on mb.event_id = me.id and mb.bucket_idx = me.winning_bucket_idx
         join cities c on c.id = me.city_id
        where me.winning_bucket_idx is not null and me.target_date >= '2026-06-20'`,
    );
    const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
    const winnerByKey = new Map<string, string>();
    for (const r of wrows) winnerByKey.set(`${r.city}|${dISO(r.target_date)}`, normLabel(r.winner_label));
    console.log(`winners loaded: ${winnerByKey.size} (city,date) keys from DB (target_date >= 2026-06-20)`);

    // 2) stream the archive, join, price the fade both ways, one trade per (city,date,label)
    const realLines = ['city,target_date,net_return,net_pnl_usd'];
    const synthLines = ['city,target_date,net_return,net_pnl_usd'];
    const seen = new Set<string>();
    const depths: number[] = [];
    let rowsScanned = 0;
    let joinedEvents = 0;
    const seenEventKeys = new Set<string>();
    const unmatchedEventKeys = new Set<string>();
    let trades = 0;

    for (const file of readdirSync(ARCHIVE).filter((f) => f.endsWith('.ndjson.gz')).sort()) {
      const text = gunzipSync(readFileSync(join(ARCHIVE, file))).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let r: CaptureRow;
        try {
          r = JSON.parse(line) as CaptureRow;
        } catch {
          continue;
        }
        rowsScanned++;
        const city = r.city;
        const td = r.target_date ? dISO(r.target_date) : null;
        if (!city || !td || !Array.isArray(r.buckets)) continue;
        const evKey = `${city}|${td}`;
        seenEventKeys.add(evKey);
        const winnerLabel = winnerByKey.get(evKey);
        if (winnerLabel === undefined) {
          unmatchedEventKeys.add(evKey);
          continue;
        }
        joinedEvents++;
        for (const b of r.buckets) {
          const bid = b.bestBid;
          const ask = b.bestAsk;
          if (bid == null || ask == null || !(bid > 0) || !(ask < 1) || !(bid < ask)) continue;
          const mid = b.mid != null && b.mid > 0 && b.mid < 1 ? b.mid : (bid + ask) / 2;
          if (mid < BAND_LO || mid > BAND_HI) continue;
          const key = `${evKey}|${normLabel(b.label)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const won = normLabel(b.label) === winnerLabel ? 1 : 0;

          // REAL fade: buy NO at the real NO ask = 1 - bestBid, hold to resolution (NO pays 1 iff bucket lost)
          const realCost = 1 - bid + takerFeePerShare(1 - bid, FEE);
          const realProceeds = won ? 0 : 1;
          const realPnl = realProceeds - realCost;
          realLines.push(`${city},${td},${(realPnl / realCost).toFixed(6)},${realPnl.toFixed(6)}`);

          // SYNTHETIC fade (same instant): NO ask = 1 - execBid(mid) via CALIBRATED_BOOK
          const q = synthBook(mid, CALIBRATED_BOOK, 1);
          const execBid = q ? q.execBid : mid;
          const synCost = 1 - execBid + takerFeePerShare(1 - execBid, FEE);
          const synPnl = realProceeds - synCost;
          synthLines.push(`${city},${td},${(synPnl / synCost).toFixed(6)},${synPnl.toFixed(6)}`);

          if (b.sellbackUsd != null) depths.push(Number(b.sellbackUsd));
          trades++;
        }
      }
    }

    writeFileSync(join(OUT_DIR, 'realbook-fade-REAL.csv'), realLines.join('\n') + '\n');
    writeFileSync(join(OUT_DIR, 'realbook-fade-SYNTH.csv'), synthLines.join('\n') + '\n');

    depths.sort((a, b) => a - b);
    const q = (p: number): number => (depths.length ? depths[Math.floor((depths.length - 1) * p)]! : NaN);
    const joinRate = seenEventKeys.size ? joinedEvents > 0 ? (seenEventKeys.size - unmatchedEventKeys.size) / seenEventKeys.size : 0 : 0;
    console.log(`\n=== realbook-fade ===`);
    console.log(`  capture rows scanned: ${rowsScanned.toLocaleString()} · distinct (city,date) events: ${seenEventKeys.size} · matched to a DB winner: ${seenEventKeys.size - unmatchedEventKeys.size} (${(joinRate * 100).toFixed(1)}%)`);
    console.log(`  cheap-band fade trades (one per bucket): ${trades.toLocaleString()}`);
    console.log(`  bid-side executable depth (sellbackUsd) — the fade capacity: p10 $${q(0.1).toFixed(0)} · median $${q(0.5).toFixed(0)} · p90 $${q(0.9).toFixed(0)}`);
    console.log(`  panels → out/realbook-fade-REAL.csv (real bid/ask) · out/realbook-fade-SYNTH.csv (mid+CALIBRATED_BOOK)`);
    console.log(`  gate both: python <skill>/analytics.py gate --panel out/realbook-fade-REAL.csv`);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
