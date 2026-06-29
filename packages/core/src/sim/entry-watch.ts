/**
 * core/sim/entry-watch — the paper-trade ENTRY-TIME WATCHER (pure, reproducible).
 *
 * The multi-city paper-trade (sim/city, migration 0070) races a fixed set of intraday lock hours as arms
 * (e.g. 10/11/12/13/14/15 local). Those hours were chosen a priori — before any forward data existed — so
 * "which hour is the best time to bet" must now be answered FROM the accumulated, continuously-growing
 * ledger of graded bets, not from the initial guess. This module is that answer: given each arm's graded
 * (won, ask) bets it ranks the arms and recommends the optimal entry hour, with an honest confidence that
 * refuses to chase a 2-sample fluke.
 *
 * WHY edgeCiLo IS THE RANKING METRIC. The arm's headline skill is the paired gap `won − ask` (armEdgeStats
 * — the low-variance "did our bucket beat the price we paid" signal). We rank on its 95% LOWER bound
 * (edgeCiLo), not the point estimate: a thin arm with a lucky +edge has a wide CI and a low lower bound, so
 * it cannot out-rank a deep arm with a smaller-but-tight edge. Ranking on the lower confidence bound IS the
 * shrinkage — small-n is penalized by construction, no separate prior needed (the same discipline the §9R-E
 * gate and the dashboard CIs already use).
 *
 * The watcher RECOMMENDS; it does not prune. While the sim runs on fictive money the right move is to keep
 * racing every arm (free data) and surface the evolving verdict — never silently drop an arm and lose the
 * comparison. confidence='sufficient' is the operator's cue that an arm has earned promotion; 'insufficient'
 * means keep gathering. Pure + total: junk/empty → an INSUFFICIENT result, never a throw.
 */
import { armEdgeStats, type GradedBet } from './stats.ts';

/** One arm's graded bets, keyed by its local lock hour. */
export interface ArmGradedBets {
  hour: number;
  bets: GradedBet[];
}

/** The per-arm watcher row (the arm's edge stats + its standing in the race). */
export interface WatchedArm {
  hour: number;
  nGraded: number;
  hitRate: number;
  /** mean (won − ask) — the low-variance headline edge. */
  edge: number;
  edgeCiLo: number;
  edgeCiHi: number;
  /** mean realised EV per $1 staked, fee-free. */
  ev: number;
  /** the value the recommendation ranks on (= edgeCiLo); NaN when the arm has no graded bets. */
  score: number;
  /** nGraded ≥ minGraded — enough data to be a credible recommendation. */
  eligible: boolean;
  /** 1 = best by score among ELIGIBLE arms; null when not eligible. */
  rank: number | null;
  recommended: boolean;
}

export type WatchConfidence = 'sufficient' | 'provisional' | 'insufficient';

export interface EntryWatchResult {
  /** the optimal entry hour to prefer; null only when no arm has a single graded bet. */
  recommendedHour: number | null;
  confidence: WatchConfidence;
  /** arms sorted by hour (for display); each carries its rank + recommended flag. */
  arms: WatchedArm[];
  minGraded: number;
  /** a one-line human verdict for the dashboard tile + the daily tick log. */
  rationale: string;
}

export interface EntryWatchOpts {
  /** min graded bets for an arm to be ELIGIBLE for a confident recommendation (default 10). */
  minGraded?: number;
  /** forwarded to armEdgeStats for the reproducible EV bootstrap CI. */
  bootstrapSeed?: number;
}

export const ENTRY_WATCH_MIN_GRADED = 10;

