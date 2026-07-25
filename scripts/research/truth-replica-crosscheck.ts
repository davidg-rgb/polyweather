/**
 * scripts/research/truth-replica-crosscheck — grade the METAR oracle replica against the STORED WU
 * truth, city by city (CITY-ORACLE-BUILDOUT Build 2).
 *
 * THE QUESTION. Our grading truth is `observations.tmax_wu_native` — WU's own server-rounded integer
 * (ADR-04: grading NEVER re-derives it; this script does not change that). The decoded resolution
 * oracle claims the WU table is a bit-for-bit METAR/SPECI re-render — so an IEM-archive replica max
 * (the SAME renderRow/buildStationDays code path the floor climatology uses — zero drift by
 * construction) should match the stored WU value ≈100% of the time. Where it doesn't, that gap is a
 * per-city RESOLUTION RISK number: how often the market's actual resolution source disagrees with a
 * faithful METAR replica (station identity quirks, revision timing, WU-side data holes — the
 * shenzhen/seoul hotspots from the deep-history validation).
 *
 *   resolution-risk = 1 − (90d replica-vs-WU match rate)
 *
 * INPUTS (both local, no network):
 *   out/wu-truth-90d.json      the stored truth pull — refresh via the SQL in the header below
 *   out/iem-asos-archive/      the METAR archive (scripts/research/iem-backfill.py)
 *
 * Refresh the truth file (Supabase, read-only):
 *   select icao, unit, json_agg(json_build_array(date_local, tmax_wu_native) order by date_local) as days
 *   from observations
 *   where date_local >= current_date - interval '95 days' and tmax_wu_native is not null and not provisional
 *   group by icao, unit order by icao;
 *   → wrap as {"_generated": "...", "stations": [...]} at out/wu-truth-90d.json
 *
 * OUTPUTS
 *   scripts/research/out/truth-replica-crosscheck.json    full result (gitignored, for analysis)
 *   --emit <path>   the committed compact asset packages/core/src/sim/resolution-risk.ts
 *   stdout          the per-city agreement table (paste-ready for docs/RESOLUTION-RISK.md)
 *
 * RUN:
 *   pnpm tsx scripts/research/truth-replica-crosscheck.ts --emit packages/core/src/sim/resolution-risk.ts
 */
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildStationDays, loadArchiveRows } from './city-floor-climatology.ts';
import { finalRenderedMax } from './city-floor-climatology-emit.ts';
import { CITY_BY_SLUG } from './city-catalog.ts';

export const SCRIPT = 'truth-replica-crosscheck';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUTH_PATH = join(HERE, 'out', 'wu-truth-90d.json');
const CITY_MAP_PATH = join(HERE, 'city-map.json');
const OUT_JSON = join(HERE, 'out', 'truth-replica-crosscheck.json');

interface TruthStation {
  icao: string;
  unit: 'C' | 'F';
  days: Array<[string, number]>; // [date_local, tmax_wu_native]
}

export interface CityAgreement {
  slug: string;
  icao: string;
  name: string;
  unit: 'C' | 'F';
  /** Truth days joined against a complete replica day. */
  n: number;
  matches: number;
  /** matches / n, 4 dp. */
  matchRate: number;
  /** 1 − matchRate — the headline per-city resolution-risk number. */
  resolutionRisk: number;
  /** Signed (replica − WU) mismatch histogram, keys '-2','-1','+1','+2','other'. */
  offBy: Record<string, number>;
  /** Mean signed replica − WU over MISMATCHED days (who reads higher: + = replica/IEM higher). */
  meanSignedDiff: number | null;
  /** Truth days with no complete replica day in the archive (thin METAR coverage). */
  missingReplicaDays: number;
  /** The mismatched days themselves, for the market-winner adjudication. */
  mismatches: Array<{ date: string; replica: number; wu: number }>;
  /** On mismatch days with a resolved market: who agreed with the actual winning bucket? */
  adjudication: {
    resolved: number;
    replicaOnly: number;
    wuOnly: number;
    both: number;
    neither: number;
  } | null;
}

