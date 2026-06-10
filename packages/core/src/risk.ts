/**
 * core/risk — circuit breakers, exposure aggregation, clusters (ARCHITECTURE.md §6.8).
 */
import type { RiskConfig } from './types.ts';

export interface BreakerStats {
  consecutiveLossesByCityLead: Map<string, number>;
  dailyPnlPct: number;
  drawdownPct: number;
  rollingBrierByCity: Map<string, number>;
  freshestForecastAgeH: number;
  freshestPriceAgeMin: number;
}

/**
 * Pure evaluation of every circuit-breaker rule (F-027); returns the halts to
 * apply. Each rule fires AT exactly its threshold: 8 consecutive losses,
 * −5% day, 25% drawdown, rolling Brier 0.30, forecast staleness 30h, price
 * staleness 30min.
 */
export function evaluateBreakers(
  stats: BreakerStats,
  cfg: RiskConfig,
): { scope: string; reason: string }[] {
  const halts: { scope: string; reason: string }[] = [];

  for (const [cityLead, losses] of stats.consecutiveLossesByCityLead) {
    if (losses >= cfg.breakerConsecLosses) {
      halts.push({
        scope: `city_lead:${cityLead}`,
        reason: `${losses} consecutive losses ≥ ${cfg.breakerConsecLosses}`,
      });
    }
  }

  if (stats.dailyPnlPct <= -cfg.breakerDailyLossPct) {
    halts.push({
      scope: 'global',
      reason: `daily P&L ${(stats.dailyPnlPct * 100).toFixed(1)}% ≤ −${cfg.breakerDailyLossPct * 100}%`,
    });
  }

  if (stats.drawdownPct >= cfg.breakerDrawdownPct) {
    halts.push({
      scope: 'global',
      reason: `drawdown ${(stats.drawdownPct * 100).toFixed(1)}% ≥ ${cfg.breakerDrawdownPct * 100}%`,
    });
  }

  for (const [city, brier] of stats.rollingBrierByCity) {
    if (brier >= cfg.breakerBrier) {
      halts.push({ scope: `city:${city}`, reason: `rolling Brier ${brier} ≥ ${cfg.breakerBrier}` });
    }
  }

  if (stats.freshestForecastAgeH >= cfg.staleForecastHaltH) {
    halts.push({
      scope: 'global',
      reason: `freshest forecast ${stats.freshestForecastAgeH}h old ≥ ${cfg.staleForecastHaltH}h (dead-man)`,
    });
  }

  if (stats.freshestPriceAgeMin >= cfg.stalePriceHaltMin) {
    halts.push({
      scope: 'global',
      reason: `freshest price ${stats.freshestPriceAgeMin}min old ≥ ${cfg.stalePriceHaltMin}min`,
    });
  }

  return halts;
}

export interface OpenBet {
  eventId: string;
  citySlug: string;
  cluster: string;
  stakeUsd: number;
  targetDate: string;
}

/** Aggregates feeding applyRiskCaps ctx and the dashboard ExposureBar (bankrollUsd kept for utilization rendering). */
export function exposureSummary(
  openBets: OpenBet[],
  bankrollUsd: number,
): { byEvent: Map<string, number>; byCluster: Map<string, number>; byDay: Map<string, number>; bankrollUsd: number } {
  const byEvent = new Map<string, number>();
  const byCluster = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const bet of openBets) {
    byEvent.set(bet.eventId, (byEvent.get(bet.eventId) ?? 0) + bet.stakeUsd);
    byCluster.set(bet.cluster, (byCluster.get(bet.cluster) ?? 0) + bet.stakeUsd);
    byDay.set(bet.targetDate, (byDay.get(bet.targetDate) ?? 0) + bet.stakeUsd);
  }
  return { byEvent, byCluster, byDay, bankrollUsd };
}

