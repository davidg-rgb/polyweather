import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenMeteoShapeError, ValidationError, WuShapeError } from '../src/errors.ts';
import { iemDailyUrl, iemNetworkFor, parseIemDaily } from '../src/weather/iem.ts';
import { metarRunningMax, parseMetarJson } from '../src/weather/metar.ts';
import {
  archiveUrl,
  ensembleUrl,
  forecastUrl,
  historicalForecastUrl,
  parseEnsembleDaily,
  parseEra5Daily,
  parseMultiModelDaily,
  parsePreviousRunsHourly,
  previousRunsUrl,
  requestWeight,
} from '../src/weather/openmeteo.ts';
import { extractWuApiKey, isFinalized, parseWuObservations, wuDailyMax, wuObsUrl } from '../src/weather/wu.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', '..', 'research');
const fixture = (f: string): unknown => JSON.parse(readFileSync(join(RESEARCH, f), 'utf8'));

const RKSI = { lat: 37.4602, lon: 126.4407 };
const ALL_MODELS = [
  'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless', 'gem_seamless',
  'meteofrance_seamless', 'ukmo_seamless', 'cma_grapes_global', 'best_match',
];

describe('Open-Meteo URL builders (§6.10)', () => {
  it('forecastUrl — exact research-verified param string', () => {
    expect(forecastUrl('https://api.open-meteo.com', RKSI, ['ecmwf_ifs025'], 16)).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=37.4602&longitude=126.4407&daily=temperature_2m_max&timezone=auto&forecast_days=16&models=ecmwf_ifs025',
    );
  });

  it('apikey switches handled by caller config: customer host + &apikey appended', () => {
    const url = forecastUrl('https://customer-api.open-meteo.com', RKSI, ['gfs_seamless'], 16, 'KEY');
    expect(url.startsWith('https://customer-api.open-meteo.com/v1/forecast?')).toBe(true);
    expect(url.endsWith('&apikey=KEY')).toBe(true);
  });

  it('rejects trap models (kma_seamless / ecmwf_ifs04 / gfs025) and empty lists', () => {
    for (const trap of ['kma_seamless', 'ecmwf_ifs04', 'gfs025']) {
      expect(() => forecastUrl('https://api.open-meteo.com', RKSI, [trap], 16)).toThrow(OpenMeteoShapeError);
    }
    expect(() => forecastUrl('https://api.open-meteo.com', RKSI, [], 16)).toThrow(OpenMeteoShapeError);
  });

  it('previousRunsUrl — hourly previous_day vars, optional backfill range', () => {
    expect(
      previousRunsUrl('https://previous-runs-api.open-meteo.com', RKSI, ['ecmwf_ifs025', 'gfs_seamless'], [1, 2, 7]),
    ).toBe(
      'https://previous-runs-api.open-meteo.com/v1/forecast?latitude=37.4602&longitude=126.4407&hourly=temperature_2m_previous_day1,temperature_2m_previous_day2,temperature_2m_previous_day7&timezone=auto&models=ecmwf_ifs025,gfs_seamless',
    );
    expect(
      previousRunsUrl('https://previous-runs-api.open-meteo.com', RKSI, ['gfs_seamless'], [0, 3], {
        start: '2025-01-01',
        end: '2025-01-31',
      }),
    ).toContain('hourly=temperature_2m,temperature_2m_previous_day3');
    expect(
      previousRunsUrl('https://previous-runs-api.open-meteo.com', RKSI, ['gfs_seamless'], [1], {
        start: '2025-01-01',
        end: '2025-01-31',
      }),
    ).toContain('&start_date=2025-01-01&end_date=2025-01-31');
  });

  it('ensembleUrl — one model per call, comma list refused (I2)', () => {
    expect(ensembleUrl('https://ensemble-api.open-meteo.com', RKSI, 'ecmwf_ifs025', 15)).toBe(
      'https://ensemble-api.open-meteo.com/v1/ensemble?latitude=37.4602&longitude=126.4407&daily=temperature_2m_max&timezone=auto&forecast_days=15&models=ecmwf_ifs025',
    );
    expect(() => ensembleUrl('https://ensemble-api.open-meteo.com', RKSI, 'ecmwf_ifs025,gfs05', 15)).toThrow(
      OpenMeteoShapeError,
    );
  });

  it('archiveUrl + historicalForecastUrl — research-verified shapes', () => {
    expect(archiveUrl('https://archive-api.open-meteo.com', RKSI, { start: '2026-05-01', end: '2026-06-09' })).toBe(
      'https://archive-api.open-meteo.com/v1/archive?latitude=37.4602&longitude=126.4407&daily=temperature_2m_max&timezone=auto&start_date=2026-05-01&end_date=2026-06-09',
    );
    expect(
      historicalForecastUrl(
        'https://historical-forecast-api.open-meteo.com', RKSI,
        ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'],
        { start: '2025-01-01', end: '2025-01-31' },
      ),
    ).toBe(
      'https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=37.4602&longitude=126.4407&daily=temperature_2m_max&timezone=auto&models=ecmwf_ifs025,gfs_seamless,icon_seamless&start_date=2025-01-01&end_date=2025-01-31',
    );
  });
});