export interface CrosscheckResult {
  window: [string, string];
  totalDays: number;
  totalMatches: number;
  cities: CityAgreement[];
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Compare one city's truth days against its replica day-max map. Pure. */
export function gradeCity(
  meta: { slug: string; icao: string; name: string; unit: 'C' | 'F' },
  truthDays: Array<[string, number]>,
  replicaMaxByDate: Map<string, number>,
): CityAgreement {
  let matches = 0;
  let missing = 0;
  const offBy: Record<string, number> = {};
  const signedDiffs: number[] = [];
  const mismatches: CityAgreement['mismatches'] = [];
  let n = 0;
  for (const [date, wuNative] of truthDays) {
    const replica = replicaMaxByDate.get(date);
    if (replica === undefined) {
      missing++;
      continue;
    }
    n++;
    if (replica === wuNative) {
      matches++;
    } else {
      const d = replica - wuNative;
      const key = d >= -2 && d <= 2 ? (d > 0 ? `+${d}` : `${d}`) : 'other';
      offBy[key] = (offBy[key] ?? 0) + 1;
      signedDiffs.push(d);
      mismatches.push({ date, replica, wu: wuNative });
    }
  }
  const matchRate = n > 0 ? r4(matches / n) : 0;
  return {
    ...meta,
    n,
    matches,
    matchRate,
    resolutionRisk: r4(1 - matchRate),
    offBy,
    meanSignedDiff: signedDiffs.length
      ? r4(signedDiffs.reduce((a, b) => a + b, 0) / signedDiffs.length)
      : null,
    missingReplicaDays: missing,
    mismatches,
    adjudication: null,
  };
}

// =====================================================================================
// MARKET-WINNER ADJUDICATION — on mismatch days, who agreed with the RESOLVED bucket?
// =====================================================================================

const MH_DIR = join(HERE, 'out', 'market-history');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** Resolution day from a market slug (the slug-day trap: targetDate = resolution day). */
export function slugDay(slug: string): string | null {
  const m = /on-([a-z]+)-(\d+)(?:-(\d{4}))?$/.exec(slug);
  if (!m || !m[3]) return null;
  const month = MONTHS.indexOf(m[1]!) + 1;
  if (month === 0) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** Native-unit bucket bounds — the UNSIGNED label regex (range dash ≠ minus, the summer-panel law). */
export function parseLabel(label: string): [number, number] {
  const nums = (label.match(/\d+/g) ?? []).map(Number);
  let lo = -Infinity;
  let hi = Infinity;
  if (/below|lower/.test(label)) hi = nums[0] ?? Infinity;
  else if (/higher|above/.test(label)) lo = nums[0] ?? -Infinity;
  else if (nums.length >= 2) [lo, hi] = [nums[0]!, nums[1]!];
  else if (nums.length === 1) lo = hi = nums[0]!;
  return [lo, hi];
}

/** date → resolved winner bucket bounds for one city, from the local market-history archive. */
export function loadWinnersByDay(city: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const dir = join(MH_DIR, city);
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const ev = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        slug?: string;
        buckets?: Array<{ label?: string; resolvedOutcome?: string }>;
      };
      const day = slugDay(ev.slug ?? '');
      if (!day) continue;
      const win = ev.buckets?.find((b) => b.resolvedOutcome === 'win')?.label;
      if (win) out.set(day, parseLabel(win));
    } catch {
      /* unreadable event file — skip */
    }
  }
  return out;
}

/** Fill c.adjudication from the resolved-winner map. Pure aside from its inputs. */
export function adjudicate(c: CityAgreement, winners: Map<string, [number, number]>): void {
  if (c.mismatches.length === 0) return;
  let resolved = 0;
  let replicaOnly = 0;
  let wuOnly = 0;
  let both = 0;
  let neither = 0;
  for (const m of c.mismatches) {
    const w = winners.get(m.date);
    if (!w) continue;
    resolved++;
    const rIn = w[0] <= m.replica && m.replica <= w[1];
    const wIn = w[0] <= m.wu && m.wu <= w[1];
    if (rIn && wIn) both++;
    else if (rIn) replicaOnly++;
    else if (wIn) wuOnly++;
    else neither++;
  }
  c.adjudication = { resolved, replicaOnly, wuOnly, both, neither };
}

const ASSET_HEADER = `/**
 * packages/core/sim/resolution-risk — AUTO-GENERATED. Do not edit by hand.
 *
 * Per-city RESOLUTION-RISK snapshot (CITY-ORACLE-BUILDOUT Build 2): how often the stored WU grading
 * truth (observations.tmax_wu_native — ADR-04: never re-derived in grading) disagrees with a faithful
 * METAR/SPECI replica of the resolution oracle (IEM archive, the validated §resolution-oracle
 * rendering), over the trailing ~90-day window. resolutionRisk = 1 − matchRate. A nonzero number means
 * the market's resolution source and the disseminated METAR stream can diverge for that city
 * (station identity quirks / WU revision timing) — an analytics trust signal, NOT a grading input.
 *
 * REGENERATE:
 *   pnpm tsx scripts/research/truth-replica-crosscheck.ts --emit packages/core/src/sim/resolution-risk.ts
 */
`;

