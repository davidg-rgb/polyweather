/**
 * core/polymarket/rewards — REC-4: the liquidity-rewards monitor's PURE detector
 * (MAKER-REBATE-HANDOFF.md §4 / REC-4). Polymarket's funded liquidity-reward pool is exposed at the
 * CLOB `/sampling-markets` endpoint (markets WITH active rewards). Weather is NOT in that pool today
 * (the §2 finding); if it ever is, "rest-near-mid, paid regardless of fill" becomes a real,
 * FORECAST-FREE income path (no selection skill needed). This module is the pure detector — given a
 * page of sampling-markets, find any temperature/weather market and whether its reward rates are
 * funded. The script `scripts/reward-monitor.ts` paginates the live endpoint and reports.
 *
 * Pure + total: junk/empty input → an empty result, never throws. Shapes are live-verified against the
 * 2026-06 `/sampling-markets` response (data[].{condition_id, question, market_slug, rewards, tags}).
 */

/** One funded reward rate (asset × daily rate) from `/sampling-markets` rewards.rates. */
export interface SamplingRewardRate {
  asset_address?: string;
  rewards_daily_rate?: number;
}

/** One market from CLOB `/sampling-markets` data[] (the funded-reward universe). */
export interface RawSamplingMarket {
  condition_id?: string;
  question?: string;
  market_slug?: string;
  tags?: string[];
  rewards?: { rates?: SamplingRewardRate[] | null; min_size?: number; max_spread?: number } | null;
}

/** A weather market detected in the funded-reward universe (the REC-4 hit). */
export interface WeatherRewardHit {
  conditionId: string;
  slug: string;
  question: string;
  /** True iff rewards.rates is a non-empty array (the pool is actually FUNDED, not just scaffolded). */
  funded: boolean;
  /** Sum of rewards_daily_rate across the funded rates (0 when unfunded). */
  dailyRateTotal: number;
}

/** The scan result over one or more sampling-markets pages. */
export interface RewardScanResult {
  /** Total sampling (reward-eligible) markets seen. */
  nScanned: number;
  /** Weather/temperature markets found in the sampling list. */
  weather: WeatherRewardHit[];
  /** Of those, the ones whose reward rates are actually funded. */
  fundedWeather: WeatherRewardHit[];
}

/** The canonical Polymarket temperature-event slug prefix (matches gamma.ts's event pattern, loosened). */
const TEMP_SLUG = /^(highest|lowest)-temperature-in-/i;
/** Question-text fallback (some payloads vary the slug; the question is human-readable). */
const TEMP_QUESTION = /\b(highest|lowest)\s+temperature\b|temperature\s+in\b/i;

/**
 * Is this sampling market a weather/temperature market? Slug is the canonical signal (the same shape
 * `parseGammaEvent` keys on); the question is a fallback for slug drift. Total (false on junk).
 */
export function isWeatherMarket(m: RawSamplingMarket): boolean {
  const slug = typeof m.market_slug === 'string' ? m.market_slug : '';
  const q = typeof m.question === 'string' ? m.question : '';
  if (TEMP_SLUG.test(slug)) return true;
  return TEMP_QUESTION.test(q);
}

/** Funded iff rewards.rates is a non-empty array (a market can be sampling-listed but rate-null). */
export function isFunded(m: RawSamplingMarket): boolean {
  const rates = m.rewards?.rates;
  return Array.isArray(rates) && rates.length > 0;
}

const dailyRateTotal = (m: RawSamplingMarket): number => {
  const rates = m.rewards?.rates;
  if (!Array.isArray(rates)) return 0;
  return rates.reduce((a, r) => a + (Number.isFinite(r?.rewards_daily_rate) ? r!.rewards_daily_rate! : 0), 0);
};

const toHit = (m: RawSamplingMarket): WeatherRewardHit => ({
  conditionId: typeof m.condition_id === 'string' ? m.condition_id : '',
  slug: typeof m.market_slug === 'string' ? m.market_slug : '',
  question: typeof m.question === 'string' ? m.question : '',
  funded: isFunded(m),
  dailyRateTotal: dailyRateTotal(m),
});

/**
 * Scan a set of sampling-markets (one or many pages concatenated) for weather/temperature markets and
 * whether any are funded. Pure; total — a non-array input scans nothing. This is the REC-4 verdict input:
 * `fundedWeather.length > 0` ⇒ weather has entered the funded liquidity-reward pool (the trigger).
 */
export function scanWeatherRewards(markets: RawSamplingMarket[]): RewardScanResult {
  const list = Array.isArray(markets) ? markets : [];
  const weather = list.filter(isWeatherMarket).map(toHit);
  return {
    nScanned: list.length,
    weather,
    fundedWeather: weather.filter((h) => h.funded),
  };
}