describe('parseMultiModelDaily (§6.10)', () => {
  const json = fixture('openmeteo_forecast_multimodel_daily_RKSI.json');

  it('parses all 9 model suffixes; per-model null horizons tolerated', () => {
    const rows = parseMultiModelDaily(json, ALL_MODELS);
    const byModel = new Map<string, number>();
    for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
    expect(byModel.get('ecmwf_ifs025')).toBe(7);
    expect(byModel.get('gfs_seamless')).toBe(7);
    expect(byModel.get('best_match')).toBe(7);
    expect(byModel.get('cma_grapes_global')).toBe(5); // short horizon — nulls skipped
    expect(byModel.get('meteofrance_seamless')).toBe(4);
    const ecmwf = rows.find((r) => r.model === 'ecmwf_ifs025' && r.targetDate === '2026-06-10');
    expect(ecmwf?.tmaxC).toBe(21.6);
  });

  it('a missing model is tolerated; all-missing is fatal', () => {
    const rows = parseMultiModelDaily(json, ['ecmwf_ifs025', 'kma_seamless']);
    expect(rows.every((r) => r.model === 'ecmwf_ifs025')).toBe(true);
    expect(() => parseMultiModelDaily(json, ['kma_seamless'])).toThrow(OpenMeteoShapeError);
    expect(() => parseMultiModelDaily({ nope: true }, ALL_MODELS)).toThrow(OpenMeteoShapeError);
  });
});

describe('parsePreviousRunsHourly (§6.10)', () => {
  const json = fixture('openmeteo_previousruns_hourly_RKSI.json');
  const models = ['ecmwf_ifs025', 'gfs_seamless'];

  it('local-day max via the timezone=auto stamps; lead × model matrix', () => {
    const rows = parsePreviousRunsHourly(json, models, [0, 1, 2, 3, 4, 5, 6, 7], 'Asia/Seoul');
    expect(rows.length).toBe(2 * 8 * 2); // 2 models × 8 leads × 2 full local days
    const pick = (model: string, lead: number, day: string) =>
      rows.find((r) => r.model === model && r.leadDays === lead && r.targetDate === day);
    expect(pick('ecmwf_ifs025', 1, '2026-06-10')?.tmaxC).toBe(21.8);
    expect(pick('ecmwf_ifs025', 1, '2026-06-11')?.tmaxC).toBe(21.9);
    expect(pick('ecmwf_ifs025', 0, '2026-06-10')?.tmaxC).toBe(21.6);
    expect(pick('gfs_seamless', 7, '2026-06-10')?.tmaxC).toBe(19.9);
    expect(pick('gfs_seamless', 7, '2026-06-11')?.tmaxC).toBe(18.8);
  });

  it('drops days with < 20 hourly points', () => {
    const truncated = {
      hourly: {
        time: Array.from({ length: 10 }, (_, i) => `2026-06-10T${String(i).padStart(2, '0')}:00`),
        temperature_2m_previous_day1_ecmwf_ifs025: Array.from({ length: 10 }, () => 20),
      },
    };
    expect(parsePreviousRunsHourly(truncated, ['ecmwf_ifs025'], [1], 'Asia/Seoul')).toEqual([]);
  });
});