const ASSET_INTERFACES = `export interface CityResolutionRisk {
  slug: string;
  icao: string;
  /** Truth days compared. */
  n: number;
  /** Share of days the METAR replica max equals the stored WU value (4 dp). */
  matchRate: number;
  /** 1 − matchRate — the headline per-city resolution-risk. */
  resolutionRisk: number;
  /** Mean signed replica − WU over mismatched days (+ = replica reads higher), null when no mismatch. */
  meanSignedDiff: number | null;
}

export interface ResolutionRiskAsset {
  source: string;
  /** [from, to] date_local window of the underlying truth pull. */
  window: [string, string];
  cities: CityResolutionRisk[];
}
`;

export function emitResolutionRiskAsset(res: CrosscheckResult, outPath: string): void {
  const cities = res.cities
    .map((c) => ({
      slug: c.slug,
      icao: c.icao,
      n: c.n,
      matchRate: c.matchRate,
      resolutionRisk: c.resolutionRisk,
      meanSignedDiff: c.meanSignedDiff,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const citiesJson = cities.map((c) => '    ' + JSON.stringify(c)).join(',\n');
  const body =
    `export const RESOLUTION_RISK: ResolutionRiskAsset = {\n` +
    `  source: 'wu-vs-iem-metar-90d',\n` +
    `  window: ${JSON.stringify(res.window)},\n` +
    `  cities: [\n${citiesJson},\n  ],\n` +
    `};\n` +
    `\nconst BY_SLUG = new Map(RESOLUTION_RISK.cities.map((c) => [c.slug, c]));\n` +
    `\n/** The city's resolution-risk row, or null when the slug is unknown. */\n` +
    `export function getResolutionRisk(slug: string): CityResolutionRisk | null {\n` +
    `  return BY_SLUG.get(slug) ?? null;\n` +
    `}\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${ASSET_HEADER}\n${ASSET_INTERFACES}\n${body}`);
}

// =====================================================================================
// SELF-TEST
// =====================================================================================

export function sanity(): void {
  const meta = { slug: 't', icao: 'TTTT', name: 'T', unit: 'C' as const };
  const truth: Array<[string, number]> = [
    ['2026-07-01', 30],
    ['2026-07-02', 31],
    ['2026-07-03', 28],
    ['2026-07-04', 25],
  ];
  const replica = new Map([
    ['2026-07-01', 30], // match
    ['2026-07-02', 32], // +1 (replica higher)
    ['2026-07-03', 27], // −1
    // 07-04 missing → missingReplicaDays
  ]);
  const g = gradeCity(meta, truth, replica);
  if (g.n !== 3 || g.matches !== 1) throw new Error(`sanity: gradeCity join n=${g.n} matches=${g.matches}`);
  if (g.offBy['+1'] !== 1 || g.offBy['-1'] !== 1) throw new Error('sanity: offBy histogram');
  if (g.missingReplicaDays !== 1) throw new Error('sanity: missing-replica count');
  if (Math.abs(g.matchRate - 0.3333) > 1e-9 || Math.abs(g.resolutionRisk - 0.6667) > 1e-9) {
    throw new Error('sanity: rates');
  }
  if (g.meanSignedDiff !== 0) throw new Error('sanity: meanSignedDiff should be 0 for +1/−1');
  if (g.mismatches.length !== 2) throw new Error('sanity: mismatch list');

  // adjudication: 07-02 winner 32-33 (replica 32 in, wu 31 out) · 07-03 winner 28-29 (wu 28 in, replica 27 out)
  const winners = new Map<string, [number, number]>([
    ['2026-07-02', [32, 33]],
    ['2026-07-03', [28, 29]],
  ]);
  adjudicate(g, winners);
  if (!g.adjudication || g.adjudication.resolved !== 2 || g.adjudication.replicaOnly !== 1 || g.adjudication.wuOnly !== 1) {
    throw new Error(`sanity: adjudication ${JSON.stringify(g.adjudication)}`);
  }

  // slug/label parsing: the slug-day trap + the unsigned-label law
  if (slugDay('highest-temperature-in-nyc-on-july-4-2026') !== '2026-07-04') throw new Error('sanity: slugDay');
  if (slugDay('no-date-slug') !== null) throw new Error('sanity: slugDay non-dated');
  const [lo1, hi1] = parseLabel('78-79°F');
  if (lo1 !== 78 || hi1 !== 79) throw new Error('sanity: parseLabel range');
  if (parseLabel('84°F or higher')[0] !== 84 || parseLabel('84°F or higher')[1] !== Infinity) throw new Error('sanity: parseLabel higher');
  if (parseLabel('59°F or below')[1] !== 59) throw new Error('sanity: parseLabel below');

  process.stderr.write('  sanity OK — gradeCity join/histogram/rates/adjudication verified\n');
}

// =====================================================================================
// CLI
// =====================================================================================
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  const { values } = parseArgs({ options: { emit: { type: 'string' } } });
  const log = (m: string): void => console.error(m);

  const truth = JSON.parse(readFileSync(TRUTH_PATH, 'utf8')) as { stations: TruthStation[] };
  const cityMap = (
    JSON.parse(readFileSync(CITY_MAP_PATH, 'utf8')) as {
      cities: Record<string, [string, string, 'C' | 'F', string, string | null]>;
    }
  ).cities;
  const slugByIcao = new Map(Object.entries(cityMap).map(([slug, [icao]]) => [icao, slug]));

  const cities: CityAgreement[] = [];
  let lo = '9999-99-99';
  let hi = '0000-00-00';
  for (const st of truth.stations) {
    const slug = slugByIcao.get(st.icao);
    if (!slug) {
      log(`  ! truth station ${st.icao} not in city-map — skipped`);
      continue;
    }
    const [, tz, unit] = cityMap[slug]!;
    if (unit !== st.unit) {
      log(`  ! ${slug} unit mismatch (map ${unit} vs obs ${st.unit}) — skipped`);
      continue;
    }
    const rows = loadArchiveRows(st.icao);
    if (rows.length === 0) {
      log(`  ! ${slug} (${st.icao}): no archive — skipped (run iem-backfill.py)`);
      continue;
    }
    const station = buildStationDays(rows, tz, unit);
    const replicaMaxByDate = new Map<string, number>();
    for (const d of station.days) if (d.date) replicaMaxByDate.set(d.date, finalRenderedMax(d));
    for (const [date] of st.days) {
      if (date < lo) lo = date;
      if (date > hi) hi = date;
    }
    cities.push(
      gradeCity({ slug, icao: st.icao, name: CITY_BY_SLUG.get(slug)?.name ?? slug, unit }, st.days, replicaMaxByDate),
    );
  }
  cities.sort((a, b) => b.resolutionRisk - a.resolutionRisk || a.slug.localeCompare(b.slug));

  // Adjudicate every mismatch day against the resolved market winner (local market-history archive):
  // on days the two sources disagree, WHICH ONE matched the bucket the market actually paid?
  for (const c of cities) adjudicate(c, loadWinnersByDay(c.slug));

  const res: CrosscheckResult = {
    window: [lo, hi],
    totalDays: cities.reduce((acc, c) => acc + c.n, 0),
    totalMatches: cities.reduce((acc, c) => acc + c.matches, 0),
    cities,
  };

  // stdout: the paste-ready doc table (worst agreement first).
  console.log(`\nWU truth vs METAR replica — per-city agreement, ${res.window[0]}..${res.window[1]}`);
  console.log(`overall: ${res.totalMatches}/${res.totalDays} = ${((res.totalMatches / res.totalDays) * 100).toFixed(2)}%\n`);
  console.log('| city | n | match | risk | offBy (replica−WU) | dir | winner says (n: replica/wu/both/neither) | missing |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const c of cities) {
    const off = Object.entries(c.offBy)
      .sort()
      .map(([k, v]) => `${k}:${v}`)
      .join(' ') || '—';
    const dir =
      c.meanSignedDiff === null ? '—' : c.meanSignedDiff > 0 ? 'IEM higher' : c.meanSignedDiff < 0 ? 'WU higher' : 'mixed';
    const adj = c.adjudication
      ? `${c.adjudication.resolved}: ${c.adjudication.replicaOnly}/${c.adjudication.wuOnly}/${c.adjudication.both}/${c.adjudication.neither}`
      : '—';
    console.log(
      `| ${c.slug} | ${c.n} | ${(c.matchRate * 100).toFixed(1)}% | ${(c.resolutionRisk * 100).toFixed(1)}% | ${off} | ${dir} | ${adj} | ${c.missingReplicaDays} |`,
    );
  }
  const agg = cities.reduce(
    (a, c) => {
      if (c.adjudication) {
        a.resolved += c.adjudication.resolved;
        a.replicaOnly += c.adjudication.replicaOnly;
        a.wuOnly += c.adjudication.wuOnly;
        a.both += c.adjudication.both;
        a.neither += c.adjudication.neither;
      }
      return a;
    },
    { resolved: 0, replicaOnly: 0, wuOnly: 0, both: 0, neither: 0 },
  );
  console.log(
    `\nADJUDICATION (all mismatch days with a resolved market, n=${agg.resolved}): ` +
      `replica-matches-winner ${agg.replicaOnly} · wu-matches-winner ${agg.wuOnly} · both ${agg.both} · neither ${agg.neither}`,
  );

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(res, null, 1));
  log(`\nwrote ${OUT_JSON}`);
  if (values.emit) {
    emitResolutionRiskAsset(res, values.emit);
    log(`emitted committed asset → ${values.emit}`);
  }
}
