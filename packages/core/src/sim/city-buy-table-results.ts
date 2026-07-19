/**
 * packages/core/sim/city-buy-table-results — the committed, typed record behind the /paper-trade per-city
 * table: "$10 on OUR predicted daily-high bucket, bought CHEAP (ask <= 0.15), held to market close",
 * scored across every city from the local price archive. Mirrors the city-scan-results.ts committed-asset
 * idiom (this file IS the display-ready record; the page renders it server-side, no DB round trip, no fetch).
 *
 * VERDICT (recorded 2026-07-19): this is SIGNAL #12, opening-convergence — ALREADY FALSIFIED (FINDINGS.md /
 * MARKET-PNL.md). The cheap-entry filter buys the predicted bucket only while it is still a not-yet-converged
 * LONGSHOT. On the calibrated book (exec ask + taker fee; a bet exists only where walked depth covers the
 * stake) the fillable-and-cheap population nearly VANISHES — the sub-9c longshots that drove the legacy
 * mid+1c −28% were never fillable at this stake — and what remains is an UNDERPOWERED WASH:
 * pooled ROI 2.4% at the sweet-spot 48h lead (win 13.4%, day-clustered
 * CI [-52.3%, 60.5%]) on 82 bets / 37 days /
 * 36 cities. NO lead demonstrates an edge (no day-clustered lower bound clears 0 — every
 * lead's CI straddles it by tens of points; tiny-n rows are longshot noise). The
 * 10 net-positive cities are small-sample noise, not a per-city edge.
 *
 * SOURCE OF TRUTH: scripts/research/city-buy-table.py (reproduce below). Do NOT hand-edit a number — re-run:
 *   pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
 *   python scripts/research/city-buy-table.py --book calibrated --emit scripts/research/out/city-buy-table.json \
 *     --emit-ts packages/core/src/sim/city-buy-table-results.ts --asof 2026-07-19
 */

