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
