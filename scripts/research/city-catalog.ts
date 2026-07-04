/**
 * scripts/research/city-catalog — the committed 45-city universe (slug · ICAO · coords · IANA tz) the
 * ERA5 peak-hour climatology is built over. This is the D5-lane INPUT catalog; the OUTPUT is the emitted
 * asset packages/core/src/sim/city-climatology.ts.
 *
 * PROVENANCE (read before trusting a coordinate):
 *   - The city SET and IANA timezones are lifted VERBATIM from the two committed migrations that correct the
 *     discovered cities' zones to real DST-aware IANA names: supabase/migrations/0066_opening_convergence.sql
 *     (the 10 §9R "trade" cities: amsterdam/chengdu/manila/qingdao/madrid/guangzhou/kuala-lumpur/beijing/
 *     shanghai/paris) + 0067_opening_capture_universe_tz.sql (the 35 remaining calibration ∩ Polymarket-
 *     listable cities). 10 + 35 = 45 — the same "check-many" universe the opening-capture layer and the
 *     45-city scan (core/sim/city-scan-results.ts) use. Timezones here MUST equal those migrations.
 *   - The ICAO + lat/lon are each city's PRIMARY weather station (the metropolitan international/urban airport
 *     the daily-Tmax market and the sim's `city_stations`/`stations` rows key on). The live coordinates live
 *     only in the DB (seeded at runtime from OurAirports via scripts/seed-stations.ts — nothing lat/lon is
 *     committed anywhere in the repo), and this lane has NO DB access, so they are committed HERE from the
 *     stations' published positions. Two are cross-checked against the committed city-scan record
 *     (ankara→LTAC, houston→KHOU); the rest are the standard primary station per city.
 *   - WHY airport-vs-exact-station drift is immaterial: ERA5 is a ~25 km reanalysis grid, and the peak-HOUR-of-
 *     daily-max distribution is a function of latitude / longitude / season, not the metre-scale siting. A
 *     20–40 km intra-metro station shift lands in the same or an adjacent grid cell and does not move the
 *     hour-of-day shape. The emitted asset is DISPLAY-ONLY on /paper-trade (peak hour + floor confidence); it
 *     touches no sim / bet / entry-watch math. Provenance is documented, nothing is fabricated.
 *
 * No DB, no network at import — a plain committed table.
 */

/** One city in the ERA5 climatology universe. */
export interface CatalogCity {
  /** Polymarket/discovery slug — the join key to city_sim_config + the /paper-trade loader (city.slug). */
  slug: string;
  /** Primary station ICAO (cache key + display; matches the sim's city_stations where known). */
  icao: string;
  /** Human display name. */
  name: string;
  /** Station latitude (°, +N/−S). */
  lat: number;
  /** Station longitude (°, +E/−W). */
  lon: number;
  /** DST-aware IANA timezone — VERBATIM from migration 0066/0067. */
  tz: string;
}

/**
 * The 45 committed cities. Order: the 10 §9R trade cities (0066) then the 35 capture-universe cities (0067),
 * alphabetical within each block for a stable diff.
 */
