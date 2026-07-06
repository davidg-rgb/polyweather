/**
 * scripts/lib/city-live-decide — the PURE decision spine of the CITY-LIVE taker lane (CITY-LIVE.md §3).
 *
 * The daemon (`scripts/trade-bot.ts`) runs this lane AFTER the maker-exit lane every tick. It is a thin
 * I/O shell over THIS module: it reads the enabled city arms + reconstructs each arm's predicted
 * placement (I/O), then calls `decideCityTick(state) → CityTickPlan` (PURE), then `applyCityPlan(plan,
 * executor, …)` which drives the T1 `MakerExecutor.placeTaker`. Nothing here opens a socket, reads a key,
 * or touches the DB; it maps (arms, placeInputs, openIntentKeys, preflight) → taker entry intents.
 *
 * STRATEGY = faithful TAKER replication of the multi-city paper-trade (CITY-SIM.md / CITY-LIVE.md §0): buy
 * the SAME predicted whole-native-° bucket the sim locks, at the SAME in-lock-hour ask, at the tested arm
 * hour, and HOLD TO RESOLUTION. There is NO exit management — no take-profit, no stop-loss, no time-stop
 * (that is exactly what the paper record measured; a live exit would measure something else). One entry per
 * enabled city per local trade-day.
 *
 * GATING (checklist semantics — every declined arm is surfaced with a verbatim reason, never silently
 * dropped): an entry is gated by the LIVE interlock (`trade_live_preflight('city-taker')`, live only), the
 * ≤2-enabled-city cap + the $5/day stake envelope (both SQL-enforced; re-checked here belt-and-braces per
 * §3), the in-hour local-tz rule (place ONLY within the arm hour, city-local — the same tz-hour idiom the
 * sim uses via `p_now at time zone tz`), the once-per-city/day idempotency (the ledger's partial-unique
 * `(mode, intent_key)` index is the hard stop; `openIntentKeys` is the code-side pre-check), and the venue
 * min-order floor. dry-run skips ONLY the preflight interlock (its ledger rows never post at the venue);
 * every strategy gate still applies, so a dry-run tick shadows a live tick exactly.
 *
 * STAGED-DARK (pre-0085): the whole lane is inert until migration 0085 lands. The daemon degrades to a
 * logged skip when `city_live_runner_inputs()` / `city_sim_place_inputs()` / the strategy-aware preflight
 * are absent (undefined-function), and `applyCityPlan` tolerates a reserve RPC that does not yet accept
 * `p_strategy` (the row's `strategy='city-taker'` tag rides the 0085 RPC recreation) — a staged-dark skip,
 * never a throw. NOTHING in this lane arms by itself: TRADE_MODE defaults never-live, and a live post
 * additionally needs a PASSing `trade_live_preflight('city-taker')`.
 *
 * BOUNDARY (NON-NEGOTIABLE, unchanged): Claude builds the software; the operator funds the dedicated wallet,
 * holds the signing key, and TOGGLES each city Live. This module places nothing — it maps facts to intents.
 */
import {
  isDstAwareIana,
  localHour,
  type PlaceInputs,
} from '../../packages/core/src/index.ts';
import {
  orderIntentKey,
  redactText,
  type OrderPlacementResult,
  type TakerOrderRequest,
  type TradeAlert,
  type TradeMode,
} from '../../packages/trading/src/index.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Locked envelope constants (CITY-LIVE.md §0). The DB CHECK/trigger are the source of truth; these mirror
// them so the daemon can reason in code and fail closed if a config ever drifts past them.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The ledger strategy tag for every order this lane writes (0085 `live_orders.strategy`). */
export const CITY_STRATEGY = 'city-taker';
/** The hard cap on simultaneously-enabled Live cities (SQL trigger `city_live_arms_max2` is the hard stop). */
export const CITY_MAX_ENABLED_CITIES = 2;
/** The per-city daily stake envelope in USD (SQL CHECK `stake_usd <= 5`). */
export const CITY_STAKE_CEILING_USD = 5;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Inputs — resolved by the daemon's I/O layer, consumed here as pure facts.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One enabled city arm from `city_live_runner_inputs()` (§2). */
export interface CityArm {
  cityId: string;
  slug: string;
  icao: string;
  /** the IANA station zone — the in-hour clock (fail-closed on a non-DST-aware/`Etc/*` value). */
  tz: string;
  unit: 'C' | 'F' | string;
  enabled: boolean;
  stakeUsd: number;
  /** the arm hour to enter at: the override if set, else the latest board's recommendedHour; null ⇒ skip. */
  entryHour: number | null;
}