const pp = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}pp`;

/**
 * Rank the raced arms and recommend the optimal entry hour from the graded ledger.
 *
 * Confidence ladder:
 *   - insufficient — no arm has ≥ minGraded graded bets. recommendedHour is the best point-estimate hint
 *     among arms with any graded bet (or null if none), but the message is "keep racing".
 *   - sufficient   — the leader (max edgeCiLo among eligible arms) is CREDIBLE (edgeCiLo > 0) AND SEPARATED
 *     (its conservative lower bound beats every other eligible arm's edge point estimate; a lone eligible
 *     arm is trivially separated). This is the cue that the hour has earned promotion.
 *   - provisional  — eligible arms exist but the leader is not yet credible-and-separated (best available,
 *     keep racing).
 */
export function recommendEntryHour(arms: ArmGradedBets[], opts: EntryWatchOpts = {}): EntryWatchResult {
  const minGraded = opts.minGraded ?? ENTRY_WATCH_MIN_GRADED;
  const input = (Array.isArray(arms) ? arms : []).filter((a) => a && Number.isFinite(a.hour));

  const rows: WatchedArm[] = input.map((a) => {
    const s = armEdgeStats(Array.isArray(a.bets) ? a.bets : [], { bootstrapSeed: opts.bootstrapSeed });
    return {
      hour: a.hour,
      nGraded: s.nGraded,
      hitRate: s.hitRate,
      edge: s.edge,
      edgeCiLo: s.edgeCiLo,
      edgeCiHi: s.edgeCiHi,
      ev: s.ev,
      score: s.edgeCiLo,
      eligible: s.nGraded >= minGraded,
      rank: null,
      recommended: false,
    };
  });

  // rank ELIGIBLE arms by score (edgeCiLo) desc; ties broken by the earlier hour (deterministic + cheap entry).
  const eligible = rows
    .filter((r) => r.eligible && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score || a.hour - b.hour);
  eligible.forEach((r, i) => (r.rank = i + 1));

  const byHour = [...rows].sort((a, b) => a.hour - b.hour);
  const result = (recommendedHour: number | null, confidence: WatchConfidence, rationale: string): EntryWatchResult => {
    for (const r of rows) r.recommended = recommendedHour != null && r.hour === recommendedHour;
    return { recommendedHour, confidence, arms: byHour, minGraded, rationale };
  };

  if (eligible.length === 0) {
    // no arm is deep enough yet — surface the best point-estimate hint, but tell the operator to keep racing.
    const graded = rows.filter((r) => r.nGraded > 0 && Number.isFinite(r.edge));
    const maxN = rows.reduce((m, r) => Math.max(m, r.nGraded), 0);
    if (graded.length === 0) {
      return result(null, 'insufficient', `Insufficient data — no graded bets yet across ${rows.length} arms; keep racing.`);
    }
    const hint = [...graded].sort((a, b) => b.edge - a.edge || a.hour - b.hour)[0]!;
    return result(
      hint.hour,
      'insufficient',
      `Insufficient data — no arm has ≥${minGraded} graded bets yet (max ${maxN}). Leaning ${hint.hour}:00 ` +
        `(edge ${pp(hint.edge)}, n=${hint.nGraded}); keep racing all arms.`,
    );
  }

  const leader = eligible[0]!;
  const others = eligible.slice(1);
  const credible = leader.edgeCiLo > 0;
  const separated = others.length === 0 || leader.edgeCiLo >= Math.max(...others.map((o) => o.edge));

  if (credible && separated) {
    const tail = others.length === 0 ? 'the only arm with enough data' : `clear of ${others.length} other eligible arm(s)`;
    return result(
      leader.hour,
      'sufficient',
      `Best entry ${leader.hour}:00 — edge ${pp(leader.edge)} [${pp(leader.edgeCiLo)}, ${pp(leader.edgeCiHi)}] ` +
        `over ${leader.nGraded} graded bets, ${tail}.`,
    );
  }

  const why = !credible
    ? `edge not yet credibly > 0 (lower bound ${pp(leader.edgeCiLo)})`
    : `not yet separated from the field (${others.map((o) => `${o.hour}:00`).join('/')})`;
  return result(
    leader.hour,
    'provisional',
    `Leaning ${leader.hour}:00 (best of ${eligible.length} arms with ≥${minGraded} bets, edge ${pp(leader.edge)}) ` +
      `but ${why}; keep racing.`,
  );
}
