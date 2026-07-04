/**
 * packages/trading/tradeConfig — the typed reader for the 0082 trading-activation surface.
 *
 * The runner (service_role, no operator jwt) reads its risk/mode config via trade_config_get() and gates every
 * live-mode entry through trade_live_preflight(). Both RPCs return a jsonb OBJECT (0081 tripwire idiom); the
 * DbPort twin/supabasePort wrap a bare-jsonb return as [{ [fn]: value }], so this reads rows[0].<fn>.
 *
 * This module is READ-ONLY: it never places a trade or touches a key. The §9R $25 stake/position ceiling is a
 * DB CHECK (the source of truth); STAKE_CEILING_USD mirrors it for callers that want to reason about it in code.
 */
import type { TradeMode, TradingDb } from './types.ts';
export type { TradeMode } from './types.ts';

/** The §9R hard ceiling, mirrored from the trade_config CHECK (stake_per_buy_usd ≤ 25 AND per_position_cap ≤ 25). */
export const STAKE_CEILING_USD = 25;

export interface TradeConfig {
  mode: TradeMode;
  stakePerBuyUsd: number;
  perPositionCapUsd: number;
  perMarketCapUsd: number;
  totalConcurrentCapUsd: number;
  dailyLossKillUsd: number;
  dailyLossKillFrac: number;
  /** null = every enrolled city; otherwise the allow-listed city slugs. */
  cityAllowlist: string[] | null;
  /** ISO date (yyyy-mm-dd) run-window day-cap, or null when the run window is off. */
  activeUntil: string | null;
}

export interface TradePreflight {
  /** true only when every blocking condition clears — the runner may enter live mode. */
  ok: boolean;
  /** every failed condition, verbatim (checklist semantics — never short-circuited). */
  reasons: string[];
  /**
   * The F2 per-placement cap contract: EVERY money figure is LIVE-mode only (dry-run ledger rows never
   * count). The runner enforces, per placement, from this one payload:
   *   perMarketExposureUsd[marketId] + stake ≤ perMarketCapUsd
   *   openExposureUsd + stake ≤ totalConcurrentCapUsd
   * The daily-loss kill (todayLossUsd vs dailyLossKillUsd / dailyLossKillFracBasisUsd, the frac basis being
   * total_concurrent_cap_usd) blocks the preflight itself. todayLossUsd is the N1 SHARED definition —
   * realized P&L attributed at SELL time (basis = lifetime avg cost of prior BUY fills) plus buy-side fees,
   * over the window starting at lossWindowStart (UTC midnight) — NOT within-day net cashflow.
   */
  checks: {
    mode: TradeMode;
    activeUntil: string | null;
    stakePerBuyUsd: number;
    perPositionCapUsd: number;
    perMarketCapUsd: number;
    totalConcurrentCapUsd: number;
    gatePass: boolean;
    override: boolean;
    overrideReason: string | null;
    overrideExpiresAt: string | null;
    todayLossUsd: number;
    /** N1: the start of the realized-loss window (UTC midnight), named explicitly. */
    lossWindowStart: string;
    dailyLossKillUsd: number;
    dailyLossKillFracBasisUsd: number;
    openExposureUsd: number;
    perMarketExposureUsd: Record<string, number>;
  };
}

/** Raw jsonb column shape from trade_config's to_jsonb() (snake_case, numerics as strings over PostgREST). */
interface RawTradeConfig {
  mode: TradeMode;
  stake_per_buy_usd: number | string;
  per_position_cap_usd: number | string;
  per_market_cap_usd: number | string;
  total_concurrent_cap_usd: number | string;
  daily_loss_kill_usd: number | string;
  daily_loss_kill_frac: number | string;
  city_allowlist: string[] | null;
  active_until: string | null;
}

const num = (x: number | string): number => (typeof x === 'number' ? x : Number(x));

function mapConfig(raw: RawTradeConfig): TradeConfig {
  return {
    mode: raw.mode,
    stakePerBuyUsd: num(raw.stake_per_buy_usd),
    perPositionCapUsd: num(raw.per_position_cap_usd),
    perMarketCapUsd: num(raw.per_market_cap_usd),
    totalConcurrentCapUsd: num(raw.total_concurrent_cap_usd),
    dailyLossKillUsd: num(raw.daily_loss_kill_usd),
    dailyLossKillFrac: num(raw.daily_loss_kill_frac),
    cityAllowlist: raw.city_allowlist ?? null,
    activeUntil: raw.active_until ?? null,
  };
}

/** Load the single-row trade_config via the service-role trade_config_get() RPC. Throws if the row is missing. */
export async function loadTradeConfig(db: TradingDb): Promise<TradeConfig> {
  const [row] = await db.rpc<{ trade_config_get: { config: RawTradeConfig | null } }>('trade_config_get', {});
  const raw = row?.trade_config_get?.config;
  if (!raw) throw new Error('trade_config_get returned no config row (0082 not applied?)');
  return mapConfig(raw);
}

/**
 * The live-mode INTERLOCK wrapper. Call before entering live mode; act only when `.ok` is true. Never
 * short-circuits — `.reasons` lists every blocking condition so the operator sees the full picture at once.
 */
export async function preflightLive(db: TradingDb): Promise<TradePreflight> {
  const [row] = await db.rpc<{ trade_live_preflight: TradePreflight }>('trade_live_preflight', {});
  const pf = row?.trade_live_preflight;
  if (!pf) throw new Error('trade_live_preflight returned no verdict (0082 not applied?)');
  return {
    ok: pf.ok === true,
    reasons: pf.reasons ?? [],
    checks: pf.checks,
  };
}