export const CITY_CATALOG: CatalogCity[] = [
  // ── 0066 · the 10 §9R "trade" cities ───────────────────────────────────────────────────────────────────
  { slug: 'amsterdam', icao: 'EHAM', name: 'Amsterdam Schiphol', lat: 52.3086, lon: 4.7639, tz: 'Europe/Amsterdam' },
  { slug: 'beijing', icao: 'ZBAA', name: 'Beijing Capital', lat: 40.0801, lon: 116.5846, tz: 'Asia/Shanghai' },
  { slug: 'chengdu', icao: 'ZUUU', name: 'Chengdu Shuangliu', lat: 30.5785, lon: 103.9471, tz: 'Asia/Shanghai' },
  { slug: 'guangzhou', icao: 'ZGGG', name: 'Guangzhou Baiyun', lat: 23.3924, lon: 113.2988, tz: 'Asia/Shanghai' },
  { slug: 'kuala-lumpur', icao: 'WMKK', name: 'Kuala Lumpur Intl', lat: 2.7456, lon: 101.7099, tz: 'Asia/Kuala_Lumpur' },
  { slug: 'madrid', icao: 'LEMD', name: 'Madrid Barajas', lat: 40.4936, lon: -3.5668, tz: 'Europe/Madrid' },
  { slug: 'manila', icao: 'RPLL', name: 'Manila Ninoy Aquino', lat: 14.5086, lon: 121.0195, tz: 'Asia/Manila' },
  { slug: 'paris', icao: 'LFPG', name: 'Paris Charles de Gaulle', lat: 49.0097, lon: 2.5479, tz: 'Europe/Paris' },
  { slug: 'qingdao', icao: 'ZSQD', name: 'Qingdao Liuting', lat: 36.2661, lon: 120.3744, tz: 'Asia/Shanghai' },
  { slug: 'shanghai', icao: 'ZSPD', name: 'Shanghai Pudong', lat: 31.1443, lon: 121.8083, tz: 'Asia/Shanghai' },

  // ── 0067 · the 35 capture-universe cities ──────────────────────────────────────────────────────────────
  { slug: 'ankara', icao: 'LTAC', name: 'Ankara Esenboga', lat: 40.1281, lon: 32.9951, tz: 'Europe/Istanbul' },
  { slug: 'atlanta', icao: 'KATL', name: 'Atlanta Hartsfield', lat: 33.6367, lon: -84.4281, tz: 'America/New_York' },
  { slug: 'austin', icao: 'KAUS', name: 'Austin Bergstrom', lat: 30.1975, lon: -97.6664, tz: 'America/Chicago' },
  { slug: 'buenos-aires', icao: 'SAEZ', name: 'Buenos Aires Ezeiza', lat: -34.8222, lon: -58.5358, tz: 'America/Argentina/Buenos_Aires' },
  { slug: 'busan', icao: 'RKPK', name: 'Busan Gimhae', lat: 35.1795, lon: 128.9382, tz: 'Asia/Seoul' },
  { slug: 'cape-town', icao: 'FACT', name: 'Cape Town Intl', lat: -33.9648, lon: 18.6017, tz: 'Africa/Johannesburg' },
  { slug: 'chicago', icao: 'KORD', name: "Chicago O'Hare", lat: 41.9786, lon: -87.9048, tz: 'America/Chicago' },
  { slug: 'chongqing', icao: 'ZUCK', name: 'Chongqing Jiangbei', lat: 29.7192, lon: 106.6417, tz: 'Asia/Shanghai' },
  { slug: 'dallas', icao: 'KDFW', name: 'Dallas/Fort Worth', lat: 32.8968, lon: -97.0380, tz: 'America/Chicago' },
  { slug: 'denver', icao: 'KDEN', name: 'Denver Intl', lat: 39.8617, lon: -104.6731, tz: 'America/Denver' },
  { slug: 'helsinki', icao: 'EFHK', name: 'Helsinki Vantaa', lat: 60.3172, lon: 24.9633, tz: 'Europe/Helsinki' },
  { slug: 'houston', icao: 'KHOU', name: 'Houston Hobby', lat: 29.6454, lon: -95.2789, tz: 'America/Chicago' },
  { slug: 'jeddah', icao: 'OEJN', name: 'Jeddah King Abdulaziz', lat: 21.6796, lon: 39.1565, tz: 'Asia/Riyadh' },
  { slug: 'karachi', icao: 'OPKC', name: 'Karachi Jinnah', lat: 24.9065, lon: 67.1608, tz: 'Asia/Karachi' },
  { slug: 'london', icao: 'EGLL', name: 'London Heathrow', lat: 51.4706, lon: -0.4619, tz: 'Europe/London' },
  { slug: 'los-angeles', icao: 'KLAX', name: 'Los Angeles Intl', lat: 33.9425, lon: -118.4081, tz: 'America/Los_Angeles' },
  { slug: 'lucknow', icao: 'VILK', name: 'Lucknow Amausi', lat: 26.7606, lon: 80.8893, tz: 'Asia/Kolkata' },
  { slug: 'mexico-city', icao: 'MMMX', name: 'Mexico City Juarez', lat: 19.4363, lon: -99.0721, tz: 'America/Mexico_City' },
  { slug: 'miami', icao: 'KMIA', name: 'Miami Intl', lat: 25.7959, lon: -80.2870, tz: 'America/New_York' },
  { slug: 'milan', icao: 'LIML', name: 'Milan Linate', lat: 45.4451, lon: 9.2767, tz: 'Europe/Rome' },
  { slug: 'munich', icao: 'EDDM', name: 'Munich Intl', lat: 48.3538, lon: 11.7861, tz: 'Europe/Berlin' },
  { slug: 'nyc', icao: 'KLGA', name: 'New York LaGuardia', lat: 40.7772, lon: -73.8726, tz: 'America/New_York' },
  { slug: 'panama-city', icao: 'MPTO', name: 'Panama City Tocumen', lat: 9.0714, lon: -79.3835, tz: 'America/Panama' },
  { slug: 'san-francisco', icao: 'KSFO', name: 'San Francisco Intl', lat: 37.6189, lon: -122.3750, tz: 'America/Los_Angeles' },
  { slug: 'sao-paulo', icao: 'SBGR', name: 'Sao Paulo Guarulhos', lat: -23.4356, lon: -46.4731, tz: 'America/Sao_Paulo' },
  { slug: 'seattle', icao: 'KSEA', name: 'Seattle-Tacoma', lat: 47.4490, lon: -122.3093, tz: 'America/Los_Angeles' },
  { slug: 'seoul', icao: 'RKSI', name: 'Seoul Incheon', lat: 37.4602, lon: 126.4407, tz: 'Asia/Seoul' },
  { slug: 'shenzhen', icao: 'ZGSZ', name: "Shenzhen Bao'an", lat: 22.6393, lon: 113.8108, tz: 'Asia/Shanghai' },
  { slug: 'singapore', icao: 'WSSS', name: 'Singapore Changi', lat: 1.3502, lon: 103.9944, tz: 'Asia/Singapore' },
  { slug: 'taipei', icao: 'RCSS', name: 'Taipei Songshan', lat: 25.0694, lon: 121.5525, tz: 'Asia/Taipei' },
  { slug: 'tokyo', icao: 'RJTT', name: 'Tokyo Haneda', lat: 35.5523, lon: 139.7798, tz: 'Asia/Tokyo' },
  { slug: 'toronto', icao: 'CYYZ', name: 'Toronto Pearson', lat: 43.6772, lon: -79.6306, tz: 'America/Toronto' },
  { slug: 'warsaw', icao: 'EPWA', name: 'Warsaw Chopin', lat: 52.1657, lon: 20.9671, tz: 'Europe/Warsaw' },
  { slug: 'wellington', icao: 'NZWN', name: 'Wellington Intl', lat: -41.3272, lon: 174.8053, tz: 'Pacific/Auckland' },
  { slug: 'wuhan', icao: 'ZHHH', name: 'Wuhan Tianhe', lat: 30.7838, lon: 114.2081, tz: 'Asia/Shanghai' },
];

/** slug → catalog city, for O(1) lookup. */
export const CITY_BY_SLUG: Map<string, CatalogCity> = new Map(CITY_CATALOG.map((c) => [c.slug, c]));

/**
 * The warm-season months (1..12) for a city, hemisphere-aware: northern May–Sep, southern Nov–Mar. The warm
 * half-year is where daily-Tmax bucket boundaries are most in play and the peak runs latest — the same lens
 * the Amsterdam climatology's "warm season" sub-period uses (amsterdam-peak-hour.ts). Near-equatorial cities
 * are ~seasonless; the northern default is harmless there (the sub-period is a display aid, not a gate).
 */
export function warmMonths(lat: number): number[] {
  return lat >= 0 ? [5, 6, 7, 8, 9] : [11, 12, 1, 2, 3];
}
