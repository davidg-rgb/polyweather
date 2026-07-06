/**
 * core/sim/city-promotion — continuous winner-promotion board for the multi-city paper-trade (CITY-LIVE Lane P).
 *
 * The multi-city paper-trade (sim/city, migration 0070) races ~45 cities, each betting a fixed daily stake on its
 * predicted bucket across a set of intraday arm hours. This module reduces that continuously-growing graded ledger
 * to a ranked board that FRONTS the winners: for each city it recommends the best entry hour (reusing the
 * entry-watch ranking discipline), scores THAT recommended arm's edge, and assigns a promotion status. The board is
 * ADVISORY — the operator's per-city Live toggle in /trading is the sole authorization to trade (spec §0); PROMOTED
 * is a cue, never a gate.
 *
 * HONEST-MEASUREMENT CAVEAT (spec §0, carried into the criteria, not bolted on). A point-estimate leader of a
 * 45-city race (e.g. Karachi today) is exactly what a selection effect produces even under the null of zero real
 * edge — the winner of N noisy races looks good by construction. The mitigations are structural: we rank on the
 * recommended arm's 95% LOWER confidence bound (edgeCiLo, via armEdgeStats — a thin lucky arm has a wide CI and a
 * low bound, so it cannot out-rank a deep tight one), and we gate PROMOTED behind hard sample floors (≥20 graded
 * bets AND ≥10 distinct days) plus entry-watch's own credible-and-separated 'sufficient' verdict. Even then,
 * promotion is only a recommendation; the operator-toggled live forward test is the real gate.
 *
 * STATISTICS ARE REUSED, NOT REIMPLEMENTED. `recommendEntryHour` (entry-watch) picks the arm + confidence exactly
 * as the /paper-trade watcher does; `armEdgeStats` (stats) computes the recommended arm's paired-gap (won − ask)
 * edge + CI. `edge/edgeCiLo/edgeCiHi` on each row are the RECOMMENDED arm's stats ONLY — that is the single arm a
 * live test would actually run, so the promotion verdict is scored on the thing that would trade, not a blend.
 *
 * Pure + total + deterministic: no Date.now (asOf is passed in), no I/O; junk/empty input yields an INSUFFICIENT
 * row (or an empty board), never a throw. armEdgeStats's EV bootstrap uses its default fixed seed, so the board is
 * byte-identical across runs.
 *
 * NOTE — spec-literal redundancies, kept intentionally (flagged, not silently dropped):
 *   - `PROMOTED = eligible AND edgeCiLo > 0`: eligibility already requires entry-watch confidence 'sufficient',
 *     which itself requires the recommended (leader) arm's edgeCiLo > 0 — so the `edgeCiLo > 0` clause never
 *     changes the outcome given 'sufficient'. Kept verbatim from the spec as defence-in-depth (survives a future
 *     loosening of the 'sufficient' definition).
 *   - `DEMOTED … (edgeCiLo < 0 OR (point edge < 0 AND nBets ≥ 20))`: the second disjunct is a subset of the first
 *     (edge < 0 ⟹ edgeCiLo ≤ edge < 0), so it too is redundant. Kept verbatim from the spec.
 */
import { armEdgeStats, type GradedBet } from './stats.ts';
import { recommendEntryHour, type ArmGradedBets } from './entry-watch.ts';

export type CityPromotionStatus = 'PROMOTED' | 'WATCH' | 'INSUFFICIENT' | 'DEMOTED';

export interface CityPromotionInput {
  /** ISO timestamp the board is stamped with; passed in so the engine stays pure (no Date.now). */
  asOf: string;
  cities: Array<{
    cityId: string;
    slug: string;
    icao: string;
    unit: 'C' | 'F';
    /** graded bets only (won/ask decided, P&L booked). */
    bets: Array<{ won: boolean; ask: number; targetDate: string; armHour: number; pnlUsd: number; stakeUsd: number }>;
    /** the city's status on the PREVIOUS board — for DEMOTED hysteresis (a once-PROMOTED city that decays). */
    prevStatus?: CityPromotionStatus;
  }>;
}

