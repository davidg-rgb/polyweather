/**
 * packages/core/sim/city-buy-table-results — the committed, typed record behind the /paper-trade per-city
 * table: "$10 on OUR predicted daily-high bucket, bought CHEAP (ask <= 0.15), held to market close",
 * scored across every city from the local price archive. Mirrors the city-scan-results.ts committed-asset
 * idiom (this file IS the display-ready record; the page renders it server-side, no DB round trip, no fetch).
 *
 * VERDICT (recorded 2026-07-09): this is SIGNAL #12, opening-convergence — ALREADY FALSIFIED (FINDINGS.md /
 * MARKET-PNL.md). The cheap-entry filter buys the predicted bucket only while it is still a not-yet-converged
 * LONGSHOT. On the calibrated book (exec ask + taker fee; a bet exists only where walked depth covers the
 * stake) the fillable-and-cheap population nearly VANISHES — the sub-9c longshots that drove the legacy
 * mid+1c −28% were never fillable at this stake — and what remains is an UNDERPOWERED WASH leaning negative:
 * pooled ROI -9.2% at the sweet-spot 12h lead (win 12.7%, day-clustered
 * CI [-62.9%, 56.8%]) on 55 bets / 31 days /
 * 33 cities. NO lead demonstrates an edge (no day-clustered lower bound clears 0; every
 * well-populated lead's point estimate is negative; tiny-n rows are longshot noise). The
 * 6 net-positive cities are small-sample noise, not a per-city edge.
 *
 * SOURCE OF TRUTH: scripts/research/city-buy-table.py (reproduce below). Do NOT hand-edit a number — re-run:
 *   pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
 *   python scripts/research/city-buy-table.py --book calibrated --emit scripts/research/out/city-buy-table.json \
 *     --emit-ts packages/core/src/sim/city-buy-table-results.ts --asof 2026-07-09
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
  params: { stake: 10.0, cheapMax: 0.15, book: 'calibrated', halfSpread: 0.01, floor: 0.03, forecastLead: 1, sweetLeadH: 12, leadsH: [48, 24, 12, 6] },
  universe: { nCities: 33, nDays: 31, dateRange: ['2026-05-16', '2026-06-30'], nCitiesTotal: 44 },
  pooled: { bets: 55, won: 7, winPct: 12.7, avgAsk: 0.135, netUsd: -51.0, roiPct: -9.2, dayCiPct: [-62.9, 56.8], nCitiesPositive: 6 },
  recordedAt: '2026-07-09',
  leadCurve: [
  { leadH: 48, bets: 70, days: 35, winPct: 11.4, avgAsk: 0.135, roiPct: -11.8, netUsd: -83.0, ciPct: [-66.5, 46.5] },
  { leadH: 24, bets: 65, days: 34, winPct: 12.3, avgAsk: 0.135, roiPct: -11.8, netUsd: -77.0, ciPct: [-66.6, 45.7] },
  { leadH: 12, bets: 55, days: 31, winPct: 12.7, avgAsk: 0.135, roiPct: -9.2, netUsd: -51.0, ciPct: [-62.9, 56.8] },
  { leadH: 6, bets: 3, days: 3, winPct: 33.3, avgAsk: 0.139, roiPct: 141.3, netUsd: 42.0, ciPct: [-100.0, 623.9] },
  ],
  rows: [
  { city: 'mexico-city', display: 'Mexico City', icao: 'MMMX', bets: 2, daysActive: 2, won: 2, lost: 0, winPct: 100.0, winCi: [34.2, 100.0], avgAsk: 0.137, staked: 20.0, netUsd: 127.71, roiPct: 638.6, firstDate: '2026-06-07', lastDate: '2026-06-23', leadNet: { '48': 121.2, '12': 127.7 } },
  { city: 'denver', display: 'Denver', icao: 'KBKF', bets: 1, daysActive: 1, won: 1, lost: 0, winPct: 100.0, winCi: [20.7, 100.0], avgAsk: 0.149, staked: 10.0, netUsd: 57.2, roiPct: 572.0, firstDate: '2026-06-28', lastDate: '2026-06-28', leadNet: { '48': -10.0, '12': 57.2 } },
  { city: 'buenos-aires', display: 'Buenos Aires', icao: 'SAEZ', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.145, staked: 20.0, netUsd: 50.46, roiPct: 252.3, firstDate: '2026-05-24', lastDate: '2026-06-29', leadNet: { '48': 29.0, '24': 20.9, '12': 50.5 } },
  { city: 'shenzhen', display: 'Shenzhen', icao: 'ZGSZ', bets: 2, daysActive: 2, won: 1, lost: 1, winPct: 50.0, winCi: [9.5, 90.5], avgAsk: 0.135, staked: 20.0, netUsd: 49.47, roiPct: 247.3, firstDate: '2026-05-21', lastDate: '2026-06-20', leadNet: { '24': -10.0, '12': 49.5 } },
  { city: 'tokyo', display: 'Tokyo', icao: 'RJTT', bets: 3, daysActive: 3, won: 1, lost: 2, winPct: 33.3, winCi: [6.1, 79.2], avgAsk: 0.127, staked: 30.0, netUsd: 47.26, roiPct: 157.5, firstDate: '2026-06-07', lastDate: '2026-06-23', leadNet: { '48': -10.0, '24': 55.7, '12': 47.3 } },
  { city: 'shanghai', display: 'Shanghai', icao: 'ZSPD', bets: 5, daysActive: 5, won: 1, lost: 4, winPct: 20.0, winCi: [3.6, 62.4], avgAsk: 0.143, staked: 50.0, netUsd: 17.2, roiPct: 34.4, firstDate: '2026-05-22', lastDate: '2026-06-22', leadNet: { '24': 57.2, '12': 17.2 } },
  { city: 'ankara', display: 'Ankara', icao: 'LTAC', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.127, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-22', lastDate: '2026-05-22', leadNet: { '48': 70.9, '12': -10.0 } },
  { city: 'atlanta', display: 'Atlanta', icao: 'KATL', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.135, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-30', lastDate: '2026-05-30', leadNet: { '48': -50.0, '24': -10.0, '12': -10.0 } },
  { city: 'chengdu', display: 'Chengdu', icao: 'ZUUU', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.149, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-09', lastDate: '2026-06-09', leadNet: { '48': 47.3, '24': -30.0, '12': -10.0 } },
  { city: 'chongqing', display: 'Chongqing', icao: 'ZUCK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.149, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-11', lastDate: '2026-06-11', leadNet: { '48': -10.0, '24': -20.0, '12': -10.0 } },
  { city: 'jeddah', display: 'Jeddah', icao: 'OEJN', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.124, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-21', lastDate: '2026-05-21', leadNet: { '24': 60.9, '12': -10.0 } },
  { city: 'karachi', display: 'Karachi', icao: 'OPKC', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.129, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-11', lastDate: '2026-06-11', leadNet: { '48': -10.0, '12': -10.0 } },
  { city: 'kuala-lumpur', display: 'Kuala Lumpur', icao: 'WMKK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.141, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-22', lastDate: '2026-05-22', leadNet: { '48': -10.0, '24': -10.0, '12': -10.0 } },
  { city: 'los-angeles', display: 'Los Angeles', icao: 'KLAX', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.129, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-27', lastDate: '2026-06-27', leadNet: { '12': -10.0 } },
  { city: 'lucknow', display: 'Lucknow', icao: 'VILK', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.129, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-16', lastDate: '2026-06-16', leadNet: { '24': -10.0, '12': -10.0 } },
  { city: 'miami', display: 'Miami', icao: 'KMIA', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.126, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-30', lastDate: '2026-06-30', leadNet: { '48': -20.0, '24': -10.0, '12': -10.0 } },
  { city: 'milan', display: 'Milan', icao: 'LIMC', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.129, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-21', lastDate: '2026-05-21', leadNet: { '48': 52.4, '24': -10.0, '12': -10.0 } },
  { city: 'panama-city', display: 'Panama City', icao: 'MPMG', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.135, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-10', lastDate: '2026-06-10', leadNet: { '48': -20.0, '24': -20.0, '12': -10.0 } },
  { city: 'paris', display: 'Paris', icao: 'LFPB', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.141, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-24', lastDate: '2026-05-24', leadNet: { '24': -20.0, '12': -10.0 } },
  { city: 'qingdao', display: 'Qingdao', icao: 'ZSQD', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.129, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-05-20', lastDate: '2026-05-20', leadNet: { '48': 60.9, '24': -10.0, '12': -10.0 } },
  { city: 'sao-paulo', display: 'Sao Paulo', icao: 'SBGR', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.132, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-06', lastDate: '2026-06-06', leadNet: { '48': -30.0, '24': 43.9, '12': -10.0 } },
  { city: 'singapore', display: 'Singapore', icao: 'WSSS', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.133, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-23', lastDate: '2026-06-23', leadNet: { '12': -10.0 } },
  { city: 'wuhan', display: 'Wuhan', icao: 'ZHHH', bets: 1, daysActive: 1, won: 0, lost: 1, winPct: 0.0, winCi: [0.0, 79.3], avgAsk: 0.149, staked: 10.0, netUsd: -10.0, roiPct: -100.0, firstDate: '2026-06-18', lastDate: '2026-06-18', leadNet: { '48': -10.0, '24': 53.9, '12': -10.0 } },
  { city: 'busan', display: 'Busan', icao: 'RKPK', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.131, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-17', lastDate: '2026-06-27', leadNet: { '48': -10.0, '24': -10.0, '12': -20.0 } },
  { city: 'helsinki', display: 'Helsinki', icao: 'EFHK', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.138, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-16', lastDate: '2026-06-15', leadNet: { '48': -30.0, '24': -50.0, '12': -20.0 } },
  { city: 'london', display: 'London', icao: 'EGLC', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.137, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-08', lastDate: '2026-06-10', leadNet: { '48': -30.0, '24': -10.0, '12': -20.0 } },
  { city: 'madrid', display: 'Madrid', icao: 'LEMD', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.141, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-15', lastDate: '2026-06-25', leadNet: { '12': -20.0, '6': -10.0 } },
  { city: 'munich', display: 'Munich', icao: 'EDDM', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.134, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-03', lastDate: '2026-06-24', leadNet: { '48': -30.0, '24': -50.0, '12': -20.0 } },
  { city: 'seattle', display: 'Seattle', icao: 'KSEA', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.134, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-12', lastDate: '2026-06-15', leadNet: { '48': -10.0, '24': -20.0, '12': -20.0 } },
  { city: 'seoul', display: 'Seoul', icao: 'RKSI', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.133, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-06-07', lastDate: '2026-06-26', leadNet: { '48': -20.0, '24': -10.0, '12': -20.0 } },
  { city: 'taipei', display: 'Taipei', icao: 'RCSS', bets: 2, daysActive: 2, won: 0, lost: 2, winPct: 0.0, winCi: [0.0, 65.8], avgAsk: 0.132, staked: 20.0, netUsd: -20.0, roiPct: -100.0, firstDate: '2026-05-25', lastDate: '2026-06-24', leadNet: { '48': -20.0, '24': -10.0, '12': -20.0 } },
  { city: 'cape-town', display: 'Cape Town', icao: 'FACT', bets: 3, daysActive: 3, won: 0, lost: 3, winPct: 0.0, winCi: [0.0, 56.2], avgAsk: 0.131, staked: 30.0, netUsd: -30.0, roiPct: -100.0, firstDate: '2026-06-10', lastDate: '2026-06-25', leadNet: { '48': -20.0, '12': -30.0 } },
  { city: 'toronto', display: 'Toronto', icao: 'CYYZ', bets: 4, daysActive: 4, won: 0, lost: 4, winPct: 0.0, winCi: [0.0, 49.0], avgAsk: 0.133, staked: 40.0, netUsd: -40.0, roiPct: -100.0, firstDate: '2026-05-16', lastDate: '2026-06-28', leadNet: { '48': -20.0, '24': -30.0, '12': -40.0 } },
  ],
};