/**
 * The day's RESOLVED predicted placement for one city — the SAME bucket/ask the sim locks (§3). The daemon
 * derives it from `city_sim_place_inputs()` run through the sim's own `planPlacements` (single source of
 * truth) for the entry-hour arm, then resolves the bucket's venue identity (conditionId/tokenYes). Keyed by
 * `cityId`; absent when the arm hour has no reconstructable market/quote this tick.
 */
export interface CityPlaceInput {
  cityId: string;
  /** conditionId of the predicted bucket's market — the idempotency-key market component. */
  marketId: string;
  /** the YES token of the predicted bucket — what the taker BUY lifts. */
  tokenId: string;
  /** station-local YYYY-MM-DD — the intent-key trade date. */
  targetDate: string;
  /** the predicted bucket index (planPlacements output; for the log). */
  bucketIdx: number;
  label: string | null;
  /** the in-lock-hour ask — the taker worst-price + the share-sizing denominator (the sim's locked odds). */
  ask: number;
  /** the market taker fee rate (0–1), booked onto the entry fill so the N1 daily-loss kill sees it. */
  feeRate?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Intents + the plan
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A faithful taker BUY entry on the predicted bucket (FAK, hold to resolution — no exit intent exists). */
export interface CityIntent {
  kind: 'city_enter';
  marketRef: string;
  cityId: string;
  req: TakerOrderRequest;
}

/** A city/arm the tick deliberately did NOT act on, with the verbatim reason (logged + tested). */
export interface CitySkip {
  ref: string;
  reason: string;
}

export interface CityTickPlan {
  intents: CityIntent[];
  skips: CitySkip[];
}

export interface CityTickState {
  now: Date;
  mode: TradeMode;
  /** the enabled city arms (`city_live_runner_inputs()` rows). */
  arms: CityArm[];
  /** the resolved predicted placements, one per city that had a reconstructable arm-hour market this tick. */
  placeInputs: CityPlaceInput[];
  /** existing OPEN entry intent keys for this mode — the code-side once/day pre-check (ledger is the hard stop). */
  openIntentKeys: ReadonlySet<string>;
  /**
   * the live interlock verdict from `trade_live_preflight('city-taker')`: true = pass, false = a real
   * negative verdict, null = not read (dry-run, OR pre-0085 the RPC is absent). In LIVE mode anything but
   * `true` blocks EVERY city post (the lane has no positions to flatten, so a block is simply "place
   * nothing"). Never gates in dry-run.
   */
  preflightOk: boolean | null;
  /** the venue min-order floor in shares (BotConfig.minOrderSizeShares, ≈5); 0 disables the floor. */
  minOrderSizeShares?: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// decideCityTick — the pure spine: (now, mode, arms, placeInputs, openIntentKeys, preflightOk) → intents.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function decideCityTick(state: CityTickState): CityTickPlan {
  const { now, mode, arms, placeInputs, openIntentKeys, preflightOk } = state;
  const minOrderSizeShares = state.minOrderSizeShares ?? 0;
  const intents: CityIntent[] = [];
  const skips: CitySkip[] = [];

  if (mode === 'off') {
    return { intents, skips: [{ ref: 'ALL', reason: 'mode_off — the city rail is inert' }] };
  }