export interface CityPromotionRow {
  cityId: string;
  slug: string;
  icao: string;
  /** city-total graded bets in the ledger. */
  nBets: number;
  /** distinct targetDate across the city's bets. */
  nDays: number;
  /** Σ pnlUsd across the city's bets. */
  netPnlUsd: number;
  /** the entry-watch-recommended arm hour a live test would run; null when the city has no graded bets. */
  recommendedHour: number | null;
  watchConfidence: 'insufficient' | 'provisional' | 'sufficient';
  /** the RECOMMENDED arm's paired-gap (won − ask) stats; null when no arm has a graded bet. */
  edge: number | null;
  edgeCiLo: number | null;
  edgeCiHi: number | null;
  status: CityPromotionStatus;
  /** human-readable justification for the status + any failed floor (e.g. "nDays 6 < 10"). Always non-empty. */
  reasons: string[];
}

export interface CityPromotionBoard {
  asOf: string;
  rows: CityPromotionRow[];
}

/** City-total graded-bet floor for eligibility. */
export const CITY_PROMOTION_MIN_BETS = 20;
/** Distinct-day floor for eligibility. */
export const CITY_PROMOTION_MIN_DAYS = 10;

/** Ranking precedence: PROMOTED first, then WATCH, INSUFFICIENT, and finally the sticky-informative DEMOTED. */
const STATUS_ORDER: Record<CityPromotionStatus, number> = { PROMOTED: 0, WATCH: 1, INSUFFICIENT: 2, DEMOTED: 3 };

type CityInput = CityPromotionInput['cities'][number];