describe('single-model unsuffixed payloads (live-verified 2026-06-11 — the backfill shape)', () => {
  it('previous-runs: one model ⇒ bare per-lead keys parse as that model', () => {
    const json = fixture('openmeteo_prevruns_hourly_single_model_RKSI.json');
    const rows = parsePreviousRunsHourly(json, ['ecmwf_ifs025'], [1, 2], 'Asia/Seoul');
    expect(rows.length).toBe(4); // 1 model × 2 leads × 2 full local days
    expect(rows.every((r) => r.model === 'ecmwf_ifs025')).toBe(true);
    const pick = (lead: number, day: string) => rows.find((r) => r.leadDays === lead && r.targetDate === day);
    expect(pick(1, '2026-06-01')?.tmaxC).toBe(22.4);
    expect(pick(1, '2026-06-02')?.tmaxC).toBe(27.2);
    expect(pick(2, '2026-06-01')?.tmaxC).toBe(23.1);
    expect(pick(2, '2026-06-02')?.tmaxC).toBe(28);
  });

  it('historical-forecast: one model ⇒ the bare daily series is that model', () => {
    const json = fixture('openmeteo_historical_forecast_daily_single_model_RKSI.json');
    expect(parseMultiModelDaily(json, ['ecmwf_ifs025'])).toEqual([
      { model: 'ecmwf_ifs025', targetDate: '2026-06-01', tmaxC: 23.0 },
      { model: 'ecmwf_ifs025', targetDate: '2026-06-02', tmaxC: 28.2 },
      { model: 'ecmwf_ifs025', targetDate: '2026-06-03', tmaxC: 25.7 },
    ]);
  });

  it('multi-model requests NEVER fall back to bare keys (no misattribution)', () => {
    const single = fixture('openmeteo_prevruns_hourly_single_model_RKSI.json');
    expect(parsePreviousRunsHourly(single, ['ecmwf_ifs025', 'gfs_seamless'], [1], 'Asia/Seoul')).toEqual([]);
  });
});

describe('parseEnsembleDaily (§6.10, I2)', () => {
  it('fixture-verified member-suffix scheme: control = member 0 + 50 perturbed members', () => {
    const rows = parseEnsembleDaily(fixture('openmeteo_ensemble_daily_max_RKSI.json'));
    const members = new Set(rows.map((r) => r.member));
    expect(members.size).toBe(51); // control + member01..50
    expect(members.has(0)).toBe(true);
    expect(members.has(50)).toBe(true);
    expect(rows.length).toBe(51 * 7); // 7 dates, no nulls
    expect(rows.find((r) => r.member === 0 && r.targetDate === '2026-06-10')?.tmaxC).toBe(21.5);
    expect(rows.find((r) => r.member === 1 && r.targetDate === '2026-06-10')?.tmaxC).toBe(22.3);
  });

  it('OpenMeteoShapeError when no temperature series exists', () => {
    expect(() => parseEnsembleDaily({ daily: { time: ['2026-06-10'], rain: [1] } })).toThrow(OpenMeteoShapeError);
  });
});

describe('parseEra5Daily + requestWeight (§6.10)', () => {
  it('ERA5T daily parse vs the archive fixture', () => {
    const rows = parseEra5Daily(fixture('openmeteo_era5_archive_daily_RKSI.json'));
    expect(rows.length).toBe(40);
    expect(rows[0]).toEqual({ date: '2026-05-01', tmaxC: 17.4 });
  });

  it('requestWeight: >10 vars and >2-week spans produce fractional multiples', () => {
    expect(requestWeight(8, 7)).toBe(1);
    expect(requestWeight(10, 14)).toBe(1);
    expect(requestWeight(15, 7)).toBe(1.5);
    expect(requestWeight(8, 21)).toBe(1.5);
    expect(requestWeight(20, 28)).toBe(4);
  });
});

