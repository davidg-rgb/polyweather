/**
 * packages/trading — executor boundary types (ARCHITECTURE.md §6.20, ADR-10).
 */

/**
 * Narrow data-access port — structurally identical to functions/_shared
 * DbPort, redeclared here so the package depends on nothing above it
 * (supabasePort and the PGlite test twin both satisfy it).
 */
export interface TradingDb {
  rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]>;
  getConfigRows(): Promise<{ key: string; value: string }[]>;
}

/** Minimal alert shape — structurally compatible with _shared/slack notifySlack. */
export interface TradeAlert {
  kind: string;
  severity: 'INFO' | 'ACTION' | 'WARN' | 'CRITICAL';
  title: string;
  body: string;
  dedupeKey?: string;
}

/** The bets row + stored book/audit fields execute-bet loads via bet_for_execution. */
export interface ApprovedBet {
  betId: string;
  status: string;
  mode: 'paper' | 'live';
  eventId: string;
  eventSlug: string;
  citySlug: string;
  label: string;
  tokenYes: string;
  feeRate: number;
  minOrderSize: number;
  tickSize: number | null;
  /** The recommendation's walked stored ask (§6.7 executableAsk at rec time). */
  execAsk: number;
  recShares: number;
  recStakeUsd: number;
  recommendedAt: string;
  notes: string | null;
}

export interface FillResult {
  price: number;
  /** Live resting GTC (posted, unmatched) reports shares 0 — §6.20 "record resting state". */
  shares: number;
  feeUsd: number;
  mode: 'paper' | 'live';
}

export interface TradeExecutor {
  readonly mode: 'paper' | 'live';
  place(bet: ApprovedBet): Promise<FillResult>;
  /**
   * Live phase: pulls a resting GTC order — reached ONLY via execute-bet
   * {action:'cancel'} (§6.20a, the chokepoint). Paper: no-op (no resting orders).
   */
  cancel(betId: string): Promise<void>;
}

/** fill_bet_with_caps jsonb result (0019). caps present on every outcome (parity test). */
export interface FillRpcResult {
  outcome: 'filled' | 'caps' | 'bad_status' | 'not_found';
  price?: number;
  shares?: number;
  feeUsd?: number;
  stakeUsd?: number;
  details?: string[];
  status?: string;
  caps?: {
    bankroll: number;
    perTradeCap: number;
    eventOpen: number;
    eventHeadroom: number;
    clusterOpen: number;
    clusterHeadroom: number;
    dayOpen: number;
    dayHeadroom: number;
  };
}