const pp = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}pp`;

const finiteOrNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** desc by edgeCiLo, nulls last — the same lower-bound-first discipline entry-watch ranks arms on. */
function cmpEdgeCiLoDesc(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

/** locale-independent slug asc — deterministic across environments (localeCompare is not). */
function cmpSlug(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reduce one city's graded ledger to a promotion row: recommend its best entry hour (entry-watch), score that
 * arm's edge (armEdgeStats), and classify. Total — a degenerate/empty city becomes an INSUFFICIENT row.
 */
function evaluateCity(c: CityInput): CityPromotionRow {
  const bets = (Array.isArray(c.bets) ? c.bets : []).filter((b) => b && typeof b.won === 'boolean');
  const nBets = bets.length;
  const nDays = new Set(bets.map((b) => b.targetDate).filter((d) => typeof d === 'string' && d.length > 0)).size;
  const netPnlUsd = bets.reduce((s, b) => s + (Number.isFinite(b.pnlUsd) ? b.pnlUsd : 0), 0);

  // Group by arm hour → entry-watch arms; recommend the best hour with its confidence.
  const armMap = new Map<number, GradedBet[]>();
  for (const b of bets) {
    if (!Number.isFinite(b.armHour)) continue;
    const arr = armMap.get(b.armHour) ?? [];
    arr.push(b);
    armMap.set(b.armHour, arr);
  }
  const arms: ArmGradedBets[] = [...armMap.entries()].map(([hour, hourBets]) => ({ hour, bets: hourBets }));
  const watch = recommendEntryHour(arms);
  const recommendedHour = watch.recommendedHour;
  const watchConfidence = watch.confidence;

  // Score the RECOMMENDED arm only — the single arm a live test would run.
  const recBets = recommendedHour == null ? [] : armMap.get(recommendedHour) ?? [];
  const es = armEdgeStats(recBets);
  const edge = finiteOrNull(es.edge);
  const edgeCiLo = finiteOrNull(es.edgeCiLo);
  const edgeCiHi = finiteOrNull(es.edgeCiHi);

  const eligible =
    nBets >= CITY_PROMOTION_MIN_BETS && nDays >= CITY_PROMOTION_MIN_DAYS && watchConfidence === 'sufficient';
  const ciLoPos = edgeCiLo != null && edgeCiLo > 0;
  const ciLoNeg = edgeCiLo != null && edgeCiLo < 0;
  const ptPos = edge != null && edge > 0;
  const ptNeg = edge != null && edge < 0;
  const wasPromoted = c.prevStatus === 'PROMOTED';

  let status: CityPromotionStatus;
  if (eligible && ciLoPos) status = 'PROMOTED';
  else if (wasPromoted && (ciLoNeg || (ptNeg && nBets >= CITY_PROMOTION_MIN_BETS))) status = 'DEMOTED';
  else if (ptPos) status = 'WATCH';
  else status = 'INSUFFICIENT';

  // Floors that failed — appended to every non-PROMOTED row so the verdict explains itself.
  const floors: string[] = [];
  if (nBets < CITY_PROMOTION_MIN_BETS) floors.push(`nBets ${nBets} < ${CITY_PROMOTION_MIN_BETS}`);
  if (nDays < CITY_PROMOTION_MIN_DAYS) floors.push(`nDays ${nDays} < ${CITY_PROMOTION_MIN_DAYS}`);
  if (watchConfidence !== 'sufficient') floors.push(`entry-watch ${watchConfidence} < sufficient`);

  const hour = recommendedHour == null ? '—' : `${recommendedHour}:00`;
  const reasons: string[] = [];
  if (status === 'PROMOTED') {
    reasons.push(
      `PROMOTED — recommended ${hour} edgeCiLo ${pp(edgeCiLo)} > 0 over ${nBets} bets / ${nDays} days.`,
    );
  } else if (status === 'DEMOTED') {
    const why = ciLoNeg
      ? `recommended ${hour} edgeCiLo ${pp(edgeCiLo)} < 0`
      : `recommended ${hour} point edge ${pp(edge)} < 0 with nBets ${nBets} ≥ ${CITY_PROMOTION_MIN_BETS}`;
    reasons.push(`DEMOTED (was PROMOTED) — ${why}.`);
    reasons.push(...floors);
  } else if (status === 'WATCH') {
    reasons.push(`WATCH — recommended ${hour} point edge ${pp(edge)} > 0 but not yet promotable.`);
    reasons.push(...floors);
  } else {
    reasons.push(
      recommendedHour == null
        ? 'INSUFFICIENT — no graded bets on any arm yet.'
        : `INSUFFICIENT — recommended ${hour} point edge ${pp(edge)} not > 0.`,
    );
    reasons.push(...floors);
  }

  return {
    cityId: c.cityId,
    slug: c.slug,
    icao: c.icao,
    nBets,
    nDays,
    netPnlUsd,
    recommendedHour,
    watchConfidence,
    edge,
    edgeCiLo,
    edgeCiHi,
    status,
    reasons,
  };
}

/**
 * Build the ranked promotion board from the multi-city graded ledger.
 *
 * Per city: recommend the best entry hour (entry-watch), score that arm's paired-gap edge (armEdgeStats), and
 * classify against the frozen criteria (spec §1). Rank by status precedence, then recommended-arm edgeCiLo desc
 * (nulls last), then slug asc — fully deterministic. Total: bad/empty input degrades to INSUFFICIENT rows or an
 * empty board, never a throw.
 */
export function buildCityPromotionBoard(input: CityPromotionInput): CityPromotionBoard {
  const asOf = typeof input?.asOf === 'string' ? input.asOf : '';
  const cities = Array.isArray(input?.cities) ? input.cities : [];

  const rows = cities.filter((c) => !!c && typeof c.slug === 'string').map((c) => evaluateCity(c));

  rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      cmpEdgeCiLoDesc(a.edgeCiLo, b.edgeCiLo) ||
      cmpSlug(a.slug, b.slug),
  );

  return { asOf, rows };
}