describe('Wunderground v1 (§6.10)', () => {
  it('wuObsUrl — {ICAO}:9:{CC} format with units e/m', () => {
    expect(wuObsUrl('KORD', 'us', 'e', '20260609', 'SOMEKEY')).toBe(
      'https://api.weather.com/v1/location/KORD:9:US/observations/historical.json?apiKey=SOMEKEY&units=e&startDate=20260609&endDate=20260609',
    );
    expect(wuObsUrl('RKSI', 'KR', 'm', '20260609', 'SOMEKEY')).toContain('/RKSI:9:KR/');
  });

  it('extractWuApiKey finds the embedded 32-hex key in the saved RKSI history HTML', () => {
    const html = readFileSync(join(RESEARCH, 'wunderground_history_RKSI_2026-06-09.html'), 'utf8');
    const key = extractWuApiKey(html);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    // must be the key actually used in apiKey= URLs inside the page, not a random hash
    expect(html).toContain(`apiKey=${key}`);
    expect(extractWuApiKey('<html>no key here</html>')).toBeNull();
  });

  it('KORD units=e fixture → daily max 87 (the live-verified grading value)', () => {
    const obs = parseWuObservations(fixture('wunderground_api_v1_obs_historical_KORD_2026-06-09_unitsE.json'));
    expect(obs.length).toBe(37);
    expect(wuDailyMax(obs)).toEqual({ maxInt: 87, nObs: 37 });
  });

  it('RKSI units=m fixture → daily max 25', () => {
    const obs = parseWuObservations(fixture('wunderground_api_v1_obs_historical_RKSI_2026-06-09.json'));
    expect(wuDailyMax(obs)?.maxInt).toBe(25);
  });

  it('empty obs → [] then null daily max; shape change → WuShapeError', () => {
    expect(parseWuObservations({ observations: [] })).toEqual([]);
    expect(wuDailyMax([])).toBeNull();
    expect(wuDailyMax([{ validTimeGmt: 1, tempInt: null }])).toBeNull();
    expect(() => parseWuObservations({ nope: [] })).toThrow(WuShapeError);
  });

  it('isFinalized — next-day obs presence', () => {
    expect(isFinalized([])).toBe(false);
    expect(isFinalized([{ validTimeGmt: 1781000000 }])).toBe(true);
  });
});

describe('METAR (§6.10)', () => {
  const obs = parseMetarJson(fixture('aviationweather_metar_RKSI.json'));

  it('parses the RKSI fixture verbatim fields', () => {
    expect(obs.length).toBe(48);
    expect(obs[0]!.icaoId).toBe('RKSI');
    expect(obs.every((o) => Number.isFinite(o.obsTimeUtc) && Number.isFinite(o.tempTenthsC))).toBe(true);
  });

  it('metarRunningMax — local-day filter correctness (Seoul)', () => {
    expect(metarRunningMax(obs, 'Asia/Seoul', '2026-06-10')).toBe(23); // 37 obs in the local day
    expect(metarRunningMax(obs, 'Asia/Seoul', '2026-06-09')).toBe(20); // tail of the previous local day
    expect(metarRunningMax(obs, 'Asia/Seoul', '2026-06-20')).toBeNull(); // nothing observed yet
  });

  it('WuShapeError on a non-array payload', () => {
    expect(() => parseMetarJson({ data: [] })).toThrow(WuShapeError);
  });
});

describe('IEM (§6.10)', () => {
  it('iemNetworkFor — US 3-letter + {ST}_ASOS; intl ICAO + {CC}__ASOS (two underscores)', () => {
    expect(iemNetworkFor('US', 'KORD', 'IL')).toEqual({ network: 'IL_ASOS', station: 'ORD' });
    expect(iemNetworkFor('KR', 'RKSI')).toEqual({ network: 'KR__ASOS', station: 'RKSI' });
    expect(iemNetworkFor('GB', 'EGLL')).toEqual({ network: 'GB__ASOS', station: 'EGLL' });
    expect(() => iemNetworkFor('US', 'KORD')).toThrow(ValidationError); // state required for US
  });

  it('iemDailyUrl + parseIemDaily vs the ORD fixture', () => {
    expect(iemDailyUrl('ORD', 'IL_ASOS', '2026-06-08')).toBe(
      'https://mesonet.agron.iastate.edu/api/1/daily.json?station=ORD&network=IL_ASOS&date=2026-06-08',
    );
    expect(parseIemDaily(fixture('iem_daily_ORD_2026-06-08.json'))).toEqual({ maxTmpF: 84.0 });
  });

  it('null on an empty data array; WuShapeError on shape change', () => {
    expect(parseIemDaily({ data: [] })).toBeNull();
    expect(() => parseIemDaily({ rows: [] })).toThrow(WuShapeError);
  });
});
