/**
 * packages/core/sim/city-buy-table-results — the committed, typed record behind the /paper-trade per-city
 * table: "$10 on OUR predicted daily-high bucket, bought CHEAP (ask <= 0.15), held to market close",
 * scored across every city from the local price archive. Mirrors the city-scan-results.ts committed-asset
 * idiom (this file IS the display-ready record; the page renders it server-side, no DB round trip, no fetch).
 *
 * VERDICT (recorded 2026-07-09): this is SIGNAL #12, opening-convergence — ALREADY FALSIFIED (FINDINGS.md /
 * MARKET-PNL.md). The cheap-entry filter buys the predicted bucket only while it is still a not-yet-converged
 * LONGSHOT; at the executable ask, held to resolution, it LOSES at every entry lead. Pooled ROI
 * -28.2% at the sweet-spot 24h lead (win 6.3%, day-clustered CI
 * [-57.7%, 4.3%]) on 347 bets / 46 days / 43
 * cities. The market prices our bucket <= 0.15 EXACTLY when it is unlikely to win. The
 * 16 net-positive cities are small-sample longshot noise, not a per-city edge.
 *
 * SOURCE OF TRUTH: scripts/research/city-buy-table.py (reproduce below). Do NOT hand-edit a number — re-run:
 *   pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
 *   python scripts/research/city-buy-table.py --emit scripts/research/out/city-buy-table.json \
 *     --emit-ts packages/core/src/sim/city-buy-table-results.ts --asof 2026-07-09
 */

/** One entry-lead row of the pooled "sweet-spot" curve (hours before market close). Negative at every lead
 *  — and MORE negative nearer close (the tell: a real forecast edge would strengthen near resolution). */
export interface CityBuyLeadPoint {
  /** entry lead in hours before the market's close/resolution. */
  leadH: number;
  /** cheap-filtered bets pooled at this lead. */
  bets: number;
  /** distinct weather-days covered at this lead. */
  days: number;
  /** win rate at this lead (percent). */
  winPct: number;
  /** mean executable entry ask at this lead. */
  avgAsk: number;
  /** pooled ROI at this lead (percent of stake). */
  roiPct: number;
  /** pooled net P&L (USD) at this lead. */
  netUsd: number;
  /** day-clustered ROI 95% CI [lo, hi] in percent. */
  ciPct: [number, number];
}

/** One city's row at the sweet-spot lead — the table the operator asked for. */
export interface CityBuyRow {
  city: string;
  display: string;
  icao: string;
  /** bets placed (days the predicted bucket passed the cheap gate at the sweet lead). */
  bets: number;
  /** distinct weather-days a bet was active. */
  daysActive: number;
  won: number;
  lost: number;
  /** win rate (percent) with a Wilson 95% CI. */
  winPct: number;
  winCi: [number, number];
  /** mean executable entry ask (fraction). */
  avgAsk: number;
  /** total staked (USD). */
  staked: number;
  /** net P&L (USD) at the executable ask, held to resolution. */
  netUsd: number;
  /** ROI (percent of stake). */
  roiPct: number;
  firstDate: string;
  lastDate: string;
  /** net P&L (USD) by entry lead — the per-city "peak-time" sparkline. Keys are lead-hours as strings. */
  leadNet: Record<string, number>;
}

export interface CityBuyTable {
  params: {
    stake: number;
    cheapMax: number;
    halfSpread: number;
    floor: number;
    forecastLead: number;
    sweetLeadH: number;
    leadsH: number[];
  };
  universe: { nCities: number; nDays: number; dateRange: [string, string]; nCitiesTotal: number };
  pooled: {
    bets: number;
    won: number;
    winPct: number;
    avgAsk: number;
    netUsd: number;
    roiPct: number;
    dayCiPct: [number, number];
    nCitiesPositive: number;
  };
  /** when the record was adjudicated. */
  recordedAt: string;
  leadCurve: CityBuyLeadPoint[];
  /** per-city rows at the sweet-spot lead, pre-sorted by net P&L descending. */
  rows: CityBuyRow[];
}