/**
 * Correlated-exposure cluster key = the city's seeded region (one of the 12
 * §6.8 cluster keys: europe-west, europe-east, east-asia, south-asia,
 * southeast-asia, mideast, africa, na-east, na-central, na-west, latam,
 * oceania — FK-enforced in the DB).
 */
export function clusterOf(city: { region: string }): string {
  return city.region;
}

const COUNTRY_REGION: Record<string, string> = {
  GB: 'europe-west', IE: 'europe-west', FR: 'europe-west', ES: 'europe-west', PT: 'europe-west',
  DE: 'europe-west', NL: 'europe-west', BE: 'europe-west', IT: 'europe-west', CH: 'europe-west',
  AT: 'europe-west', DK: 'europe-west', NO: 'europe-west', SE: 'europe-west',
  FI: 'europe-east', PL: 'europe-east', CZ: 'europe-east', HU: 'europe-east', RO: 'europe-east',
  GR: 'europe-east', TR: 'europe-east', UA: 'europe-east', RU: 'europe-east', RS: 'europe-east',
  KR: 'east-asia', JP: 'east-asia', CN: 'east-asia', TW: 'east-asia', HK: 'east-asia', MN: 'east-asia',
  IN: 'south-asia', PK: 'south-asia', BD: 'south-asia', LK: 'south-asia', NP: 'south-asia',
  SG: 'southeast-asia', TH: 'southeast-asia', VN: 'southeast-asia', MY: 'southeast-asia',
  ID: 'southeast-asia', PH: 'southeast-asia', KH: 'southeast-asia', MM: 'southeast-asia',
  AE: 'mideast', SA: 'mideast', QA: 'mideast', KW: 'mideast', BH: 'mideast', OM: 'mideast',
  IL: 'mideast', JO: 'mideast', IQ: 'mideast', IR: 'mideast', LB: 'mideast',
  EG: 'africa', ZA: 'africa', NG: 'africa', KE: 'africa', MA: 'africa', GH: 'africa',
  ET: 'africa', TZ: 'africa', DZ: 'africa', TN: 'africa',
  MX: 'latam', BR: 'latam', AR: 'latam', CL: 'latam', CO: 'latam', PE: 'latam',
  VE: 'latam', EC: 'latam', UY: 'latam', PA: 'latam',
  AU: 'oceania', NZ: 'oceania', FJ: 'oceania',
};

/**
 * Cluster-region assignment for NEWLY DISCOVERED cities (§6.13). The §6.8
 * regions are "seeded", but the architecture defines no assignment rule for a
 * brand-new city — this documented heuristic covers it: country lookup, with
 * the US/CA split (and unknown countries) resolved by UTC offset. New cities
 * are betting-disabled until operator verification, so a misassignment only
 * affects cluster caps after a human has already looked at the city.
 */
export function regionForCity(countryCode: string, utcOffsetHours: number): string {
  const cc = countryCode.toUpperCase();
  if (cc === 'US' || cc === 'CA') {
    if (utcOffsetHours <= -7) return 'na-west';
    if (utcOffsetHours <= -6) return 'na-central';
    return 'na-east';
  }
  const mapped = COUNTRY_REGION[cc];
  if (mapped) return mapped;
  // Unknown country: coarse offset bands.
  if (utcOffsetHours <= -3) return 'latam';
  if (utcOffsetHours <= 3) return 'europe-west';
  if (utcOffsetHours <= 4.5) return 'mideast';
  if (utcOffsetHours <= 6.5) return 'south-asia';
  if (utcOffsetHours <= 7.5) return 'southeast-asia';
  if (utcOffsetHours <= 10) return 'east-asia';
  return 'oceania';
}

/** Valid provisional IANA zone for a fixed UTC offset (Etc zones invert the sign: UTC+9 → Etc/GMT-9). */
export function etcZoneForOffset(hours: number): string {
  const whole = Math.round(hours);
  if (whole === 0) return 'Etc/GMT';
  return whole > 0 ? `Etc/GMT-${whole}` : `Etc/GMT+${Math.abs(whole)}`;
}
