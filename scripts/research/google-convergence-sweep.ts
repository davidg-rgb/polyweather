/**
 * google-convergence-sweep.ts — the HONEST buy/sell re-tune for the Google-picks-bucket panel (/convergence).
 *
 * The live panel (google-paper-panel edge fn) headlines a SINGLE frozen exit (tpAbs 0.30, no SL, band [0.10,0.15])
 * and can only sweep FIVE take-profit levels ≥ 0.30 — because buildGoogleView HARDWIRES the canonical/gate sections
 * to the tpAbs-0.30 / slAbs-0 variant. Its own tpComparison shows higher TP is strictly worse (0.30 best of five),
 * which means the optimum is BELOW 0.30 — a region the panel physically cannot render.
 *
 * This CLI replays the SAME collected data (the exact google_paper_inputs the edge fn pulls: real opening_captures
 * book + venue resolutions + latest per-event Google forecast) through replayGoogleBracket directly, across the
 * buy/sell levers the panel can't reach:
 *   • SELL EARLIER  — take-profit tpAbs ∈ {0.20 … 0.30}
 *   • CUT LOSERS    — stop-loss slAbs ∈ {off, 0.05}  (the held-to-resolution losers all decay to $0 = −1.04 each)
 *   • BUY-SIDE PICK — all cities vs °C-only (US °F markets use ~1.1°C-wide buckets Google's ±1–2°C error rarely hits)
 *   • ENTRY BAND    — askMax ceiling ∈ {0.12, 0.15, 0.18}
 * and scores each config with the SAME §9R-E clustered-CI gate (openingVerdict) the panel uses.
 *
 * READ-ONLY (identical DATABASE_URL path as maker-exit-realbook-sweep.ts / gate-read.ts). No writes, no capital, no
 * live config change — pure analytics on a DORMANT signal (FINDINGS.md). Run:
 *   pnpm tsx scripts/research/google-convergence-sweep.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import type { RawResolution } from '../../packages/core/src/sim/opening-convergence-view.ts';
import { googleBucketIdx, replayGoogleBracket, GOOGLE_DEFAULTS } from '../../packages/core/src/sim/google-bucket-replay.ts';
import { openingVerdict, BOT_DEFAULTS, parseBotConfig, type OpeningMarketResult } from '../../packages/core/src/sim/opening-convergence.ts';
import type { Unit } from '../../packages/core/src/types.ts';

const PANEL_DAYS = 21; // the gate window — matches the edge fn (record settles within ~2d, so 21d covers every one)
const FETCH_CONCURRENCY = 1; // SEQUENTIAL — the Micro DB self-contends under concurrency (the maker-exit incident)
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1).padStart(6) + '%' : '    n/a');
const usd = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(0).padStart(4) : ' n/a');

/** one per-event Google forecast row (mirror of RawGooglePrediction — the google_paper_inputs `google` array). */
interface GoogleRow { eventId: string; tmaxC: number | null; unit: string | null; tz: string | null }
type GoogleInputs = { captures: RawCaptureRow[]; resolutions: RawResolution[]; google: GoogleRow[] };

/** an event pre-resolved to its Google-predicted bucket + native unit + resolvesAt — replayed under each config. */
interface PreEvent { e: EventReplayInput; predIdx: number; unit: Unit; resolvesAt: string | null }

interface Cell {
  label: string;
  tp: number;
  sl: number;
  askMin: number;
  askMax: number;
  minHours: number;
  unit: 'all' | 'C';
}

interface Metrics {
  nEntered: number;
  nTp: number;
  nSl: number;
  nResWin: number;
  nResLose: number;
  nOpen: number;
  netAll: number; // Σ over all entries incl. open marks
  netRealized: number; // Σ over realized (non-mtm) only — the gate basis
  winRate: number; // realized wins / realized
  winFrac: number; // from the verdict (its own realized set)
  meanNet: number;
  ciLow: number;
  ciHigh: number;
  nCities: number;
  nDays: number;
  label: string;
}

