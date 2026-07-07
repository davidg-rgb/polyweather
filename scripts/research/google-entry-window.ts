/**
 * google-entry-window.ts — does a SHORTER buy window improve the Google-convergence stats?
 *
 * Operator question (2026-07-08): "would the winning statistics be better with a shorter buy window — e.g. only
 * look at active bids for the first 48h of available trade?" This measures it over the SAME collected data the
 * live panel uses, under the LIVE config (°C-only, band [0.10,0.12], TP 0.30, no SL, wuRound bucketing — all read
 * from GOOGLE_DEFAULTS + the engine, so it tracks whatever is deployed).
 *
 * The strategy enters at the FIRST in-band tick; entryAgeH = hours since the market listed. A "max entry age"
 * gate SKIPS an event whose first cheap tick lands after the cap (a bucket that only got cheap late = the market
 * likely already moved against it). We report (a) win-rate / net P&L by entry-age BAND, and (b) a max-entry-age
 * GATE sweep {6,12,24,48,∞} with the §9R-E clustered CI — the direct answer to "does a shorter window help?".
 *
 * READ-ONLY (same DATABASE_URL path as google-convergence-sweep.ts). Run:
 *   pnpm tsx scripts/research/google-entry-window.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import type { RawResolution } from '../../packages/core/src/sim/opening-convergence-view.ts';
import { googleBucketIdx, replayGoogleBracket, GOOGLE_DEFAULTS } from '../../packages/core/src/sim/google-bucket-replay.ts';
import { openingVerdict, BOT_DEFAULTS, parseBotConfig, type OpeningMarketResult } from '../../packages/core/src/sim/opening-convergence.ts';
import type { Unit } from '../../packages/core/src/types.ts';

const PANEL_DAYS = 21;
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1).padStart(6) + '%' : '    n/a');
const usd = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(0).padStart(4) : ' n/a');

interface GoogleRow { eventId: string; tmaxC: number | null; unit: string | null; tz: string | null }
type GoogleInputs = { captures: RawCaptureRow[]; resolutions: RawResolution[]; google: GoogleRow[] };
interface Entry { city: string; targetDate: string; ageH: number; win: boolean; pnl: number; ret: number; exit: string }

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    let cities = BOT_DEFAULTS.cities as string[];
    try {
      const rows = await db.query<{ key: string; value: string | null }>(`SELECT key, value::text AS value FROM config`);
      const parsed = parseBotConfig(rows).cities;
      if (Array.isArray(parsed) && parsed.length) cities = parsed;
    } catch { /* fallback */ }

    const captures: RawCaptureRow[] = [];
    const resolutions: RawResolution[] = [];
    const google: GoogleRow[] = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= cities.length) return;
        const city = cities[i]!;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await db.query<{ r: GoogleInputs }>(`SELECT google_paper_inputs($1, $2) AS r`, [PANEL_DAYS, [city]]);
            const inp = r[0]?.r ?? { captures: [], resolutions: [], google: [] };
            if (Array.isArray(inp.captures)) captures.push(...inp.captures);
            if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
            if (Array.isArray(inp.google)) google.push(...inp.google);
            break;
          } catch (e) { if (attempt === 1) console.error(`  [warn] ${city}: ${e instanceof Error ? e.message : String(e)}`); }
        }
      }
    };
    process.stderr.write(`fetching ${cities.length} cities…\n`);
    await Promise.all([worker()]); // sequential — Micro DB self-contends

    const resMap = new Map<string, Resolution>(
      resolutions.map((r) => [String(r.id), { winnerIdx: r.winnerIdx ?? null, gradingMismatch: r.gradingMismatch === true }]),
    );
    const events = buildEvents(captures, resMap);
    const resolvesAtByEvent = new Map<string, string>();
    for (const r of captures) {
      if (r?.eventId == null || r.resolvesAt == null) continue;
      const k = String(r.eventId);
      if (!resolvesAtByEvent.has(k)) resolvesAtByEvent.set(k, String(r.resolvesAt));
    }
    const googleByEvent = new Map<string, { tmaxC: number | null; unit: Unit }>();
    for (const g of google) {
      if (!g || g.eventId == null) continue;
      googleByEvent.set(String(g.eventId), { tmaxC: g.tmaxC != null && Number.isFinite(Number(g.tmaxC)) ? Number(g.tmaxC) : null, unit: g.unit === 'F' ? 'F' : 'C' });
    }

    // replay over each event (°C-only per GOOGLE_DEFAULTS.excludeFahrenheit). maxEntryAgeH is DISABLED here (0)
    // on purpose: this script's whole job is to compare entry-age bands, so it must see entries at EVERY age —
    // the live default (24) would gate the >24h cohort out and hide exactly what we are measuring.
    const cfg = { ...GOOGLE_DEFAULTS, maxEntryAgeH: 0, cities: [] as string[] };
    const entries: Entry[] = [];
    for (const e of events) {
      if (e.resolution.gradingMismatch) continue;
      const g = googleByEvent.get(e.eventId);
      if (!g || g.tmaxC == null) continue;
      if (cfg.excludeFahrenheit && g.unit === 'F') continue; // °C-only, matching the live panel
      const ladder = e.ticks.find((t) => Array.isArray(t.buckets) && t.buckets.length > 0)?.buckets ?? [];
      const predIdx = googleBucketIdx(ladder, g.tmaxC, g.unit);
      if (predIdx == null) continue;
      const t = replayGoogleBracket(e, predIdx, cfg, resolvesAtByEvent.get(e.eventId) ?? null);
      if (!t.executed || !Number.isFinite(t.netPnlUsd) || !Number.isFinite(t.netReturn)) continue;
      if (t.exitReason.includes('mtm_')) continue; // realized only (gate basis)
      entries.push({
        city: e.city, targetDate: e.targetDate, ageH: t.entryAgeH ?? NaN,
        win: t.netPnlUsd > 0, pnl: t.netPnlUsd, ret: t.netReturn, exit: t.exitReason.split(':')[0]!,
      });
    }
    process.stderr.write(`realized °C entries: ${entries.length}\n\n`);

    console.log(`GOOGLE-CONVERGENCE entry-window analysis — LIVE config (°C-only, band [${cfg.askMin},${cfg.askMax}], TP ${cfg.tpAbs}, wuRound)`);
    console.log(`${entries.length} realized entries / ${PANEL_DAYS}d window. Q: does a SHORTER buy window improve the stats?\n`);

    // ── (a) win-rate / net by entry-age BAND ────────────────────────────────────────────────────────────────
    const bands: [string, number, number][] = [['0–2h', 0, 2], ['2–6h', 2, 6], ['6–12h', 6, 12], ['12–24h', 12, 24], ['24–48h', 24, 48], ['>48h', 48, Infinity]];
    console.log(`entry-age BAND       n   wins   win%    net$   meanRet   exit mix (tp/resWin/resLose)`);
    for (const [label, lo, hi] of bands) {
      const b = entries.filter((e) => e.ageH >= lo && e.ageH < hi);
      if (b.length === 0) { console.log(`  ${label.padEnd(10)}    0`); continue; }
      const wins = b.filter((e) => e.win).length;
      const net = b.reduce((a, e) => a + e.pnl, 0);
      const meanRet = b.reduce((a, e) => a + e.ret, 0) / b.length;
      const tp = b.filter((e) => e.exit === 'take_profit').length;
      const rw = b.filter((e) => e.exit === 'resolution_settle' && e.win).length;
      const rl = b.filter((e) => e.exit === 'resolution_settle' && !e.win).length;
      console.log(`  ${label.padEnd(10)}${String(b.length).padStart(5)}${String(wins).padStart(5)}   ${pct(wins / b.length)}  ${usd(net)}  ${pct(meanRet)}   ${tp}/${rw}/${rl}`);
    }

    // ── (b) MAX-ENTRY-AGE gate sweep — the direct "shorter window" test (§9R-E clustered CI) ─────────────────
    console.log(`\nMAX-ENTRY-AGE gate (keep entries with ageH ≤ cap):`);
    console.log(`  cap        n   win%     net$   meanRet     ciLow    ciHigh   gate`);
    for (const cap of [6, 12, 24, 48, Infinity]) {
      const kept = entries.filter((e) => e.ageH <= cap);
      const rows: OpeningMarketResult[] = kept.map((e) => ({ city: e.city, targetDate: e.targetDate, netPnlUsd: e.pnl, stakeUsd: 20, netReturn: e.ret, executed: true }));
      const v = openingVerdict(rows);
      const wins = kept.filter((e) => e.win).length;
      const net = kept.reduce((a, e) => a + e.pnl, 0);
      const capLabel = cap === Infinity ? '∞ (live)' : `≤${cap}h`;
      console.log(`  ${capLabel.padEnd(9)}${String(kept.length).padStart(4)}  ${pct(kept.length ? wins / kept.length : NaN)}  ${usd(net)}  ${pct(v.meanNetReturn)}  ${pct(v.ciLow)} ${pct(v.ciHigh)}   ${v.label}`);
    }

    const ages = entries.map((e) => e.ageH).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p: number) => ages.length ? ages[Math.min(ages.length - 1, Math.floor(p * ages.length))]! : NaN;
    console.log(`\nentry-age distribution (h): min ${q(0).toFixed(1)}  p50 ${q(0.5).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  max ${(ages[ages.length - 1] ?? NaN).toFixed(1)}`);
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
