/**
 * scripts/research/flat-open-window — measures HOW LONG the flat-open window lasts after listing,
 * to pin the capture-layer cron cadence for the opening-convergence bot (handoff §5-A, §9R-B).
 *
 * The thesis entry rule (§9R-B) only fires while peak bucket mid ≤ 18% AND within ~6h of listing.
 * The probe (PROBE-RERUN-2026-06-27.md, finding #1) showed that by the time we sample ad hoc, the
 * freshest markets are already peak 26–34% — so the flat open is a brief first-hours window we can
 * only catch by capturing AT listing. THIS script measures that window's duration empirically:
 * for recently-RESOLVED near-dated markets it walks EVERY bucket's CLOB /prices-history, builds the
 * cross-bucket peak-mid series over the market's life, and reports how many hours elapsed before the
 * peak first crossed 18% / 25%. That duration = the maximum cron period that still catches the open.
 *
 * Read-only, KEYLESS, places NOTHING; never imports packages/trading.
 *   pnpm tsx scripts/research/flat-open-window.ts [--n N]   (default N=6, max 10)
 */
import { parseArgs } from 'node:util';
import {
  parseGammaEvent,
  parsePricesHistory,
  type ParsedEvent,
  type RawGammaEvent,
} from '../../packages/core/src/index.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596;
const HEADERS: Record<string, string> = { 'User-Agent': 'weather-edge/0.1 (flat-open-window)', Accept: 'application/json' };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hrs = (s: number): string => `${(s / 3600).toFixed(1)}h`;

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function leadDays(targetDate: string, now: Date): number {
  return (new Date(`${targetDate}T23:59:59Z`).getTime() - now.getTime()) / 86_400_000;
}