  // LIVE interlock — a missing/false verdict blocks ALL city posts (never partial). preflightOk is null in
  // dry-run (never gates) and boolean in live. The city lane has NO exits, so a block just places nothing.
  if (mode === 'live' && preflightOk !== true) {
    const why =
      preflightOk === null
        ? "preflight_blocked — trade_live_preflight('city-taker') unavailable this tick (read failed / pre-0085 absent); no live city posts"
        : "preflight_blocked — trade_live_preflight('city-taker') returned a negative verdict; no live city posts";
    for (const a of arms) skips.push({ ref: a.cityId, reason: why });
    return { intents, skips };
  }

  // Defensive ≤2-enabled cap (SQL trigger city_live_arms_max2 is the hard stop; this guards a drifted
  // config): act on at most CITY_MAX_ENABLED_CITIES enabled arms, deterministically by slug so the SAME
  // two are chosen every tick.
  const enabled = arms
    .filter((a) => a.enabled === true && a.entryHour != null)
    .sort((x, y) => (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  const acting = enabled.slice(0, CITY_MAX_ENABLED_CITIES);
  for (const a of enabled.slice(CITY_MAX_ENABLED_CITIES)) {
    skips.push({
      ref: a.cityId,
      reason: `city_count_cap — more than ${CITY_MAX_ENABLED_CITIES} cities enabled; the SQL max-2 trigger should prevent this (defensive skip)`,
    });
  }

  const byCity = new Map(placeInputs.map((p) => [p.cityId, p]));

  for (const arm of acting) {
    const entryHour = arm.entryHour as number;

    // defensive stake envelope ($5/day; the CHECK is the source of truth).
    if (!(arm.stakeUsd > 0 && arm.stakeUsd <= CITY_STAKE_CEILING_USD + 1e-9)) {
      skips.push({ ref: arm.cityId, reason: `stake_over_envelope ($${arm.stakeUsd} > $${CITY_STAKE_CEILING_USD}/day cap)` });
      continue;
    }

    // in-hour, city-local (mirrors the sim's `p_now at time zone tz` hour). Fail-closed on a non-DST-aware
    // tz (Etc/* / junk) so a bad zone never mis-times an entry — the same stance as the convergence bot.
    if (!isDstAwareIana(arm.tz)) {
      skips.push({ ref: arm.cityId, reason: `bad_tz (${arm.tz || 'null'}) — not a DST-aware IANA zone; never placed` });
      continue;
    }
    const hourNow = localHour(arm.tz, now);
    if (hourNow !== entryHour) {
      skips.push({ ref: arm.cityId, reason: `off_hour (local ${hourNow} ≠ arm ${entryHour})` });
      continue;
    }

    const pin = byCity.get(arm.cityId);
    if (!pin) {
      skips.push({
        ref: arm.cityId,
        reason: 'no_place_input — no reconstructable predicted bucket/ask for the arm hour this tick (no market/quote, or the sim already locked it)',
      });
      continue;
    }
    if (!(pin.ask > 0 && pin.ask <= 1)) {
      skips.push({ ref: arm.cityId, reason: `unusable_ask (${pin.ask})` });
      continue;
    }

    const tradeDate = pin.targetDate;
    const intentKey = orderIntentKey({ marketId: pin.marketId, side: 'BUY', purpose: 'entry', tradeDate });
    if (openIntentKeys.has(intentKey)) {
      skips.push({ ref: arm.cityId, reason: `already_placed_today (${pin.marketId} ${tradeDate})` });
      continue;
    }

    const shares = pin.ask > 0 ? arm.stakeUsd / pin.ask : 0;
    if (minOrderSizeShares > 0 && !(shares >= minOrderSizeShares - 1e-9)) {
      skips.push({ ref: arm.cityId, reason: `below_min_size (${shares.toFixed(2)} sh < ${minOrderSizeShares})` });
      continue;
    }

    const req: TakerOrderRequest = {
      marketId: pin.marketId,
      tokenId: pin.tokenId,
      side: 'BUY',
      purpose: 'entry',
      tradeDate,
      // faithful taker replication — buy at the sim's locked ask; the real fill price (and any drift) is a
      // measured output (§0), not a slippage buffer. A FAK takes depth ≤ this and cancels the rest.
      worstPrice: pin.ask,
      size: shares,
      negRisk: true,
      strategy: CITY_STRATEGY,
      ...(fin(pin.feeRate) ? { feeRateBps: Math.round(pin.feeRate * 10_000) } : {}),
    };
    intents.push({ kind: 'city_enter', marketRef: pin.marketId, cityId: arm.cityId, req });
  }

  return { intents, skips };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// applyCityPlan — the thin driver: post each city entry via the T1 executor's TAKER FAK path. Pre-0085
// tolerance: a reserve RPC that does not yet accept `p_strategy` (or an absent object on the write path)
// surfaces as an undefined-function/undefined-column error — treated as a STAGED-DARK skip (logged WARN),
// never a throw. A genuine failure re-alerts CRITICAL and the loop CONTINUES (one bad post never strands
// the other city).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The slice of the T1 MakerExecutor this driver touches (the real executor satisfies it structurally). */
export interface CityLaneExecutor {
  readonly mode: TradeMode;
  placeTaker(req: TakerOrderRequest): Promise<OrderPlacementResult>;
}

export interface CityAppliedIntent {
  intent: CityIntent;
  result: OrderPlacementResult | null;
  error: string | null;
}

export interface CityApplyResult {
  applied: CityAppliedIntent[];
  posted: number;
  dryRun: number;
  duplicate: number;
  /** placeTaker calls tolerated as a pre-0085 staged-dark skip (undefined-function/column). */
  stagedDark: number;
  failed: number;
}

/**
 * The undefined-object error class — Postgres 42883 (undefined_function) / 42703 (undefined_column) /
 * PostgREST PGRST202, and their prose spellings. Pre-0085 the reserve RPC has no `p_strategy` overload, so
 * a `strategy='city-taker'` reserve fails one of these — the city lane treats it as staged-dark, not a
 * hard failure. Same classifier idiom as the web loaders' `isUndefinedFunctionError` (#22), kept local so
 * scripts pull no web deps.
 */
export function isMissingObjectError(message: string): boolean {
  if (/PGRST202|42883|42703/i.test(message)) return true;
  return /(could not find the function|does not exist|not exist in the schema cache|no function matches|undefined function|undefined column)/i.test(
    message,
  );
}

export async function applyCityPlan(
  plan: CityTickPlan,
  executor: CityLaneExecutor,
  notify: (a: TradeAlert) => Promise<boolean>,
  log: (entry: Record<string, unknown>) => void,
): Promise<CityApplyResult> {
  const applied: CityAppliedIntent[] = [];
  let posted = 0;
  let dryRun = 0;
  let duplicate = 0;
  let stagedDark = 0;
  let failed = 0;

  for (const intent of plan.intents) {
    try {
      const result = await executor.placeTaker(intent.req);
      applied.push({ intent, result, error: null });
      if (result.status === 'placed') posted++;
      else if (result.status === 'dry_run') dryRun++;
      else if (result.status === 'duplicate') duplicate++;
      log({
        msg: 'city-lane.intent',
        kind: intent.kind,
        marketRef: intent.marketRef,
        cityId: intent.cityId,
        status: result.status,
        side: result.side,
        purpose: result.purpose,
        limitPrice: result.limitPrice,
        size: result.size,
        sizeMatched: result.sizeMatched,
        reason: result.reason,
      });
    } catch (e) {
      const message = redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      applied.push({ intent, result: null, error: message });
      if (isMissingObjectError(message)) {
        // STAGED-DARK (pre-0085): the ledger reserve RPC does not yet accept the `strategy` tag (0085
        // recreates it). Tolerate + log a WARN; the row is not written and no venue post happened.
        stagedDark++;
        log({
          msg: 'city-lane.staged_dark_skip',
          level: 'WARN',
          kind: intent.kind,
          marketRef: intent.marketRef,
          cityId: intent.cityId,
          error: message,
          note: "city-taker ledger write is staged-dark — migration 0085 must recreate bot_order_reserve_intent with a p_strategy arg before city rows can be tagged; no order placed",
        });
        continue;
      }
      failed++;
      log({ msg: 'city-lane.intent_failed', level: 'CRITICAL', kind: intent.kind, marketRef: intent.marketRef, cityId: intent.cityId, error: message });
      await notify({
        kind: 'CITY_LANE_INTENT_FAILED',
        severity: 'CRITICAL',
        title: `city-lane entry failed: ${intent.marketRef} (${intent.cityId})`,
        body: message,
        dedupeKey: `city-lane-intent:${intent.marketRef}`,
      });
    }
  }

  return { applied, posted, dryRun, duplicate, stagedDark, failed };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// pickCityPlacement — the pure derivation of the day's predicted bucket/ask from the sim place-inputs, via
// the sim's OWN planPlacements (single source of truth for "which bucket, at what ask"), so live faithfully
// mirrors paper. The daemon runs this, then resolves the chosen bucket's venue identity (an async DB read)
// and assembles the CityPlaceInput — the identity read is kept OUT of this pure helper. Returns null when
// the entry-hour arm is not due or has no usable quote on the predicted bucket.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The (conditionId, tokenYes) identity of a predicted bucket — resolved by the daemon from market_buckets. */
export interface BucketIdentity {
  marketId: string;
  tokenId: string;
}

/** The sim's chosen placement for the entry-hour arm — everything but the venue identity (resolved after). */
export interface CityPlacementPick {
  bucketIdx: number;
  label: string | null;
  ask: number;
  targetDate: string;
  feeRate: number | null;
}

/**
 * Pick the entry-hour arm's predicted placement from the sim's place-inputs payload. `planPlacementsFn` is
 * the sim's `planPlacements` (injected so this stays pure/testable). Pure + total; the caller resolves the
 * bucket identity + assembles `CityPlaceInput` (`assembleCityPlaceInput`).
 */
export function pickCityPlacement(
  arm: CityArm,
  place: PlaceInputs,
  planPlacementsFn: (input: PlaceInputs, opts: { stakeUsd?: number }) => Array<{ armHour: number; bucketIdx: number; label: string | null; ask: number }>,
): CityPlacementPick | null {
  if (arm.entryHour == null) return null;
  const rows = planPlacementsFn(place, { stakeUsd: arm.stakeUsd });
  const row = rows.find((r) => r.armHour === arm.entryHour);
  if (!row) return null; // the arm hour is not due, or has no usable quote on the predicted bucket
  if (!(row.ask > 0 && row.ask <= 1)) return null;
  return {
    bucketIdx: row.bucketIdx,
    label: row.label,
    ask: row.ask,
    targetDate: place.targetDate,
    feeRate: fin(place.feeRate) ? place.feeRate : null,
  };
}

/** Assemble a `CityPlaceInput` from a pure pick + the resolved venue identity. Returns null on a bad identity. */
export function assembleCityPlaceInput(
  cityId: string,
  pick: CityPlacementPick,
  identity: BucketIdentity | null,
): CityPlaceInput | null {
  if (!identity || !identity.marketId || !identity.tokenId) return null;
  return {
    cityId,
    marketId: identity.marketId,
    tokenId: identity.tokenId,
    targetDate: pick.targetDate,
    bucketIdx: pick.bucketIdx,
    label: pick.label,
    ask: pick.ask,
    feeRate: pick.feeRate,
  };
}
