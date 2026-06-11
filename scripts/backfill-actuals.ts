/**
 * scripts/backfill-actuals — WU/IEM historical daily maxes (§6.22).
 *
 * Per station per local date in range: wuObsUrl → wuDailyMax → observations
 * (finalized, provenance 'wu'); WU failure/empty/sparse days fall back to
 * iemDailyUrl (provenance 'iem_fallback', §7.7). °F cities pull units=e,
 * others units=m. METAR replica cross-fill only where the aviationweather
 * window still reaches (last ~3 days — it has no deep archive). Backfill
 * NEVER overwrites an already-finalized observation (live truth wins).
 *
 * Along the way, each WU day's running-max steps are logged to
 * intraday_advances (°C, station-local hour) for dates within the 180-day
 * lift horizon; the FINAL PASS then builds the initial nowcast_lift quantiles
 * (§7.8a) via the same rebuild_nowcast_lift RPC run-calibration uses weekly.
 *
 * Resumable via backfill_progress (scope = ICAO, cursor = last completed
 * date); budget-aware (each WU/IEM call counts 1 against --budget/day).
 *
 * Run: pnpm tsx scripts/backfill-actuals.ts [--from 2024-01-21] [--to YYYY-MM-DD]
 *        [--stations RKSI,EGLL,KORD] [--budget 8000]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  extractWuApiKey,
  fToC,
  iemDailyUrl,
  iemNetworkFor,
  isLocalDayOver,
  localHour,
  metarMaxToNative,
  metarRunningMax,
  parseIemDaily,
  parseMetarJson,
  parseWuObservations,
  wuDailyMax,
  wuObsUrl,
  wuRound,
  type Unit,
} from '../packages/core/src/index.ts';
import { fetchJson as ioFetchJson } from '../packages/io/src/index.ts';
import {
  addDaysISO,
  DayBudget,
  getProgress,
  listDatesISO,
  setProgress,
  splitList,
  todayUTC,
  type Db,
} from './lib/backfill.ts';
import { makeScriptDb } from './lib/script-db.ts';

export const SCRIPT = 'backfill-actuals';
const DEFAULT_FROM = '2024-01-21';
/** A WU day with fewer usable hourly obs than this is "sparse" → IEM fallback (§6.22). */
export const SPARSE_MIN_OBS = 6;
/** Advances feed nowcast_lift; rebuild_nowcast_lift prunes >180d, so older rows are wasted writes. */
const LIFT_HORIZON_DAYS = 180;
/** aviationweather.gov serves no deep archive — cross-fill only this close to now. */
const METAR_REACH_DAYS = 3;
const LIFT_MIN_DAYS = 10;

export interface BackfillActualsArgs {
  from?: string;
  to?: string;
  stations?: string[];
  budget?: number;
}