export const CITY_BUY_TABLE: CityBuyTable = {
  params: { stake: 10.0, cheapMax: 0.15, halfSpread: 0.01, floor: 0.03, forecastLead: 1, sweetLeadH: 24, leadsH: [48, 24, 12, 6] },
  universe: { nCities: 43, nDays: 46, dateRange: ['2026-05-14', '2026-06-30'], nCitiesTotal: 45 },
  pooled: { bets: 347, won: 22, winPct: 6.3, avgAsk: 0.062, netUsd: -977.0, roiPct: -28.2, dayCiPct: [-57.7, 4.3], nCitiesPositive: 16 },
  recordedAt: '2026-07-09',
  leadCurve: [
  { leadH: 48, bets: 298, days: 47, winPct: 5.7, avgAsk: 0.067, roiPct: -27.6, netUsd: -824.0, ciPct: [-60.8, 10.5] },
  { leadH: 24, bets: 347, days: 46, winPct: 6.3, avgAsk: 0.062, roiPct: -28.2, netUsd: -977.0, ciPct: [-57.7, 4.3] },
  { leadH: 12, bets: 721, days: 47, winPct: 2.4, avgAsk: 0.045, roiPct: -68.9, netUsd: -4970.0, ciPct: [-84.5, -50.2] },
  { leadH: 6, bets: 1114, days: 47, winPct: 0.2, avgAsk: 0.031, roiPct: -98.1, netUsd: -10923.0, ciPct: [-100.0, -94.9] },
  ],
  rows: [
  { city: 'jeddah', display: 'Jeddah', icao: 'OEJN', bets: 2, daysActive: 2, won: 2, lost: 0, winPct: 100.0, winCi: [34.2, 100.0], avgAsk: 0.09, staked: 20.0, netUsd: 241.82, roiPct: 1209.1, firstDate: '2026-05-25', lastDate: '2026-05-31', leadNet: { '24': 241.8, '12': 25.2, '6': -260.0 } },
  { city: 'paris', display: 'Paris', icao: 'LFPB', bets: 9, daysActive: 9, won: 1, lost: 8, winPct: 11.1, winCi: [2.0, 43.5], avgAsk: 0.059, staked: 90.0, netUsd: 110.0, roiPct: 122.2, firstDate: '2026-05-14', lastDate: '2026-06-27', leadNet: { '48': -60.0, '24': 110.0, '12': 120.0, '6': -250.0 } },
  { city: 'houston', display: 'Houston', icao: 'KHOU', bets: 5, daysActive: 5, won: 1, lost: 4, winPct: 20.0, winCi: [3.6, 62.4], avgAsk: 0.079, staked: 50.0, netUsd: 83.33, roiPct: 166.7, firstDate: '2026-05-24', lastDate: '2026-06-17', leadNet: { '48': 83.3, '24': 83.3, '12': -60.0, '6': -100.0 } },
  { city: 'buenos-aires', display: 'Buenos Aires', icao: 'SAEZ', bets: 22, daysActive: 22, won: 2, lost: 20, winPct: 9.1, winCi: [2.5, 27.8], avgAsk: 0.061, staked: 220.0, netUsd: 75.05, roiPct: 34.1, firstDate: '2026-05-16', lastDate: '2026-06-29', leadNet: { '48': 191.7, '24': 75.1, '12': -130.9, '6': -320.0 } },
  { city: 'tokyo', display: 'Tokyo', icao: 'RJTT', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.105, staked: 20.0, netUsd: 71.32, roiPct: 356.6, firstDate: '2026-06-01', lastDate: '2026-06-22', leadNet: { '48': 123.9, '24': 71.3, '12': -74.8, '6': -220.0 } },
  { city: 'ankara', display: 'Ankara', icao: 'LTAC', bets: 8, daysActive: 8, won: 1, lost: 7, winPct: 12.5, winCi: [2.2, 47.1], avgAsk: 0.058, staked: 80.0, netUsd: 70.38, roiPct: 88.0, firstDate: '2026-05-16', lastDate: '2026-06-19', leadNet: { '48': 35.3, '24': 70.4, '12': -120.0, '6': -240.0 } },
  { city: 'shanghai', display: 'Shanghai', icao: 'ZSPD', bets: 1, daysActive: 1, won: 1, lost: 0, winPct: 100.0, winCi: [20.7, 100.0], avgAsk: 0.135, staked: 10.0, netUsd: 64.07, roiPct: 640.7, firstDate: '2026-06-19', lastDate: '2026-06-19', leadNet: { '48': -10.0, '24': 64.1, '12': 5.9, '6': -300.0 } },
  { city: 'seoul', display: 'Seoul', icao: 'RKSI', bets: 5, daysActive: 5, won: 1, lost: 4, winPct: 20.0, winCi: [3.6, 62.4], avgAsk: 0.073, staked: 50.0, netUsd: 61.11, roiPct: 122.2, firstDate: '2026-05-16', lastDate: '2026-06-25', leadNet: { '48': -30.0, '24': 61.1, '12': -46.7, '6': -260.0 } },
  { city: 'wuhan', display: 'Wuhan', icao: 'ZHHH', bets: 3, daysActive: 3, won: 1, lost: 2, winPct: 33.3, winCi: [6.1, 79.2], avgAsk: 0.093, staked: 30.0, netUsd: 56.96, roiPct: 189.9, firstDate: '2026-05-26', lastDate: '2026-06-21', leadNet: { '48': -30.0, '24': 57.0, '12': -130.0, '6': -310.0 } },
  { city: 'wellington', display: 'Wellington', icao: 'NZWN', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.132, staked: 20.0, netUsd: 56.92, roiPct: 284.6, firstDate: '2026-06-06', lastDate: '2026-06-09', leadNet: { '48': -20.0, '24': 56.9, '12': -110.0, '6': -86.7 } },
  { city: 'panama-city', display: 'Panama City', icao: 'MPMG', bets: 8, daysActive: 8, won: 1, lost: 7, winPct: 12.5, winCi: [2.2, 47.1], avgAsk: 0.076, staked: 80.0, netUsd: 45.0, roiPct: 56.2, firstDate: '2026-06-08', lastDate: '2026-06-27', leadNet: { '48': -60.0, '24': 45.0, '12': -240.0, '6': -270.0 } },
  { city: 'dallas', display: 'Dallas', icao: 'KDAL', bets: 8, daysActive: 8, won: 1, lost: 7, winPct: 12.5, winCi: [2.2, 47.1], avgAsk: 0.083, staked: 80.0, netUsd: 41.95, roiPct: 52.4, firstDate: '2026-05-22', lastDate: '2026-06-21', leadNet: { '48': 108.7, '24': 42.0, '12': 257.9, '6': -150.0 } },
  { city: 'guangzhou', display: 'Guangzhou', icao: 'ZGGG', bets: 4, daysActive: 4, won: 1, lost: 3, winPct: 25.0, winCi: [4.6, 69.9], avgAsk: 0.074, staked: 40.0, netUsd: 40.0, roiPct: 100.0, firstDate: '2026-05-30', lastDate: '2026-06-08', leadNet: { '48': -40.0, '24': 40.0, '12': -180.0, '6': -300.0 } },
  { city: 'taipei', display: 'Taipei', icao: 'RCSS', bets: 4, daysActive: 4, won: 1, lost: 3, winPct: 25.0, winCi: [4.6, 69.9], avgAsk: 0.115, staked: 40.0, netUsd: 31.43, roiPct: 78.6, firstDate: '2026-05-20', lastDate: '2026-06-12', leadNet: { '48': 160.0, '24': 31.4, '12': -260.0, '6': -280.0 } },
  { city: 'warsaw', display: 'Warsaw', icao: 'EPWA', bets: 9, daysActive: 9, won: 1, lost: 8, winPct: 11.1, winCi: [2.0, 43.5], avgAsk: 0.052, staked: 90.0, netUsd: 27.65, roiPct: 30.7, firstDate: '2026-05-14', lastDate: '2026-06-21', leadNet: { '48': 0.9, '24': 27.6, '12': -130.0, '6': -310.0 } },
  { city: 'mexico-city', display: 'Mexico City', icao: 'MMMX', bets: 6, daysActive: 6, won: 1, lost: 5, winPct: 16.7, winCi: [3.0, 56.4], avgAsk: 0.072, staked: 60.0, netUsd: 11.43, roiPct: 19.0, firstDate: '2026-05-20', lastDate: '2026-06-27', leadNet: { '48': 181.2, '24': 11.4, '12': 99.7, '6': -180.0 } },
  { city: 'denver', display: 'Denver', icao: 'KBKF', bets: 14, daysActive: 14, won: 1, lost: 13, winPct: 7.1, winCi: [1.3, 31.5], avgAsk: 0.037, staked: 140.0, netUsd: -4.86, roiPct: -3.5, firstDate: '2026-05-17', lastDate: '2026-06-29', leadNet: { '48': 19.3, '24': -4.9, '12': -65.9, '6': -140.0 } },
  { city: 'kuala-lumpur', display: 'Kuala Lumpur', icao: 'WMKK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.115, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-18', lastDate: '2026-06-18', leadNet: { '48': -10.0, '24': -10.0, '12': -120.0, '6': -240.0 } },
  { city: 'lucknow', display: 'Lucknow', icao: 'VILK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.105, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-18', lastDate: '2026-06-18', leadNet: { '24': -10.0, '12': -20.0, '6': -40.0 } },
  { city: 'karachi', display: 'Karachi', icao: 'OPKC', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.052, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-05-31', lastDate: '2026-06-16', leadNet: { '48': -20.0, '24': -30.0, '12': 80.0, '6': -230.0 } },
  { city: 'los-angeles', display: 'Los Angeles', icao: 'KLAX', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.071, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-05-22', lastDate: '2026-06-27', leadNet: { '48': -30.0, '24': -30.0, '12': -110.0, '6': -130.0 } },
  { city: 'beijing', display: 'Beijing', icao: 'ZBAA', bets: 4, daysActive: 4, won: 0, lost: 4, winPct: 0.0, winCi: [0.0, 49.0], avgAsk: 0.046, staked: 40.0, netUsd: -40.0, roiPct: -100.0, firstDate: '2026-05-22', lastDate: '2026-05-31', leadNet: { '48': -60.0, '24': -40.0, '12': -180.0, '6': -340.0 } },
  { city: 'busan', display: 'Busan', icao: 'RKPK', bets: 4, daysActive: 4, won: 0, lost: 4, winPct: 0.0, winCi: [0.0, 49.0], avgAsk: 0.094, staked: 40.0, netUsd: -40.0, roiPct: -100.0, firstDate: '2026-05-24', lastDate: '2026-06-21', leadNet: { '48': -20.0, '24': -40.0, '12': -180.0, '6': -270.0 } },
  { city: 'miami', display: 'Miami', icao: 'KMIA', bets: 4, daysActive: 4, won: 0, lost: 4, winPct: 0.0, winCi: [0.0, 49.0], avgAsk: 0.095, staked: 40.0, netUsd: -40.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-21', leadNet: { '48': -30.0, '24': -40.0, '12': -50.0, '6': -120.0 } },
  { city: 'san-francisco', display: 'San Francisco', icao: 'KSFO', bets: 4, daysActive: 4, won: 0, lost: 4, winPct: 0.0, winCi: [0.0, 49.0], avgAsk: 0.047, staked: 40.0, netUsd: -40.0, roiPct: -100.0, firstDate: '2026-05-29', lastDate: '2026-06-11', leadNet: { '48': -40.0, '24': -40.0, '12': -110.0, '6': -150.0 } },
  { city: 'chengdu', display: 'Chengdu', icao: 'ZUUU', bets: 5, daysActive: 5, won: 0, lost: 5, winPct: 0.0, winCi: [-0.0, 43.4], avgAsk: 0.11, staked: 50.0, netUsd: -50.0, roiPct: -100.0, firstDate: '2026-05-30', lastDate: '2026-06-29', leadNet: { '48': 55.2, '24': -50.0, '12': -190.0, '6': -310.0 } },
  { city: 'qingdao', display: 'Qingdao', icao: 'ZSQD', bets: 5, daysActive: 5, won: 0, lost: 5, winPct: 0.0, winCi: [-0.0, 43.4], avgAsk: 0.049, staked: 50.0, netUsd: -50.0, roiPct: -100.0, firstDate: '2026-05-26', lastDate: '2026-06-01', leadNet: { '48': 75.3, '24': -50.0, '12': -150.0, '6': -280.0 } },
  { city: 'shenzhen', display: 'Shenzhen', icao: 'ZGSZ', bets: 5, daysActive: 5, won: 0, lost: 5, winPct: 0.0, winCi: [-0.0, 43.4], avgAsk: 0.068, staked: 50.0, netUsd: -50.0, roiPct: -100.0, firstDate: '2026-05-21', lastDate: '2026-06-22', leadNet: { '48': -10.0, '24': -50.0, '12': -143.1, '6': -310.0 } },
  { city: 'cape-town', display: 'Cape Town', icao: 'FACT', bets: 6, daysActive: 6, won: 0, lost: 6, winPct: 0.0, winCi: [0.0, 39.0], avgAsk: 0.067, staked: 60.0, netUsd: -60.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-01', leadNet: { '48': -60.0, '24': -60.0, '12': -170.0, '6': -310.0 } },
  { city: 'chongqing', display: 'Chongqing', icao: 'ZUCK', bets: 6, daysActive: 6, won: 0, lost: 6, winPct: 0.0, winCi: [0.0, 39.0], avgAsk: 0.056, staked: 60.0, netUsd: -60.0, roiPct: -100.0, firstDate: '2026-05-28', lastDate: '2026-06-19', leadNet: { '48': -60.0, '24': -60.0, '12': -170.0, '6': -320.0 } },
  { city: 'madrid', display: 'Madrid', icao: 'LEMD', bets: 6, daysActive: 6, won: 0, lost: 6, winPct: 0.0, winCi: [0.0, 39.0], avgAsk: 0.036, staked: 60.0, netUsd: -60.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-02', leadNet: { '48': -50.0, '24': -60.0, '12': -110.0, '6': -190.0 } },
  { city: 'milan', display: 'Milan', icao: 'LIMC', bets: 7, daysActive: 6, won: 0, lost: 7, winPct: 0.0, winCi: [0.0, 35.4], avgAsk: 0.05, staked: 70.0, netUsd: -70.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-02', leadNet: { '48': 3.3, '24': -70.0, '12': -120.0, '6': -310.0 } },
  { city: 'amsterdam', display: 'Amsterdam', icao: 'EHAM', bets: 14, daysActive: 14, won: 1, lost: 13, winPct: 7.1, winCi: [1.3, 31.5], avgAsk: 0.059, staked: 140.0, netUsd: -71.03, roiPct: -50.7, firstDate: '2026-05-16', lastDate: '2026-06-27', leadNet: { '48': -100.0, '24': -71.0, '12': -88.9, '6': -340.0 } },
  { city: 'sao-paulo', display: 'Sao Paulo', icao: 'SBGR', bets: 17, daysActive: 17, won: 1, lost: 16, winPct: 5.9, winCi: [1.0, 27.0], avgAsk: 0.047, staked: 170.0, netUsd: -83.04, roiPct: -48.8, firstDate: '2026-05-15', lastDate: '2026-06-27', leadNet: { '48': -35.0, '24': -83.0, '12': -220.0, '6': -300.0 } },
  { city: 'helsinki', display: 'Helsinki', icao: 'EFHK', bets: 9, daysActive: 9, won: 0, lost: 9, winPct: 0.0, winCi: [0.0, 29.9], avgAsk: 0.097, staked: 90.0, netUsd: -90.0, roiPct: -100.0, firstDate: '2026-05-21', lastDate: '2026-06-21', leadNet: { '48': -50.0, '24': -90.0, '12': -210.0, '6': -320.0 } },
  { city: 'austin', display: 'Austin', icao: 'KAUS', bets: 10, daysActive: 10, won: 0, lost: 10, winPct: 0.0, winCi: [-0.0, 27.8], avgAsk: 0.072, staked: 100.0, netUsd: -100.0, roiPct: -100.0, firstDate: '2026-05-20', lastDate: '2026-06-22', leadNet: { '48': -80.0, '24': -100.0, '12': -100.0, '6': -150.0 } },
  { city: 'chicago', display: 'Chicago', icao: 'KORD', bets: 10, daysActive: 10, won: 0, lost: 10, winPct: 0.0, winCi: [-0.0, 27.8], avgAsk: 0.042, staked: 100.0, netUsd: -100.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-28', leadNet: { '48': -100.0, '24': -100.0, '12': -150.0, '6': -180.0 } },
  { city: 'atlanta', display: 'Atlanta', icao: 'KATL', bets: 14, daysActive: 14, won: 0, lost: 14, winPct: 0.0, winCi: [0.0, 21.5], avgAsk: 0.079, staked: 140.0, netUsd: -140.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-29', leadNet: { '48': -130.0, '24': -140.0, '12': -200.0, '6': -220.0 } },
  { city: 'munich', display: 'Munich', icao: 'EDDM', bets: 15, daysActive: 14, won: 0, lost: 15, winPct: 0.0, winCi: [-0.0, 20.4], avgAsk: 0.064, staked: 150.0, netUsd: -150.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-28', leadNet: { '48': -120.0, '24': -150.0, '12': -170.0, '6': -310.0 } },
  { city: 'seattle', display: 'Seattle', icao: 'KSEA', bets: 15, daysActive: 15, won: 0, lost: 15, winPct: 0.0, winCi: [-0.0, 20.4], avgAsk: 0.047, staked: 150.0, netUsd: -150.0, roiPct: -100.0, firstDate: '2026-05-15', lastDate: '2026-06-25', leadNet: { '48': -150.0, '24': -150.0, '12': -170.0, '6': -190.0 } },
  { city: 'toronto', display: 'Toronto', icao: 'CYYZ', bets: 30, daysActive: 30, won: 1, lost: 29, winPct: 3.3, winCi: [0.6, 16.7], avgAsk: 0.053, staked: 300.0, netUsd: -166.67, roiPct: -55.6, firstDate: '2026-05-14', lastDate: '2026-06-30', leadNet: { '48': -146.7, '24': -166.7, '12': -196.7, '6': -266.7 } },
  { city: 'london', display: 'London', icao: 'EGLC', bets: 17, daysActive: 17, won: 0, lost: 17, winPct: 0.0, winCi: [0.0, 18.4], avgAsk: 0.042, staked: 170.0, netUsd: -170.0, roiPct: -100.0, firstDate: '2026-05-17', lastDate: '2026-06-15', leadNet: { '48': -150.0, '24': -170.0, '12': -181.3, '6': -350.0 } },
  { city: 'nyc', display: 'New York', icao: 'KLGA', bets: 20, daysActive: 20, won: 0, lost: 20, winPct: 0.0, winCi: [-0.0, 16.1], avgAsk: 0.043, staked: 200.0, netUsd: -200.0, roiPct: -100.0, firstDate: '2026-05-15', lastDate: '2026-06-24', leadNet: { '48': -160.0, '24': -200.0, '12': -220.0, '6': -250.0 } },
  ],
};
