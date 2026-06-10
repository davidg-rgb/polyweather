/**
 * fetch-actuals — THE truth pipeline (ARCHITECTURE.md §6.15).
 * WU v1 hourly obs are the resolution source; METAR/IEM/ERA5 are cross-checks.
 */
import {
  archiveUrl,
  cToF,
  extractWuApiKey,
  iemDailyUrl,
  iemNetworkFor,
  isFinalized,
  isLocalDayOver,
  localDateAt,
  localDayWindow,
  metarMaxToNative,
  metarRunningMax,
  parseEra5Daily,
  parseIemDaily,
  parseMetarJson,
  parseWuObservations,
  wuDailyMax,
  wuObsUrl,
  type Unit,
} from '../../../packages/core/src/index.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface ActualsDeps {
  fetchJson: (url: string) => Promise<unknown>;
  /** WU history page fetch for runtime key extraction (returns HTML). */
  fetchText: (url: string) => Promise<string>;
  notify: (alert: Alert) => Promise<boolean>;
  gradeEvent: (eventId: string) => Promise<{ graded: boolean }>;
  now: Date;
  omArchiveBase: string;
  apiKey?: string;
}

interface TruthStation {
  icao: string;
  tz: string;
  unit: Unit;
  wu_cc: string;
  us_state: string | null;
  city_slug: string;
}

const WU_KEY_TTL_MS = 7 * 24 * 3_600_000;
const yyyymmdd = (iso: string) => iso.replaceAll('-', '');
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function ensureWuKey(ctx: JobCtx, deps: ActualsDeps, force = false): Promise<string | null> {
  const rows = await ctx.db.getConfigRows();
  const cached = rows.find((r) => r.key === 'wuApiKey')?.value;
  const fetchedAt = rows.find((r) => r.key === 'wuKeyFetchedAt')?.value;
  const fresh = fetchedAt && deps.now.getTime() - Date.parse(fetchedAt) < WU_KEY_TTL_MS;
  if (cached && fresh && !force) return cached;

  try {
    const html = await deps.fetchText('https://www.wunderground.com/history/daily/kr/incheon/RKSI');
    const key = extractWuApiKey(html);
    if (!key) throw new Error('no 32-hex apiKey in page source');
    await ctx.db.rpc('set_config_value', { p_key: 'wuApiKey', p_value: key });
    await ctx.db.rpc('set_config_value', { p_key: 'wuKeyFetchedAt', p_value: deps.now.toISOString() });
    return key;
  } catch (e) {
    await deps.notify({
      kind: 'WU_KEY',
      severity: 'CRITICAL',
      title: 'WU key refresh failed',
      body: `${String(e)} — relying on METAR provisional data until resolved`,
      dedupeKey: 'wu-key-refresh',
    });
    return cached ?? null; // stale key is better than none
  }
}