export interface BackfillActualsDeps {
  db: Db;
  fetchJson: (url: string) => Promise<unknown>;
  /** WU history page fetch for runtime key extraction (returns HTML). */
  fetchText: (url: string) => Promise<string>;
  log: (msg: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

interface TruthStation {
  icao: string;
  tz: string;
  unit: Unit;
  wu_cc: string;
  us_state: string | null;
}

export interface ActualsBackfillStats {
  stationsDone: number;
  datesProcessed: number;
  wuRows: number;
  iemRows: number;
  gaps: number;
  advancesWritten: number;
  metarCrossFilled: number;
  liftRowsBuilt: number;
}

const yyyymmdd = (iso: string) => iso.replaceAll('-', '');

async function ensureWuKey(db: Db, deps: BackfillActualsDeps, force = false): Promise<string> {
  if (!force) {
    const [row] = await db.query<{ value: string }>(`select value from config where key = 'wuApiKey'`);
    if (row?.value) return row.value;
  }
  const html = await deps.fetchText('https://www.wunderground.com/history/daily/kr/incheon/RKSI');
  const key = extractWuApiKey(html);
  if (!key) throw new Error('WU key extraction failed: no 32-hex apiKey in page source');
  await db.query(
    `insert into config (key, value) values ('wuApiKey', $1)
     on conflict (key) do update set value = excluded.value`,
    [key],
  );
  await db.query(
    `insert into config (key, value) values ('wuKeyFetchedAt', $1)
     on conflict (key) do update set value = excluded.value`,
    [deps.now().toISOString()],
  );
  return key;
}

/** Running-max steps over a WU day's hourly obs → (station-local hour, °C 1dp) advance rows. */
export function advancesFromObs(
  obs: { validTimeGmt: number; tempInt: number | null }[],
  tz: string,
  unit: Unit,
): { hour: number; maxTenthsC: number }[] {
  const sorted = [...obs].filter((o) => o.tempInt !== null).sort((a, b) => a.validTimeGmt - b.validTimeGmt);
  const out: { hour: number; maxTenthsC: number }[] = [];
  let runningMax = -Infinity;
  for (const o of sorted) {
    if (o.tempInt! <= runningMax) continue;
    runningMax = o.tempInt!;
    const c = unit === 'F' ? fToC(runningMax) : runningMax;
    const hour = localHour(tz, new Date(o.validTimeGmt * 1000));
    const tenths = Math.round(c * 10) / 10;
    const last = out[out.length - 1];
    if (last && last.hour === hour) last.maxTenthsC = tenths;
    else out.push({ hour, maxTenthsC: tenths });
  }
  return out;
}

async function upsertObservation(
  db: Db,
  p: {
    icao: string;
    date: string;
    tmax: number;
    unit: Unit;
    nObs: number | null;
    provenance: 'wu' | 'iem_fallback';
    metarTenths?: number | null;
    metarNative?: number | null;
  },
): Promise<void> {
  // Backfill only fills gaps / upgrades provisional rows — finalized truth wins.
  await db.query(
    `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provenance, provisional,
                               finalized_at, tmax_metar_tenths_c, tmax_metar_native)
     values ($1, $2, $3, $4, $5, $6, false, now(), $7, $8)
     on conflict (icao, date_local) do update
       set tmax_wu_native = excluded.tmax_wu_native, unit = excluded.unit, n_obs = excluded.n_obs,
           provenance = excluded.provenance, provisional = false, finalized_at = now(),
           tmax_metar_tenths_c = coalesce(excluded.tmax_metar_tenths_c, observations.tmax_metar_tenths_c),
           tmax_metar_native = coalesce(excluded.tmax_metar_native, observations.tmax_metar_native)
       where observations.finalized_at is null`,
    [p.icao, p.date, p.tmax, p.unit, p.nObs, p.provenance, p.metarTenths ?? null, p.metarNative ?? null],
  );
}

export async function backfillActuals(
  args: BackfillActualsArgs,
  deps: BackfillActualsDeps,
): Promise<ActualsBackfillStats> {
  const { db, log } = deps;
  const from = args.from ?? DEFAULT_FROM;
  // UTC today − 2 is over in EVERY timezone; isLocalDayOver still guards per date.
  const to = args.to ?? addDaysISO(todayUTC(deps.now()), -2);
  const budget = new DayBudget(db, SCRIPT, args.budget ?? 8000, deps);
  const liftFloor = addDaysISO(todayUTC(deps.now()), -LIFT_HORIZON_DAYS);
  const metarFloor = addDaysISO(todayUTC(deps.now()), -METAR_REACH_DAYS);

  let stations = await db.query<TruthStation>(
    `select distinct s.icao, s.tz, c.unit, cs.wu_country_code as wu_cc, s.us_state
     from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null
     join cities c on c.id = cs.city_id
     order by s.icao`,
  );
  if (args.stations) {
    const wanted = new Set(args.stations.map((s) => s.toUpperCase()));
    stations = stations.filter((s) => wanted.has(s.icao.toUpperCase()));
    const found = new Set(stations.map((s) => s.icao.toUpperCase()));
    for (const w of wanted) if (!found.has(w)) log(`WARNING: station ${w} has no current city mapping — skipped`);
  }

  const stats: ActualsBackfillStats = {
    stationsDone: 0, datesProcessed: 0, wuRows: 0, iemRows: 0, gaps: 0,
    advancesWritten: 0, metarCrossFilled: 0, liftRowsBuilt: 0,
  };
  log(`${SCRIPT}: ${stations.length} station(s), ${from} → ${to}`);

  let wuKey = await ensureWuKey(db, deps);

  for (const st of stations) {
    const scope = st.icao;
    const progress = await getProgress(db, SCRIPT, scope);
    const start = progress.cursor ? addDaysISO(progress.cursor, 1) : from;
    const units = st.unit === 'F' ? 'e' : 'm';

    for (const date of listDatesISO(start, to)) {
      if (!isLocalDayOver(st.tz, date, deps.now())) break; // station-local guard at the range edge
      let daily: { maxInt: number; nObs: number } | null = null;
      let obs: { validTimeGmt: number; tempInt: number | null }[] = [];

      try {
        await budget.spend(1);
        let json: unknown;
        try {
          json = await deps.fetchJson(wuObsUrl(st.icao, st.wu_cc, units, yyyymmdd(date), wuKey));
        } catch (e) {
          if (String(e).includes('401')) {
            wuKey = await ensureWuKey(db, deps, true); // rotated key self-heals
            json = await deps.fetchJson(wuObsUrl(st.icao, st.wu_cc, units, yyyymmdd(date), wuKey));
          } else {
            throw e;
          }
        }
        obs = parseWuObservations(json);
        daily = wuDailyMax(obs);
      } catch (e) {
        log(`WU ${st.icao} ${date} failed (${String(e).slice(0, 120)}) — trying IEM`);
      }

      // METAR replica cross-fill — only where aviationweather still reaches.
      let metarTenths: number | null = null;
      let metarNative: number | null = null;
      if (date >= metarFloor) {
        try {
          const metar = parseMetarJson(
            await deps.fetchJson(
              `https://aviationweather.gov/api/data/metar?ids=${st.icao}&format=json&hours=72`,
            ),
          );
          metarTenths = metarRunningMax(metar, st.tz, date);
          if (metarTenths !== null) {
            metarNative = metarMaxToNative(metarTenths, st.unit);
            stats.metarCrossFilled++;
          }
        } catch {
          // archive window genuinely unreachable — documented best-effort
        }
      }

      if (daily && daily.nObs >= SPARSE_MIN_OBS) {
        await upsertObservation(db, {
          icao: st.icao, date, tmax: daily.maxInt, unit: st.unit, nObs: daily.nObs,
          provenance: 'wu', metarTenths, metarNative,
        });
        stats.wuRows++;
      } else {
        // WU failed / empty / sparse → IEM second opinion as the fallback truth (§7.7)
        let iem: { maxTmpF: number } | null = null;
        try {
          if (st.wu_cc.toUpperCase() !== 'US' || st.us_state) {
            await budget.spend(1);
            const net = iemNetworkFor(st.wu_cc, st.icao, st.us_state ?? undefined);
            iem = parseIemDaily(await deps.fetchJson(iemDailyUrl(net.station, net.network, date)));
          }
        } catch (e) {
          log(`IEM ${st.icao} ${date} failed (${String(e).slice(0, 120)})`);
        }
        if (iem) {
          const native = st.unit === 'F' ? wuRound(iem.maxTmpF) : wuRound(fToC(iem.maxTmpF));
          await upsertObservation(db, {
            icao: st.icao, date, tmax: native, unit: st.unit, nObs: daily?.nObs ?? 0,
            provenance: 'iem_fallback', metarTenths, metarNative,
          });
          stats.iemRows++;
        } else {
          stats.gaps++;
        }
      }

      // Advance log → nowcast_lift (only within the 180d horizon the rebuild keeps).
      if (date >= liftFloor && obs.length > 0) {
        for (const a of advancesFromObs(obs, st.tz, st.unit)) {
          await db.query(
            `insert into intraday_advances (icao, date_local, local_hour, max_tenths_c)
             values ($1, $2, $3, $4)
             on conflict (icao, date_local, local_hour) do update
               set max_tenths_c = greatest(intraday_advances.max_tenths_c, excluded.max_tenths_c)`,
            [st.icao, date, a.hour, a.maxTenthsC],
          );
          stats.advancesWritten++;
        }
      }

      stats.datesProcessed++;
      await setProgress(db, SCRIPT, scope, date, 'running', 1);
    }
    await setProgress(db, SCRIPT, scope, to, 'done');
    stats.stationsDone++;
    log(`${st.icao} done through ${to}`);
  }

  // FINAL PASS (§6.22): initial nowcast_lift quantiles from the advances log —
  // the SAME RPC run-calibration uses weekly, so there is exactly one quantile path.
  const [lift] = await db.query<{ n: number }>(`select rebuild_nowcast_lift($1, $2) as n`, [
    LIFT_MIN_DAYS,
    todayUTC(deps.now()),
  ]);
  stats.liftRowsBuilt = Number(lift?.n ?? 0);

  log(
    `${SCRIPT} complete: ${stats.stationsDone} station(s), ${stats.datesProcessed} date(s) — ` +
      `wu ${stats.wuRows} · iem ${stats.iemRows} · gaps ${stats.gaps} · advances ${stats.advancesWritten} · ` +
      `lift rows ${stats.liftRowsBuilt}`,
  );
  return stats;
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      stations: { type: 'string' },
      budget: { type: 'string' },
    },
  });
  const db = makeScriptDb();
  try {
    const stats = await backfillActuals(
      {
        from: values.from,
        to: values.to,
        stations: splitList(values.stations),
        budget: values.budget ? Number(values.budget) : undefined,
      },
      {
        db,
        fetchJson: (url) => ioFetchJson(url),
        fetchText: async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
          return res.text();
        },
        log: console.log,
        now: () => new Date(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
    );
    if (stats.gaps > 0) console.log(`NOTE: ${stats.gaps} date(s) have no WU and no IEM value — recorded as gaps`);
  } finally {
    await db.end();
  }
}