/** One entry-lead row of the pooled "sweet-spot" curve (hours before market close). No lead demonstrates an
 *  edge (no day-clustered lower bound clears 0); the fillable-and-cheap population COLLAPSES near close —
 *  by resolution the winner has converged above the cheap gate and the rest is too thin to fill. */
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
    /** cost basis: 'calibrated' = the canonical CALIBRATED_BOOK exec ask + depth-fillability; 'flat' = legacy mid+1c. */
    book: string;
    halfSpread: number;
    floor: number;
    forecastLead: number;
    sweetLeadH: number;
    /** entry leads with a scoreable (cheap + fillable) population, far -> near. */
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
  params: { stake: 10.0, cheapMax: 0.15, book: 'calibrated', halfSpread: 0.01, floor: 0.03, forecastLead: 1, sweetLeadH: 48, leadsH: [48, 24, 12, 6] },
  universe: { nCities: 36, nDays: 37, dateRange: ['2026-05-13', '2026-06-30'], nCitiesTotal: 44 },
  pooled: { bets: 82, won: 11, winPct: 13.4, avgAsk: 0.135, netUsd: 20.0, roiPct: 2.4, dayCiPct: [-52.3, 60.5], nCitiesPositive: 10 },
  recordedAt: '2026-07-19',
  leadCurve: [
  { leadH: 48, bets: 82, days: 37, winPct: 13.4, avgAsk: 0.135, roiPct: 2.4, netUsd: 20.0, ciPct: [-52.3, 60.5] },
  { leadH: 24, bets: 71, days: 36, winPct: 11.3, avgAsk: 0.135, roiPct: -19.3, netUsd: -137.0, ciPct: [-69.6, 39.5] },
  { leadH: 12, bets: 59, days: 33, winPct: 13.6, avgAsk: 0.136, roiPct: -3.4, netUsd: -20.0, ciPct: [-62.6, 60.7] },
  { leadH: 6, bets: 4, days: 4, winPct: 25.0, avgAsk: 0.138, roiPct: 81.0, netUsd: 32.0, ciPct: [-100.0, 442.9] },
  ],
  rows: [
  { city: 'mexico-city', display: 'Mexico City', icao: 'MMMX', bets: 3, daysActive: 3, won: 2, lost: 1, winPct: 66.7, winCi: [20.8, 93.9], avgAsk: 0.129, staked: 30.0, netUsd: 121.2, roiPct: 404.0, firstDate: '2026-06-14', lastDate: '2026-06-27', leadNet: { '48': 121.2, '12': 127.7 } },
  { city: 'ankara', display: 'Ankara', icao: 'LTAC', bets: 1, daysActive: 1, won: 1, lost: 0, winPct: 100.0, winCi: [20.7, 100.0], avgAsk: 0.124, staked: 10.0, netUsd: 70.89, roiPct: 708.9, firstDate: '2026-06-18', lastDate: '2026-06-18', leadNet: { '48': 70.9, '12': -10.0 } },
  { city: 'dallas', display: 'Dallas', icao: 'KDAL', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.128, staked: 20.0, netUsd: 60.89, roiPct: 304.5, firstDate: '2026-06-14', lastDate: '2026-06-17', leadNet: { '48': 60.9, '24': -40.0 } },
  { city: 'qingdao', display: 'Qingdao', icao: 'ZSQD', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.129, staked: 20.0, netUsd: 60.89, roiPct: 304.5, firstDate: '2026-05-15', lastDate: '2026-06-23', leadNet: { '48': 60.9, '24': -10.0, '12': -10.0 } },
  { city: 'milan', display: 'Milan', icao: 'LIMC', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.143, staked: 20.0, netUsd: 52.39, roiPct: 261.9, firstDate: '2026-05-24', lastDate: '2026-06-07', leadNet: { '48': 52.4, '24': -10.0, '12': -10.0 } },
  { city: 'los-angeles', display: 'Los Angeles', icao: 'KLAX', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.137, staked: 20.0, netUsd: 50.9, roiPct: 254.5, firstDate: '2026-05-30', lastDate: '2026-06-17', leadNet: { '48': 50.9, '12': -10.0 } },
  { city: 'chengdu', display: 'Chengdu', icao: 'ZUUU', bets: 3, daysActive: 3, won: 1, lost: 2, winPct: 33.3, winCi: [6.1, 79.2], avgAsk: 0.131, staked: 30.0, netUsd: 47.26, roiPct: 157.5, firstDate: '2026-06-03', lastDate: '2026-06-27', leadNet: { '48': 47.3, '24': -30.0, '12': -10.0 } },
  { city: 'warsaw', display: 'Warsaw', icao: 'EPWA', bets: 3, daysActive: 3, won: 1, lost: 2, winPct: 33.3, winCi: [6.1, 79.2], avgAsk: 0.143, staked: 30.0, netUsd: 45.57, roiPct: 151.9, firstDate: '2026-05-17', lastDate: '2026-06-23', leadNet: { '48': 45.6, '24': -10.0, '6': -10.0 } },
  { city: 'austin', display: 'Austin', icao: 'KAUS', bets: 4, daysActive: 4, won: 1, lost: 3, winPct: 25.0, winCi: [4.6, 69.9], avgAsk: 0.135, staked: 40.0, netUsd: 30.9, roiPct: 77.2, firstDate: '2026-06-03', lastDate: '2026-06-16', leadNet: { '48': 30.9, '24': -40.0, '12': -10.0, '6': -10.0 } },
  { city: 'buenos-aires', display: 'Buenos Aires', icao: 'SAEZ', bets: 5, daysActive: 5, won: 1, lost: 4, winPct: 20.0, winCi: [3.6, 62.4], avgAsk: 0.131, staked: 50.0, netUsd: 29.04, roiPct: 58.1, firstDate: '2026-05-25', lastDate: '2026-06-22', leadNet: { '48': 29.0, '24': 20.9, '12': 50.5 } },
  { city: 'amsterdam', display: 'Amsterdam', icao: 'EHAM', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.131, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-26', lastDate: '2026-05-26', leadNet: { '48': -10.0, '24': -20.0 } },
  { city: 'busan', display: 'Busan', icao: 'RKPK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.135, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-01', lastDate: '2026-06-01', leadNet: { '48': -10.0, '24': -10.0, '12': -20.0 } },
  { city: 'chongqing', display: 'Chongqing', icao: 'ZUCK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.149, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-19', lastDate: '2026-06-19', leadNet: { '48': -10.0, '24': -20.0, '12': -10.0 } },
  { city: 'denver', display: 'Denver', icao: 'KBKF', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.124, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-09', lastDate: '2026-06-09', leadNet: { '48': -10.0, '12': 57.2 } },
  { city: 'karachi', display: 'Karachi', icao: 'OPKC', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.141, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-15', lastDate: '2026-06-15', leadNet: { '48': -10.0, '12': -10.0 } },
  { city: 'kuala-lumpur', display: 'Kuala Lumpur', icao: 'WMKK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.144, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-22', lastDate: '2026-05-22', leadNet: { '48': -10.0, '24': -10.0, '12': -10.0 } },
  { city: 'tokyo', display: 'Tokyo', icao: 'RJTT', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.132, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-01', lastDate: '2026-06-01', leadNet: { '48': -10.0, '24': 55.7, '12': 47.3 } },
  { city: 'wuhan', display: 'Wuhan', icao: 'ZHHH', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.141, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-05-14', leadNet: { '48': -10.0, '24': 53.9, '12': -10.0 } },
  { city: 'cape-town', display: 'Cape Town', icao: 'FACT', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.143, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-15', lastDate: '2026-05-16', leadNet: { '48': -20.0, '12': -30.0 } },
  { city: 'chicago', display: 'Chicago', icao: 'KORD', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.129, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-11', lastDate: '2026-06-15', leadNet: { '48': -20.0, '24': -10.0 } },
  { city: 'guangzhou', display: 'Guangzhou', icao: 'ZGGG', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.14, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-30', lastDate: '2026-06-07', leadNet: { '48': -20.0, '24': 50.9 } },
  { city: 'houston', display: 'Houston', icao: 'KHOU', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.128, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-24', lastDate: '2026-06-03', leadNet: { '48': -20.0, '24': -10.0 } },
  { city: 'miami', display: 'Miami', icao: 'KMIA', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.146, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-14', lastDate: '2026-06-21', leadNet: { '48': -20.0, '24': -20.0, '12': -10.0 } },
  { city: 'nyc', display: 'New York', icao: 'KLGA', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.129, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-27', lastDate: '2026-06-15', leadNet: { '48': -20.0, '24': -10.0, '12': 60.9 } },
  { city: 'panama-city', display: 'Panama City', icao: 'MPMG', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.137, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-09', lastDate: '2026-06-14', leadNet: { '48': -20.0, '24': -20.0, '12': -10.0 } },
  { city: 'san-francisco', display: 'San Francisco', icao: 'KSFO', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.142, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-14', lastDate: '2026-06-27', leadNet: { '48': -20.0, '24': -10.0 } },
  { city: 'seoul', display: 'Seoul', icao: 'RKSI', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.132, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-07', lastDate: '2026-06-25', leadNet: { '48': -20.0, '24': -10.0, '12': -20.0 } },
  { city: 'taipei', display: 'Taipei', icao: 'RCSS', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.144, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-30', lastDate: '2026-06-06', leadNet: { '48': -20.0, '24': -10.0, '12': -20.0 } },
  { city: 'toronto', display: 'Toronto', icao: 'CYYZ', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.124, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-10', lastDate: '2026-06-15', leadNet: { '48': -20.0, '24': -30.0, '12': -40.0 } },
  { city: 'beijing', display: 'Beijing', icao: 'ZBAA', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.132, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-05-26', lastDate: '2026-06-27', leadNet: { '48': -30.0 } },
  { city: 'helsinki', display: 'Helsinki', icao: 'EFHK', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.147, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-05-13', lastDate: '2026-06-05', leadNet: { '48': -30.0, '24': -50.0, '12': -20.0 } },
  { city: 'london', display: 'London', icao: 'EGLC', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.139, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-05-30', lastDate: '2026-06-08', leadNet: { '48': -30.0, '24': -10.0, '12': -20.0 } },
  { city: 'munich', display: 'Munich', icao: 'EDDM', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.142, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-05-24', lastDate: '2026-06-06', leadNet: { '48': -30.0, '24': -50.0, '12': -20.0 } },
  { city: 'sao-paulo', display: 'Sao Paulo', icao: 'SBGR', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.129, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-05-23', lastDate: '2026-06-30', leadNet: { '48': -30.0, '24': 43.9, '12': -10.0 } },
  { city: 'seattle', display: 'Seattle', icao: 'KSEA', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.14, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-06-09', lastDate: '2026-06-30', leadNet: { '48': -30.0, '24': -40.0, '12': -20.0 } },
  { city: 'atlanta', display: 'Atlanta', icao: 'KATL', bets: 7, daysActive: 7, won: 0, lost: 7, winPct: 0.0, winCi: [0.0, 35.4], avgAsk: 0.132, staked: 70.0, netUsd: -70.0, roiPct: -100.0, firstDate: '2026-05-15', lastDate: '2026-06-06', leadNet: { '48': -70.0, '24': -10.0, '12': -30.0 } },
  ],
};
