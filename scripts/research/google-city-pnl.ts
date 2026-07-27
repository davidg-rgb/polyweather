/**
 * google-city-pnl.ts — per-city net P&L of the Google-picks-bucket paper strategy over the FULL record.
 *
 * The live panel (google_paper_panel) holds only the ~21d DB hot window (42 entries / 8 days as of 2026-07-27) —
 * far too thin for a per-city verdict. This CLI replays the SAME engine (replayGoogleBracket) under the SAME
 * frozen g2 config (band [0.10,0.15], TP 0.30, no SL, °C-only, maxEntryAge 24h, minHoursToResolution 20h,
 * dead-pick 0.02 + favorite-veto 0.85) over the union of:
 *   • the DB hot window (google_paper_inputs per city — complete recent series; OWNS recent events), plus
 *   • the on-disk opening-captures archives (DEFAULT_ARCHIVE_DIRS) for events the DB no longer holds.
 * Google's pick is resolved AS-OF entry eligibility for every event (latest source_forecasts google row captured
 * ≤ firstCapture + maxEntryAgeH) — one consistent no-look-ahead rule across both eras, instead of the panel's
 * "latest row at tick time".
 *
 * Output: per-city n / exit mix / realized + total net / win rate / day-clustered CI / first-vs-second-half
 * persistence split, ranked by realized net. Artifacts: out/google-city-pnl.json + out/google-city-pnl-ledger.csv.
 *
 * READ-ONLY by contract (script-db reads; writes only scripts/research/out/). Run:
 *   pnpm tsx scripts/research/google-city-pnl.ts
 */
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import type { RawResolution } from '../../packages/core/src/sim/opening-convergence-view.ts';
import { googleBucketIdx, replayGoogleBracket, GOOGLE_DEFAULTS } from '../../packages/core/src/sim/google-bucket-replay.ts';
import { BOT_DEFAULTS, parseBotConfig } from '../../packages/core/src/sim/opening-convergence.ts';
import type { Unit } from '../../packages/core/src/types.ts';
import { DEFAULT_ARCHIVE_DIRS, readArchiveRows, loadResolutions } from './opening-captures-archive-ingest.ts';

const PANEL_DAYS = 21;
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1).padStart(6) + '%' : '   n/a');
const usd = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(0) : 'n/a');

interface GoogleRow { eventId: string; tmaxC: number | null; unit: string | null; tz: string | null }
type GoogleInputs = { captures: RawCaptureRow[]; resolutions: RawResolution[]; google: GoogleRow[] };

interface Trade {
  city: string; targetDate: string; entryPrice: number; entryAgeH: number | null;
  exitReason: string; netPnlUsd: number; netReturn: number; stakeUsd: number; realized: boolean;
}