export async function fetchActuals(ctx: JobCtx, deps: ActualsDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const stats = { stationsChecked: 0, observationsUpserted: 0, finalized: 0, graded: 0, divergences: 0 };

  let wuKey = await ensureWuKey(ctx, deps);
  if (!wuKey) {
    log('no WU key available — skipping run');
    return { ...stats, skipped: 'no_wu_key' };
  }

  const stations = await db.rpc<TruthStation>('list_truth_stations', {});
  for (const st of stations) {
    const todayLocal = localDateAt(st.tz, deps.now);
    const candidates: string[] = [];
    for (let back = 0; back < 5; back++) {
      const date = addDays(todayLocal, -back);
      const { endUtc } = localDayWindow(st.tz, date);
      // first attempt ≥1h after local midnight (§6.15)
      if (isLocalDayOver(st.tz, date, deps.now) && deps.now.getTime() >= endUtc.getTime() + 3_600_000) {
        candidates.push(date);
      }
    }
    if (candidates.length === 0) continue;

    const finalized = new Set(
      (await db.rpc<{ date_local: string | Date }>('finalized_dates', {
        p_icao: st.icao,
        p_from: candidates[candidates.length - 1],
        p_to: candidates[0],
      })).map((r) =>
        typeof r.date_local === 'string' ? r.date_local.slice(0, 10) : new Date(r.date_local).toISOString().slice(0, 10),
      ),
    );
    const todo = candidates.filter((d) => !finalized.has(d));
    if (todo.length === 0) continue;
    stats.stationsChecked++;

    const units = st.unit === 'F' ? 'e' : 'm';
    for (const date of todo) {
      try {
        let json;
        try {
          json = await deps.fetchJson(wuObsUrl(st.icao, st.wu_cc, units, yyyymmdd(date), wuKey));
        } catch (e) {
          // 401 ⇒ key rotated: force-refresh once and retry
          if (String(e).includes('401')) {
            wuKey = (await ensureWuKey(ctx, deps, true)) ?? wuKey;
            json = await deps.fetchJson(wuObsUrl(st.icao, st.wu_cc, units, yyyymmdd(date), wuKey!));
          } else {
            throw e;
          }
        }
        const obs = parseWuObservations(json);
        const daily = wuDailyMax(obs);
        if (!daily) continue; // no usable obs yet — retry next hourly run
        await db.rpc('upsert_observation', {
          p_icao: st.icao,
          p_date: date,
          p_tmax: daily.maxInt,
          p_unit: st.unit,
          p_n_obs: daily.nObs,
        });
        stats.observationsUpserted++;

        // finalization probe: ≥1 obs exists for the FOLLOWING local day
        const nextJson = await deps.fetchJson(
          wuObsUrl(st.icao, st.wu_cc, units, yyyymmdd(addDays(date, 1)), wuKey!),
        );
        if (!isFinalized(parseWuObservations(nextJson))) continue;

        // divergence checks + sanity columns
        const flags: string[] = [];
        let metarTenths: number | null = null;
        let metarNative: number | null = null;
        let iemF: number | null = null;
        let era5C: number | null = null;
        try {
          const metar = parseMetarJson(
            await deps.fetchJson(
              `https://aviationweather.gov/api/data/metar?ids=${st.icao}&format=json&hours=72`,
            ),
          );
          metarTenths = metarRunningMax(metar, st.tz, date);
          if (metarTenths !== null) {
            metarNative = metarMaxToNative(metarTenths, st.unit);
            const diff = metarNative - daily.maxInt;
            if (Math.abs(diff) >= 1) {
              flags.push(`metar${diff > 0 ? '+' : ''}${diff}`);
            }
          }
        } catch (e) {
          log('metar cross-check unavailable', { icao: st.icao, error: String(e) });
        }
        try {
          if (st.wu_cc.toUpperCase() !== 'US' || st.us_state) {
            const net = iemNetworkFor(st.wu_cc, st.icao, st.us_state ?? undefined);
            const iem = parseIemDaily(await deps.fetchJson(iemDailyUrl(net.station, net.network, date)));
            if (iem) {
              iemF = iem.maxTmpF;
              const wuF = st.unit === 'F' ? daily.maxInt : cToF(daily.maxInt);
              const diffF = iemF - wuF;
              if (Math.abs(diffF) >= 2) flags.push(`iem${diffF > 0 ? '+' : ''}${Math.round(diffF)}`);
            }
          }
        } catch (e) {
          log('iem cross-check unavailable', { icao: st.icao, error: String(e) });
        }
        try {
          const era5 = parseEra5Daily(
            await deps.fetchJson(
              archiveUrl(deps.omArchiveBase, { lat: 0, lon: 0 }, { start: date, end: date }, deps.apiKey),
            ),
          );
          era5C = era5.find((r) => r.date === date)?.tmaxC ?? null;
        } catch (e) {
          log('era5 sanity unavailable', { icao: st.icao, error: String(e) });
        }

        await db.rpc('finalize_observation', {
          p_icao: st.icao,
          p_date: date,
          p_metar_tenths: metarTenths,
          p_metar_native: metarNative,
          p_iem_f: iemF,
          p_era5_c: era5C,
          p_divergence: flags,
        });
        stats.finalized++;
        if (flags.length > 0) {
          stats.divergences++;
          await deps.notify({
            kind: 'DATA_DIVERGENCE',
            severity: 'WARN',
            title: `Truth divergence at ${st.icao} ${date}`,
            body: `WU ${daily.maxInt}°${st.unit} vs ${flags.join(', ')}`,
            dedupeKey: `divergence:${st.icao}:${date}`,
          });
        }

        const events = await db.rpc<{ event_id: string }>('events_for_grading', {
          p_icao: st.icao,
          p_date: date,
        });
        for (const ev of events) {
          const res = await deps.gradeEvent(ev.event_id);
          if (res.graded) stats.graded++;
        }
      } catch (e) {
        log('station/date failed — next hourly run retries', { icao: st.icao, date, error: String(e) });
      }
    }
  }

  log('actuals complete', stats);
  return stats;
}
