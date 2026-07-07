/**
 * google-f-biascorrect.ts — should we correct Google's °F COLD BIAS systematically?
 *
 * Operator question (2026-07-08): the fahrenheit investigation found Google runs ~1 bucket too COLD for US °F
 * markets. "How often is Google°F + 1 the correct bucket?" — i.e. if we SHIFT Google's °F forecast UP by N°F
 * before bucketing, how often does the shifted bucket match the actual resolved winner, and does the shift make
 * the °F strategy tradable?
 *
 * For every scoreable °F event (unit='F', bucketable Google forecast, a known resolved winner) it computes, for
 * each shift N ∈ {0,+1,+2,+3,+4,+5}°F: the bucket wuRound(cToF(googleC) + N) lands in, whether it == the winner,
 * AND — the money question — replays the taker strategy on that shifted bucket (band [0.10,0.15], TP 0.30, no SL,
 * age gate off) for realized P&L. Answers both "how often correct" and "would correcting it be profitable".
 *
 * READ-ONLY (same DATABASE_URL path as the other google-* research). Run:
 *   pnpm tsx scripts/research/google-f-biascorrect.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { RawResolution } from '../../packages/core/src/sim/opening-convergence-view.ts';
import { replayGoogleBracket, GOOGLE_DEFAULTS, type GoogleBracketCfg } from '../../packages/core/src/sim/google-bucket-replay.ts';
import { parseBucketLabel, winningBucket } from '../../packages/core/src/buckets.ts';
import { cToF, wuRound } from '../../packages/core/src/units.ts';
import { BOT_DEFAULTS, parseBotConfig } from '../../packages/core/src/sim/opening-convergence.ts';
import type { OpeningBucket } from '../../packages/core/src/sim/opening-convergence.ts';

const PANEL_DAYS = 21;
const SHIFTS_F = [0, 1, 2, 3, 4, 5]; // °F added to Google's forecast before bucketing
// PINNED band [0.10,0.15], TP 0.30, no SL, AGE GATE OFF, °F allowed (excludeFahrenheit irrelevant — we pass predIdx).
const CFG: GoogleBracketCfg = { ...GOOGLE_DEFAULTS, askMax: 0.15, maxEntryAgeH: 0, cities: [] };

interface GoogleRow { eventId: string; tmaxC: number | null; unit: string | null; tz: string | null }
type GoogleInputs = { captures: RawCaptureRow[]; resolutions: RawResolution[]; google: GoogleRow[] };
const usd = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(0) : 'n/a');
const hit = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0).padStart(3)}% (${n}/${d})` : ' n/a');

/** the ladder bucket idx a whole-degree native value lands in (null if unbucketable) — mirrors googleBucketIdx. */
function bucketIdxAt(ordered: OpeningBucket[], defs: ReturnType<typeof parseBucketLabel>[], deg: number): number | null {
  try {
    return ordered[winningBucket(defs, deg)]!.idx;
  } catch {
    return null;
  }
}

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
    let nextCity = 0;
    const worker = async () => {
      for (;;) {
        const i = nextCity++;
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
    await Promise.all([worker()]); // sequential — Micro DB

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
    const googleByEvent = new Map<string, { tmaxC: number | null; unit: string }>();
    for (const g of google) {
      if (!g || g.eventId == null) continue;
      googleByEvent.set(String(g.eventId), { tmaxC: g.tmaxC != null && Number.isFinite(Number(g.tmaxC)) ? Number(g.tmaxC) : null, unit: g.unit === 'F' ? 'F' : 'C' });
    }

    // per-shift accumulators: bucket-accuracy (all scoreable °F events) + realized strategy P&L (entered ones).
    const acc = SHIFTS_F.map((n) => ({ n, scored: 0, hits: 0, offSum: 0, rN: 0, rWins: 0, rNet: 0 }));
    let nFEvents = 0;

    for (const e of events) {
      if (e.resolution.gradingMismatch || e.resolution.winnerIdx == null) continue; // need a known winner to score
      const g = googleByEvent.get(e.eventId);
      if (!g || g.tmaxC == null || g.unit !== 'F') continue; // °F only
      const ladder = e.ticks.find((t) => Array.isArray(t.buckets) && t.buckets.length > 0)?.buckets ?? [];
      const ordered = [...ladder].filter((b) => b && Number.isFinite(b.idx)).sort((a, b) => a.idx - b.idx);
      if (ordered.length === 0) continue;
      let defs;
      try { defs = ordered.map((b) => parseBucketLabel(String(b.label ?? ''))); } catch { continue; }
      const googleF = cToF(g.tmaxC);
      const winnerIdx = e.resolution.winnerIdx;
      const resolvesAt = resolvesAtByEvent.get(e.eventId) ?? null;
      nFEvents++;

      for (let s = 0; s < SHIFTS_F.length; s++) {
        const pickIdx = bucketIdxAt(ordered, defs, wuRound(googleF + SHIFTS_F[s]!));
        if (pickIdx == null) continue;
        const a = acc[s]!;
        a.scored++;
        // signed bucket offset (winner position − pick position), >0 ⇒ pick still too cold
        const wpos = ordered.findIndex((b) => b.idx === winnerIdx);
        const ppos = ordered.findIndex((b) => b.idx === pickIdx);
        if (wpos >= 0 && ppos >= 0) a.offSum += wpos - ppos;
        if (pickIdx === winnerIdx) a.hits++;
        // MONEY: replay the taker strategy on the shifted bucket.
        const t = replayGoogleBracket(e, pickIdx, CFG, resolvesAt);
        if (t.executed && Number.isFinite(t.netPnlUsd) && !t.exitReason.includes('mtm_')) {
          a.rN++;
          if (t.netPnlUsd > 0) a.rWins++;
          a.rNet += t.netPnlUsd;
        }
      }
    }

    console.log(`GOOGLE °F COLD-BIAS correction test — ${nFEvents} scoreable °F events / ${PANEL_DAYS}d window`);
    console.log(`Q: how often is wuRound(Google°F + N) the correct (winner) bucket, and is the corrected strategy profitable?\n`);
    console.log(`shift    bucket hit-rate     mean bucket offset   realized: n / wins / net$`);
    for (const a of acc) {
      const meanOff = a.scored > 0 ? (a.offSum / a.scored).toFixed(2) : 'n/a';
      const label = a.n === 0 ? 'Google°F  (+0)' : `Google°F +${a.n}°F`;
      console.log(`  ${label.padEnd(16)} ${hit(a.hits, a.scored).padStart(12)}      ${String(meanOff).padStart(6)} buckets      ${String(a.rN).padStart(2)} / ${a.rWins} / ${usd(a.rNet)}`);
    }
    const base = acc[0]!, plus1 = acc.find((a) => a.n === 1)!;
    const best = [...acc].sort((x, y) => (y.hits / Math.max(1, y.scored)) - (x.hits / Math.max(1, x.scored)))[0]!;
    console.log(`\n=== answer ===`);
    console.log(`  Google°F as-is (+0):  ${hit(base.hits, base.scored)} correct.`);
    console.log(`  Google°F +1°F:        ${hit(plus1.hits, plus1.scored)} correct  (Δ ${((plus1.hits / Math.max(1, plus1.scored) - base.hits / Math.max(1, base.scored)) * 100).toFixed(0)}pp vs as-is).`);
    console.log(`  Best shift = +${best.n}°F at ${hit(best.hits, best.scored)}; realized net ${usd(best.rNet)} on ${best.rN} entries.`);
    console.log(`  NB: °F buckets are 2°F wide, so +1°F is a HALF-bucket nudge (only flips a bucket near a boundary). n is tiny — directional only.`);
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