function runConfig(events: PreEvent[], c: Cell): Metrics {
  const cfg = {
    ...GOOGLE_DEFAULTS,
    cities: [] as string[],
    askMin: c.askMin,
    askMax: c.askMax,
    tpAbs: c.tp,
    slAbs: c.sl,
    minHoursToResolution: c.minHours,
  };
  let nTp = 0, nSl = 0, nResWin = 0, nResLose = 0, nOpen = 0, netAll = 0, netRealized = 0, realizedWins = 0;
  const realizedRows: OpeningMarketResult[] = [];
  for (const pe of events) {
    if (c.unit === 'C' && pe.unit === 'F') continue; // buy-side selection: drop the narrow °F (US) buckets
    const t = replayGoogleBracket(pe.e, pe.predIdx, cfg, pe.resolvesAt);
    if (!t.executed || !Number.isFinite(t.netPnlUsd) || !Number.isFinite(t.netReturn)) continue; // never entered
    netAll += t.netPnlUsd;
    const r = t.exitReason;
    if (r.startsWith('take_profit')) nTp++;
    else if (r.startsWith('stop_loss')) nSl++;
    else if (r === 'resolution_settle:win') nResWin++;
    else if (r === 'resolution_settle:lose') nResLose++;
    else { nOpen++; continue; } // mtm_* — entered but NOT scored by the gate (closed net profit only)
    netRealized += t.netPnlUsd;
    if (t.netPnlUsd > 0) realizedWins++;
    realizedRows.push({ city: pe.e.city, targetDate: pe.e.targetDate, netPnlUsd: t.netPnlUsd, stakeUsd: t.stakeUsd, netReturn: t.netReturn, executed: true });
  }
  const v = openingVerdict(realizedRows);
  const nRealized = realizedRows.length;
  const nEntered = nRealized + nOpen;
  return {
    nEntered, nTp, nSl, nResWin, nResLose, nOpen, netAll, netRealized,
    winRate: nRealized > 0 ? realizedWins / nRealized : NaN,
    winFrac: v.winFrac, meanNet: v.meanNetReturn, ciLow: v.ciLow, ciHigh: v.ciHigh,
    nCities: v.nCities, nDays: v.nDistinctDays, label: v.label,
  };
}