async function fetchEvents(query: string): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  for (let offset = 0; offset < 600; offset += 100) {
    const page = await getJson(`${GAMMA}/events?tag_id=${TAG}&${query}&limit=100&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page as RawGammaEvent[]) {
      try { out.push(parseGammaEvent(raw)); } catch { /* skip unparseable */ }
    }
    if (page.length < 100) break;
  }
  return out;
}

/** prices-history for one token → [{t: unix SECONDS, p}], or null. Normalizes ms→s defensively. */
async function priceSeries(token: string): Promise<{ t: number; p: number }[] | null> {
  try {
    const raw = parsePricesHistory(await getJson(`${CLOB}/prices-history?market=${token}&interval=max&fidelity=60`));
    return raw.map((h) => ({ t: h.t > 1e12 ? Math.round(h.t / 1000) : h.t, p: h.p }));
  } catch {
    return null;
  }
}

/** Build the cross-bucket PEAK-mid series for one event: at each shared timestamp, max price across buckets. */
function peakSeries(perBucket: ({ t: number; p: number }[] | null)[]): { t: number; peak: number }[] {
  const byT = new Map<number, number>();
  for (const series of perBucket) {
    if (!series) continue;
    for (const { t, p } of series) {
      byT.set(t, Math.max(byT.get(t) ?? 0, p));
    }
  }
  return [...byT.entries()].map(([t, peak]) => ({ t, peak })).sort((a, b) => a.t - b.t);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { n: { type: 'string' } } });
  const N = Math.max(1, Math.min(10, Number(values.n ?? 6) || 6));
  const now = new Date();
  process.stderr.write(`flat-open-window · ${now.toISOString()} · keyless · all-bucket /prices-history walk\n`);

  const closed = await fetchEvents('closed=true&order=endDate&ascending=false');
  const recent = closed
    .map((ev) => ({ ev, lead: leadDays(ev.targetDate, now) }))
    .filter((x) => x.lead >= -6 && x.lead <= 0.5)
    .filter((x) => x.ev.kind === 'highest' && x.ev.buckets.length >= 4)
    .sort((a, b) => b.lead - a.lead)
    .slice(0, N);
  process.stderr.write(`  ${closed.length} closed · ${recent.length} recent near-dated sampled\n\n`);

  console.log('=== FLAT-OPEN WINDOW — how long after listing does peak stay ≤18% (≤25%)? ===');
  console.log(`as of ${now.toISOString()} · threshold for entry rule = 18% (§9R-B)\n`);

  interface Row { city: string; date: string; lifeS: number; openPeak: number; win18S: number | null; win25S: number | null; pts: number }
  const rows: Row[] = [];

  for (const { ev } of recent) {
    const perBucket: ({ t: number; p: number }[] | null)[] = [];
    for (const b of ev.buckets) {
      perBucket.push(await priceSeries(b.tokenYes));
      await sleep(220);
    }
    const ps = peakSeries(perBucket);
    if (ps.length < 3) { console.log(`▸ ${ev.citySlug} ${ev.targetDate}: insufficient series (n=${ps.length})`); continue; }

    const t0 = ps[0]!.t;
    const tLast = ps[ps.length - 1]!.t;
    const lifeS = tLast - t0;
    const openPeak = ps[0]!.peak;
    // first crossing of each threshold (seconds after listing); null = never crossed within captured life
    const cross = (thr: number): number | null => {
      const hit = ps.find((x) => x.peak > thr);
      return hit ? hit.t - t0 : null;
    };
    const win18S = cross(0.18);
    const win25S = cross(0.25);
    rows.push({ city: ev.citySlug, date: ev.targetDate, lifeS, openPeak, win18S, win25S, pts: ps.length });

    const w18 = win18S == null ? 'never≤life' : win18S === 0 ? 'OPEN-ALREADY>18%' : hrs(win18S);
    const w25 = win25S == null ? 'never' : win25S === 0 ? '>25% at open' : hrs(win25S);
    console.log(
      `▸ ${ev.citySlug.padEnd(14)} ${ev.targetDate}  life ${hrs(lifeS).padStart(6)} · open-peak ${(openPeak * 100).toFixed(0)}%` +
        `  ·  peak>18% after ${w18}  ·  peak>25% after ${w25}  (n=${ps.length} hourly pts)`,
    );
  }

  // ===== READ — the cron-cadence verdict =====
  console.log('\n=== READ — capture cron cadence ===');
  const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : NaN; };
  const openAlready = rows.filter((r) => r.openPeak > 0.18).length;
  const win18 = rows.filter((r) => r.win18S != null && r.win18S > 0).map((r) => r.win18S!);
  if (rows.length) {
    console.log(`  markets sampled: ${rows.length}`);
    console.log(`  opened ALREADY >18% (no flat-open window in captured data): ${openAlready}/${rows.length}`);
    if (win18.length) {
      console.log(`  flat-open window (listing→peak>18%): median ${hrs(med(win18))} · min ${hrs(Math.min(...win18))} · max ${hrs(Math.max(...win18))}  (n=${win18.length})`);
      console.log(`  ⇒ to catch the open, the capture cron period must be ≤ the MIN window (${hrs(Math.min(...win18))}); first-seen tracking is mandatory since fidelity=60 (hourly) data under-resolves the true open.`);
    } else {
      console.log('  ⚠ NO market showed a sub-resolution flat-open window > 0 — either all opened >18% OR the hourly fidelity is too coarse to see the first-hours dip. The true 10–12% open David observed is finer than 60-min candles → capture must snapshot at first-listing detection, not rely on reconstructing it after.');
    }
    console.log('  NOTE: /prices-history fidelity=60 = HOURLY candles; the genuine flat open (per the Paris 6:10AM obs) may live inside the first candle. This bounds the window from ABOVE; treat it as "no slower than" guidance, and let the live capture layer measure the true sub-hour shape forward.');
  } else {
    console.log('  no rows reconstructed');
  }
}

main().catch((e) => {
  process.stderr.write(`FATAL ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