/** mean of per-day means ± 1.96·SE across days (the clustered-CI idiom; day = the independent unit here). */
function dayCi(trades: Trade[]): { mean: number; lo: number; hi: number; nDays: number } {
  const byDay = new Map<string, number[]>();
  for (const t of trades) {
    if (!byDay.has(t.targetDate)) byDay.set(t.targetDate, []);
    byDay.get(t.targetDate)!.push(t.netReturn);
  }
  const means = [...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const n = means.length;
  const mu = n ? means.reduce((a, b) => a + b, 0) / n : NaN;
  if (n < 2) return { mean: mu, lo: NaN, hi: NaN, nDays: n };
  const sd = Math.sqrt(means.reduce((a, m) => a + (m - mu) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { mean: mu, lo: mu - 1.96 * se, hi: mu + 1.96 * se, nDays: n };
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    // ── scope = the live capture universe ─────────────────────────────────────────────────────────
    let cities = BOT_DEFAULTS.cities as string[];
    try {
      const cfgRows = await db.query<{ key: string; value: string | null }>(`SELECT key, value::text AS value FROM config`);
      const parsed = parseBotConfig(cfgRows).cities;
      if (Array.isArray(parsed) && parsed.length) cities = parsed;
    } catch { /* fall back to defaults */ }

    // ── 1. DB hot window (complete recent series — OWNS its events) ───────────────────────────────
    const captures: RawCaptureRow[] = [];
    const resMap = new Map<string, Resolution>();
    process.stderr.write(`fetching google_paper_inputs for ${cities.length} cities (sequential)…\n`);
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i]!;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const rows = await db.query<{ r: GoogleInputs }>(`SELECT google_paper_inputs($1, $2) AS r`, [PANEL_DAYS, [city]]);
          const inp = rows[0]?.r ?? { captures: [], resolutions: [], google: [] };
          if (Array.isArray(inp.captures)) captures.push(...inp.captures);
          if (Array.isArray(inp.resolutions)) for (const r of inp.resolutions) resMap.set(String(r.id), { winnerIdx: r.winnerIdx ?? null, gradingMismatch: r.gradingMismatch === true });
          break;
        } catch (e) {
          if (attempt === 1) console.error(`  [warn] ${city}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if ((i + 1) % 10 === 0) process.stderr.write(`  …${i + 1}/${cities.length} cities\n`);
    }
    const dbEventIds = new Set(captures.map((r) => r.eventId).filter((x): x is string => x != null));
    process.stderr.write(`  DB window: ${captures.length} rows / ${dbEventIds.size} events\n`);

    // ── 2. archives (older events only; DB owns collisions, first dir owns the rest) ──────────────
    const owned = new Set<string>(dbEventIds);
    for (const dir of DEFAULT_ARCHIVE_DIRS) {
      try {
        const r = await readArchiveRows(dir, { onProgress: (m) => process.stderr.write(m + '\n') });
        const fresh = new Set<string>();
        let kept = 0;
        for (const row of r.rows) {
          const id = row.eventId;
          if (id == null || owned.has(id)) continue;
          fresh.add(id);
          captures.push(row);
          kept++;
        }
        for (const id of fresh) owned.add(id);
        process.stderr.write(`  ${dir}: +${fresh.size} events / ${kept} rows\n`);
      } catch (e) {
        console.error(`  [warn] archive ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // ── 3. resolutions for archive-only events ────────────────────────────────────────────────────
    const missing = [...owned].filter((id) => !resMap.has(id));
    process.stderr.write(`loading resolutions for ${missing.length} archive events…\n`);
    const archRes = await loadResolutions(db, missing);
    for (const [k, v] of archRes) resMap.set(k, v);

    // ── 4. city meta (icao + native unit) + the full google forecast series ───────────────────────
    const meta = await db.query<{ city: string; icao: string; unit: string | null }>(`
      SELECT c.slug AS city, cs.icao,
             (SELECT e.unit FROM market_events e WHERE e.city_id = c.id AND e.unit IS NOT NULL
               ORDER BY e.target_date DESC LIMIT 1) AS unit
        FROM cities c
        JOIN city_stations cs ON cs.city_id = c.id AND cs.valid_to IS NULL`);
    const metaByCity = new Map(meta.map((m) => [m.city, { icao: m.icao, unit: (m.unit === 'F' ? 'F' : 'C') as Unit }]));

    const dates = captures.map((r) => r.targetDate).filter((d): d is string => d != null).sort();
    const gRows = await db.query<{ icao: string; target_date: string; tmax_c: number; captured_at: string }>(`
      SELECT icao, target_date::text, tmax_c, captured_at::text
        FROM source_forecasts
       WHERE source = 'google' AND tmax_c IS NOT NULL AND target_date BETWEEN $1 AND $2
       ORDER BY icao, target_date, captured_at`, [dates[0]!, dates[dates.length - 1]!]);
    process.stderr.write(`google forecasts: ${gRows.length} rows (${dates[0]} … ${dates[dates.length - 1]})\n`);
    const gByKey = new Map<string, { tmaxC: number; at: number }[]>();
    for (const g of gRows) {
      const k = `${g.icao}|${g.target_date}`;
      if (!gByKey.has(k)) gByKey.set(k, []);
      gByKey.get(k)!.push({ tmaxC: Number(g.tmax_c), at: Date.parse(g.captured_at) });
    }

    // ── 5. build events + resolve each to its AS-OF Google pick ───────────────────────────────────
    const firstCapture = new Map<string, number>();
    const resolvesAtByEvent = new Map<string, string>();
    for (const r of captures) {
      if (r.eventId == null) continue;
      const t = Date.parse(r.capturedAt);
      const prev = firstCapture.get(r.eventId);
      if (prev == null || t < prev) firstCapture.set(r.eventId, t);
      if (r.resolvesAt != null && !resolvesAtByEvent.has(r.eventId)) resolvesAtByEvent.set(r.eventId, String(r.resolvesAt));
    }
    const events = buildEvents(captures, resMap);
    const cfg = { ...GOOGLE_DEFAULTS, cities: [] as string[] };
    let nFresh = 0, nGm = 0, nNoGoogle = 0, nF = 0, nNoBucket = 0;
    const trades: Trade[] = [];
    for (const e of events) {
      if (e.resolution.gradingMismatch) { nGm++; continue; }
      nFresh++;
      const m = metaByCity.get(e.city);
      if (!m) { nNoGoogle++; continue; }
      if (cfg.excludeFahrenheit && m.unit === 'F') { nF++; continue; }
      const cutoff = (firstCapture.get(e.eventId) ?? 0) + cfg.maxEntryAgeH * 3600_000;
      const series = gByKey.get(`${m.icao}|${e.targetDate}`) ?? [];
      let tmaxC: number | null = null;
      for (const g of series) if (g.at <= cutoff) tmaxC = g.tmaxC; // ascending → last ≤ cutoff wins
      if (tmaxC == null) { nNoGoogle++; continue; }
      const ladder = e.ticks.find((t) => Array.isArray(t.buckets) && t.buckets.length > 0)?.buckets ?? [];
      const predIdx = googleBucketIdx(ladder, tmaxC, m.unit);
      if (predIdx == null) { nNoBucket++; continue; }
      const t = replayGoogleBracket(e, predIdx, cfg, resolvesAtByEvent.get(e.eventId) ?? null);
      if (!t.executed || !Number.isFinite(t.netPnlUsd) || !Number.isFinite(t.netReturn)) continue;
      const realized = t.exitReason.startsWith('take_profit') || t.exitReason.startsWith('stop_loss') || t.exitReason.startsWith('resolution_settle');
      trades.push({ city: e.city, targetDate: e.targetDate, entryPrice: t.entryPrice, entryAgeH: t.entryAgeH,
        exitReason: t.exitReason, netPnlUsd: t.netPnlUsd, netReturn: t.netReturn, stakeUsd: t.stakeUsd, realized });
    }
    process.stderr.write(`fresh(gm-excl)=${nFresh}  gm=${nGm}  noGoogle=${nNoGoogle}  °F-skipped=${nF}  noBucket=${nNoBucket}  entered=${trades.length}\n\n`);

    // ── 6. per-city aggregation + half-split persistence ──────────────────────────────────────────
    const allDates = [...new Set(trades.map((t) => t.targetDate))].sort();
    const midDate = allDates[Math.floor(allDates.length / 2)] ?? '';
    const byCity = new Map<string, Trade[]>();
    for (const t of trades) {
      if (!byCity.has(t.city)) byCity.set(t.city, []);
      byCity.get(t.city)!.push(t);
    }
    const cityStats = [...byCity.entries()].map(([city, ts]) => {
      const real = ts.filter((t) => t.realized);
      const wins = real.filter((t) => t.netPnlUsd > 0);
      const mix = {
        tp: real.filter((t) => t.exitReason.startsWith('take_profit')).length,
        rw: real.filter((t) => t.exitReason === 'resolution_settle:win').length,
        rl: real.filter((t) => t.exitReason === 'resolution_settle:lose').length,
        open: ts.length - real.length,
      };
      const ci = dayCi(real);
      const halfA = real.filter((t) => t.targetDate < midDate).reduce((a, t) => a + t.netPnlUsd, 0);
      const halfB = real.filter((t) => t.targetDate >= midDate).reduce((a, t) => a + t.netPnlUsd, 0);
      return {
        city, n: ts.length, nRealized: real.length, mix,
        netRealizedUsd: real.reduce((a, t) => a + t.netPnlUsd, 0),
        netAllUsd: ts.reduce((a, t) => a + t.netPnlUsd, 0),
        winRate: real.length ? wins.length / real.length : NaN,
        meanNet: ci.mean, ciLow: ci.lo, ciHigh: ci.hi, nDays: ci.nDays,
        halfAUsd: halfA, halfBUsd: halfB,
        firstDate: ts.reduce((a, t) => (t.targetDate < a ? t.targetDate : a), ts[0]!.targetDate),
        lastDate: ts.reduce((a, t) => (t.targetDate > a ? t.targetDate : a), ts[0]!.targetDate),
      };
    }).sort((a, b) => b.netRealizedUsd - a.netRealizedUsd);

    const totReal = trades.filter((t) => t.realized);
    const totCi = dayCi(totReal);
    console.log(`GOOGLE PER-CITY P&L — g2 config replayed over the FULL record (${allDates[0]} … ${allDates[allDates.length - 1]}, half-split at ${midDate})`);
    console.log(`config: band [${cfg.askMin},${cfg.askMax}] · TP ${cfg.tpAbs} · SL off · °C-only · ≤${cfg.maxEntryAgeH}h age · ≥${cfg.minHoursToResolution}h to resolution · guards ${cfg.deadPickMinBid}/${cfg.favoriteVetoProb} · $${cfg.perPositionUsd}/position`);
    console.log(`TOTAL: entered ${trades.length} (${totReal.length} realized) · netRealized ${usd(totReal.reduce((a, t) => a + t.netPnlUsd, 0))} · netAll ${usd(trades.reduce((a, t) => a + t.netPnlUsd, 0))} · win ${pct(totReal.filter((t) => t.netPnlUsd > 0).length / Math.max(1, totReal.length))} · dayCI [${pct(totCi.lo)}, ${pct(totCi.hi)}] over ${totCi.nDays} days\n`);
    console.log('city'.padEnd(16) + 'n'.padStart(4) + 'real'.padStart(5) + 'tp/rw/rl/op'.padStart(13) + 'netReal'.padStart(9) + 'netAll'.padStart(8)
      + 'win'.padStart(8) + 'meanNet'.padStart(9) + 'dayCI'.padStart(19) + 'days'.padStart(5) + 'halfA'.padStart(7) + 'halfB'.padStart(7) + '  span');
    for (const s of cityStats) {
      console.log(
        s.city.padEnd(16) + String(s.n).padStart(4) + String(s.nRealized).padStart(5)
        + `${s.mix.tp}/${s.mix.rw}/${s.mix.rl}/${s.mix.open}`.padStart(13)
        + usd(s.netRealizedUsd).padStart(9) + usd(s.netAllUsd).padStart(8)
        + pct(s.winRate).padStart(8) + pct(s.meanNet).padStart(9)
        + `[${pct(s.ciLow)},${pct(s.ciHigh)}]`.padStart(19) + String(s.nDays).padStart(5)
        + usd(s.halfAUsd).padStart(7) + usd(s.halfBUsd).padStart(7)
        + `  ${s.firstDate}→${s.lastDate}`,
      );
    }
    const positive = cityStats.filter((s) => Number.isFinite(s.ciLow) && s.ciLow > 0);
    console.log(`\ncities with day-clustered ciLow > 0: ${positive.length ? positive.map((s) => s.city).join(', ') : 'NONE'}`
      + `  (expected false-positives at 5% across ${cityStats.length} cities ≈ ${(cityStats.length * 0.05).toFixed(1)})`);

    writeFileSync('scripts/research/out/google-city-pnl.json', JSON.stringify({
      generatedFrom: { dbEvents: dbEventIds.size, archiveDirs: DEFAULT_ARCHIVE_DIRS, span: [allDates[0], allDates[allDates.length - 1]], midDate },
      config: cfg, total: { entered: trades.length, realized: totReal.length, netRealizedUsd: totReal.reduce((a, t) => a + t.netPnlUsd, 0), dayCi: totCi },
      cities: cityStats,
    }, null, 1));
    const csv = ['city,target_date,entry_price,entry_age_h,exit_reason,net_pnl_usd,net_return,stake_usd,realized']
      .concat(trades.map((t) => [t.city, t.targetDate, t.entryPrice, t.entryAgeH ?? '', t.exitReason, t.netPnlUsd.toFixed(4), t.netReturn.toFixed(4), t.stakeUsd.toFixed(2), t.realized].join(',')));
    writeFileSync('scripts/research/out/google-city-pnl-ledger.csv', csv.join('\n'));
    process.stderr.write('\nwrote out/google-city-pnl.json + out/google-city-pnl-ledger.csv\n');
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