function row(c: Cell, m: Metrics): string {
  const exitMix = `${m.nTp}tp/${m.nSl}sl/${m.nResWin}rw/${m.nResLose}rl/${m.nOpen}o`;
  return (
    c.label.padEnd(30) +
    String(m.nEntered).padStart(5) +
    usd(m.netRealized).padStart(8) +
    pct(m.meanNet).padStart(9) +
    pct(m.winRate).padStart(8) +
    pct(m.ciLow).padStart(9) +
    pct(m.ciHigh).padStart(9) +
    exitMix.padStart(20) +
    '  ' + m.label
  );
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    // scope = the live bot.cities capture universe (the edge fn's parseBotConfig path); fall back to BOT_DEFAULTS.
    let cities = BOT_DEFAULTS.cities as string[];
    try {
      const cfgRows = await db.query<{ key: string; value: string | null }>(`SELECT key, value::text AS value FROM config`);
      const parsed = parseBotConfig(cfgRows).cities;
      if (Array.isArray(parsed) && parsed.length) cities = parsed;
    } catch (e) { console.error(`  [warn] config read failed, using BOT_DEFAULTS.cities: ${e instanceof Error ? e.message : String(e)}`); }
    process.stderr.write(`scope: ${cities.length} cities\n`);

    // pull the SAME inputs the google-paper-panel edge fn pulls, per city (bounded, sequential).
    const captures: RawCaptureRow[] = [];
    const resolutions: RawResolution[] = [];
    const google: GoogleRow[] = [];
    let cityErrors = 0, next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= cities.length) return;
        const city = cities[i]!;
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            const t0 = Date.now();
            const rows = await db.query<{ r: GoogleInputs }>(`SELECT google_paper_inputs($1, $2) AS r`, [PANEL_DAYS, [city]]);
            const inp = rows[0]?.r ?? { captures: [], resolutions: [], google: [] };
            if (Array.isArray(inp.captures)) captures.push(...inp.captures);
            if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
            if (Array.isArray(inp.google)) google.push(...inp.google);
            process.stderr.write(`  [${i + 1}/${cities.length}] ${city}: ${Array.isArray(inp.captures) ? inp.captures.length : 0} rows (${Date.now() - t0}ms)\n`);
            ok = true;
          } catch (e) {
            if (attempt === 1) { cityErrors++; console.error(`  [warn] ${city}: ${e instanceof Error ? e.message : String(e)}`); }
          }
        }
      }
    };
    process.stderr.write(`fetching google_paper_inputs for ${cities.length} cities (${FETCH_CONCURRENCY}-way)…\n`);
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));
    process.stderr.write(`  captureRows=${captures.length}  resolutions=${resolutions.length}  google=${google.length}  cityErrors=${cityErrors}\n\n`);

    // build events (mirror buildGoogleView's ingest exactly) + pre-resolve each to its Google bucket / unit / resolvesAt.
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
      const unit: Unit = g.unit === 'F' ? 'F' : 'C';
      const tmaxC = g.tmaxC != null && Number.isFinite(Number(g.tmaxC)) ? Number(g.tmaxC) : null;
      googleByEvent.set(String(g.eventId), { tmaxC, unit });
    }
    const pre: PreEvent[] = [];
    let nFresh = 0, nGoogle = 0, nF = 0, nC = 0;
    for (const e of events) {
      if (e.resolution.gradingMismatch) continue; // gm markets are excluded from scoring (same as the panel)
      nFresh++;
      const g = googleByEvent.get(e.eventId);
      if (!g || g.tmaxC == null) continue;
      const ladder = e.ticks.find((t) => Array.isArray(t.buckets) && t.buckets.length > 0)?.buckets ?? [];
      const predIdx = googleBucketIdx(ladder, g.tmaxC, g.unit);
      if (predIdx == null) continue;
      nGoogle++;
      if (g.unit === 'F') nF++; else nC++;
      pre.push({ e, predIdx, unit: g.unit, resolvesAt: resolvesAtByEvent.get(e.eventId) ?? null });
    }
    process.stderr.write(`fresh(gm-excl)=${nFresh}  google-bucketable=${nGoogle}  (°C events=${nC}, °F/US events=${nF})\n\n`);

    // ── the config grid ────────────────────────────────────────────────────────────────────────────────────
    // Anchor = the live frozen config (tp0.30 / sl off / band [0.10,0.15] / win20 / all cities), then sweep the
    // levers the panel can't. Keep askMin 0.10 and minHours 20 fixed (operator-set) except the entry-band block.
    const B = { askMin: GOOGLE_DEFAULTS.askMin, askMax: 0.15, minHours: GOOGLE_DEFAULTS.minHoursToResolution };
    const cells: Cell[] = [];
    // Block 1 — SELL EARLIER: tp {0.20..0.30}, no SL, all cities.
    for (const tp of [0.2, 0.22, 0.25, 0.28, 0.3]) cells.push({ label: `tp${tp}  slOff  all`, tp, sl: 0, ...B, unit: 'all' });
    // Block 2 — SELL EARLIER × BUY-SIDE PICK: same tp ladder, °C-only.
    for (const tp of [0.2, 0.22, 0.25, 0.28, 0.3]) cells.push({ label: `tp${tp}  slOff  °C-only`, tp, sl: 0, ...B, unit: 'C' });
    // Block 3 — CUT LOSERS: add a stop-loss at the strong tp region (0.25), all + °C-only.
    for (const sl of [0.05, 0.07]) cells.push({ label: `tp0.25 sl${sl} all`, tp: 0.25, sl, ...B, unit: 'all' });
    for (const sl of [0.05, 0.07]) cells.push({ label: `tp0.25 sl${sl} °C-only`, tp: 0.25, sl, ...B, unit: 'C' });
    // Block 4 — ENTRY BAND ceiling at tp0.25/slOff, all + °C-only.
    for (const askMax of [0.12, 0.18]) cells.push({ label: `tp0.25 band≤${askMax} all`, tp: 0.25, sl: 0, askMin: B.askMin, askMax, minHours: B.minHours, unit: 'all' });
    for (const askMax of [0.12, 0.18]) cells.push({ label: `tp0.25 band≤${askMax} °C-only`, tp: 0.25, sl: 0, askMin: B.askMin, askMax, minHours: B.minHours, unit: 'C' });

    console.log(`GOOGLE-CONVERGENCE buy/sell sweep — ${cities.length} cities / ${PANEL_DAYS}d window (the live panel's own data)`);
    console.log(`baseline = live frozen config: tp0.30 / no SL / band [0.10,0.15] / 20h window / all cities.`);
    console.log(`(netReal = Σ realized P&L $, meanNet + CI = city-clustered §9R-E gate; exitMix = tp/sl/resWin/resLose/open)\n`);
    console.log(
      'config'.padEnd(30) + 'n'.padStart(5) + 'netReal'.padStart(8) + 'meanNet'.padStart(9) +
      'win'.padStart(8) + 'ciLow'.padStart(9) + 'ciHigh'.padStart(9) + 'exitMix'.padStart(20) + '  gate',
    );
    // baseline row first (the exact live config).
    const baseline: Cell = { label: 'BASELINE tp0.30 slOff all', tp: 0.3, sl: 0, ...B, unit: 'all' };
    const results: { c: Cell; m: Metrics }[] = [{ c: baseline, m: runConfig(pre, baseline) }];
    console.log(row(baseline, results[0]!.m));
    console.log('  ' + '─'.repeat(96));
    for (const c of cells) {
      const m = runConfig(pre, c);
      results.push({ c, m });
      console.log(row(c, m));
    }

    // ── verdict: rank by realized net P&L (the honest headline on this thin sample), flag any ciLow>0 ─────────
    const base = results[0]!.m;
    const ranked = [...results].sort((a, b) => b.m.netRealized - a.m.netRealized);
    const best = ranked[0]!;
    const positive = results.filter((r) => r.m.ciLow > 0 && Number.isFinite(r.m.ciLow));
    console.log(`\n=== verdict ===`);
    console.log(`  baseline (live): netReal ${usd(base.netRealized)}, meanNet ${pct(base.meanNet)}, win ${pct(base.winRate)}, gate ${base.label}`);
    console.log(`  best netReal:    "${best.c.label.trim()}" → netReal ${usd(best.m.netRealized)}, meanNet ${pct(best.m.meanNet)}, win ${pct(best.m.winRate)}, CI [${pct(best.m.ciLow)}, ${pct(best.m.ciHigh)}], gate ${best.m.label}`);
    console.log(`  Δ vs baseline:   ${usd(best.m.netRealized - base.netRealized)} realized`);
    if (positive.length) {
      console.log(`  ${positive.length} config(s) with ciLow>0 (a genuine lever on THIS sample — needs OOS re-validation, n is tiny):`);
      for (const p of positive.sort((a, b) => b.m.ciLow - a.m.ciLow)) console.log(`    ${p.c.label.trim()}: meanNet ${pct(p.m.meanNet)}, ciLow ${pct(p.m.ciLow)}, n=${p.m.nEntered}`);
    } else {
      console.log(`  NO config clears the §9R-E gate (ciLow>0) — every one still overlaps zero on this ${base.nDays}-day sample.`);
      console.log(`  → the buy/sell tweaks move the POINT estimate; none is statistically separable from noise yet (sample too small).`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
