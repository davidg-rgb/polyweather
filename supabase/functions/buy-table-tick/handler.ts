/**
 * buy-table-tick — the CLOUD BUY-TABLE live lane (migration 0095, operator directive 2026-07-11).
 *
 * Replaces the LOCAL maker-exit daemon as "the buying function" with an every-10-min Edge tick implementing the
 * BUY-TABLE model (BUY-TABLE.md — the operator knows the measured record is a KILL and has explicitly
 * chosen to run it live small): buy OUR predicted daily-high bucket (argmax houseProb — the same house
 * seed the daemon reads) as a TAKER FAK, ONLY while its executable ask sits inside the city's PRICE RANGE
 * (0097: buy_table.city_price_ranges[slug] = {min, max} when the operator set one from /trading; else the
 * global default [0, buy_table.price_cap] = [0, $0.15] — the original behavior, unchanged), at
 * the C25 calibrated sweet-spot lead (hoursToClose ∈ [buy_table.lead_min_h, buy_table.lead_max_h] =
 * [2, 12] — no entries in the final 2h; the record shows near-close entries are the worst), stake =
 * trade_config.stake_per_buy_usd, cities = trade_config.city_allowlist, HOLD TO RESOLUTION (no exits —
 * no TP, no stop-loss, no time-stop). Entry idempotency = the 0102 ENTRY GATE (deriveEntryGate) over the
 * ANY-status buy_table_entries read: a market with a REAL fill (position) or an unknown-state row (stuck
 * 'intent' / unfilled 'placed' — the needs-reconcile classes) is ALWAYS blocked; a PROVABLY-dead attempt
 * (clean venue rejection → 'failed', zero-fill 'canceled') may be retried up to
 * buy_table.max_entry_attempts total attempts (default 1 = the original one-attempt-EVER rule).
 * buy_table.stop_after_first_success halts ALL new entries once any entry in this mode has a fill —
 * the operator's verification semantics (one successful buy, then quiet). The ledger's
 * (mode, intent_key) partial-unique index is the hard stop underneath it all.
 *
 * TRADE MODE LADDER (the double gate, preserved): the Edge secret TRADE_MODE resolved by the T1
 * `resolveTradeMode` — absent/typo ⇒ dry-run (records the intent in the ledger, NEVER posts), 'off' ⇒
 * inert. A REAL post needs TRADE_MODE=live AND trade_config.mode='live' AND
 * trade_live_preflight('buy-table').ok (run window + forward-gate PASS or an ACTIVE expiring override +
 * the N1 daily-loss kill un-tripped) — read this tick, gating every placement.
 *
 * HOLD-TO-CLOSE LOSS BOOKING: a held position whose market resolves AGAINST it never gets a SELL fill,
 * so the N1 realized-at-sell daily-loss definition is blind to it — every tick sweeps the lane's entry
 * rows against the capture stream's resolutions and books the loss via the idempotent
 * bot_order_record_resolution_loss (0084 #18) so the daily-loss kill sees it.
 *
 * DEGRADED ≠ EMPTY: a failed/shapeless discovery or lane-ledger read marks the tick DEGRADED (surfaced
 * in job stats — buy_table_deadman_check pages when every recent run is degraded) and places NOTHING;
 * it is never read as "no candidates". Alerts fire ONLY on live-risk events (a live post failing, the
 * discovery degrading while live) — everything else is structured logs.
 *
 * BOUNDARY (NON-NEGOTIABLE): the wallet key + the clob client live ONLY inside packages/trading/live.ts
 * (§15); this handler reaches the venue exclusively through the MakerExecutor + createClobClient seam.
 * The operator funds/keys/authorizes; Claude never trades, never touches credentials.
 */
import type { JobCtx, JobStats } from '../_shared/runJob.ts';
import {
  parseBotConfig,
  type RawBucket,
  type RawCaptureRow,
  type RawResolution,
} from '../../../packages/core/src/index.ts';
import {
  MakerExecutor,
  createClobClient,
  loadTradeConfig,
  orderIntentKey,
  recordResolutionLoss,
  redactText,
  resolveTradeMode,
  type MakerClobClientish,
  type TradeAlert,
  type TradeMode,
} from '../../../packages/trading/src/index.ts';

export interface BuyTableTickDeps {
  now: Date;
  /** Deno.env.get in production (getEnv) — the TRADE_MODE ladder. */
  getEnvVar: (name: string) => string | undefined;
  /** notifySlack(db, …) in production — claim_alert-gated (0095 allowlists the lane's push kinds). */
  notify: (alert: TradeAlert) => Promise<boolean>;
  /** Mock clob-client factory in tests; createClobClient in production (the §15 seam). */
  liveClient?: () => Promise<MakerClobClientish>;
}

/** The lane's ledger strategy tag (live_orders.strategy) — how /trading + the shadow harness tell lanes apart. */
export const BUY_TABLE_STRATEGY = 'buy-table';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Config — the buy_table.* key/value rows (migration 0095 seeds the defaults; coalesce here mirrors them).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface BuyTableCfg {
  /** the GLOBAL entry gate: enter only while the executable ask ≤ this (the BUY-TABLE ≤15¢ cheap gate) —
   *  unless the city has a 0097 range override below. */
  priceCap: number;
  /** the C25 sweet-spot window: enter only when hoursToClose ≤ this (≤12h before close). */
  leadMaxH: number;
  /** …and ≥ this (no entries in the final 2h — the record's worst regime). */
  leadMinH: number;
  /** the operator kill switch for the whole tick (config buy_table.tick_enabled). */
  tickEnabled: boolean;
  /** 0097: per-city [min, max] entry-price overrides (config buy_table.city_price_ranges — a jsonb text map
   *  keyed by lower-cased cities.slug). An absent slug means the global [0, priceCap]. */
  cityRanges: Record<string, { min: number; max: number }>;
  /** 0102 rule 1: total placement attempts allowed per market (ledger rows per intent key). Default 1 =
   *  the original one-attempt-EVER behavior. >1 lets a PROVABLY-dead attempt (a clean venue rejection →
   *  status 'failed', or an explicit zero-fill cancel) be retried on a later tick. Unknown-state rows
   *  ('intent', or 'placed' with no fill — the needs-reconcile classes) ALWAYS block regardless: retrying
   *  an order the venue may hold could double-place, and no cap makes that safe. */
  maxEntryAttempts: number;
  /** 0102 rule 2: once ANY entry in this mode has a real fill (we own shares), the lane stops opening
   *  NEW entries entirely — including later candidates inside the same tick. The operator's verification
   *  semantics: one successful buy, then quiet. Default false = the original behavior. */
  stopAfterFirstSuccess: boolean;
}

const num = (v: string | undefined, dflt: number): number => {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/**
 * Parse the buy_table.city_price_ranges map FAIL-SAFE: malformed JSON, a non-object payload, or an entry
 * whose bounds are non-finite / inverted (min ≥ max) / negative is DROPPED — the city then falls back to the
 * global [0, priceCap] gate (never a wider-than-intended window from a mangled row; the 0097 RPC is the
 * validated write path, so a broken value only ever comes from a hand edit).
 */
function parseCityRanges(raw: string | undefined): Record<string, { min: number; max: number }> {
  if (raw == null || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, { min: number; max: number }> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const min = Number((v as { min?: unknown } | null)?.min);
    const max = Number((v as { max?: unknown } | null)?.max);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && min < max) {
      out[k.trim().toLowerCase()] = { min, max };
    }
  }
  return out;
}

export function parseBuyTableConfig(rows: { key: string; value: string }[]): BuyTableCfg {
  const map = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.key, r.value]));
  const enabledRaw = (map.get('buy_table.tick_enabled') ?? 'true').trim().toLowerCase();
  const stopRaw = (map.get('buy_table.stop_after_first_success') ?? 'false').trim().toLowerCase();
  // attempts: an integer ≥ 1 (a fractional/zero/negative hand-edit falls back to the safe default 1).
  const attemptsRaw = num(map.get('buy_table.max_entry_attempts'), 1);
  return {
    priceCap: num(map.get('buy_table.price_cap'), 0.15),
    leadMaxH: num(map.get('buy_table.lead_max_h'), 12),
    leadMinH: num(map.get('buy_table.lead_min_h'), 2),
    tickEnabled: enabledRaw === 'true' || enabledRaw === '1',
    cityRanges: parseCityRanges(map.get('buy_table.city_price_ranges')),
    maxEntryAttempts: Number.isInteger(attemptsRaw) && attemptsRaw >= 1 ? attemptsRaw : 1,
    stopAfterFirstSuccess: stopRaw === 'true' || stopRaw === '1',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 0102 entry rules — the pure gate over the lane's ledger history (rule 1: bounded retry after a
// PROVABLY-dead attempt · rule 2: first real fill halts all further entries).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface EntryGate {
  /** Intent keys the selector must not re-enter (position held / unknown venue state / attempt cap). */
  blockedIntentKeys: ReadonlySet<string>;
  /** Rule 2: a real fill exists in this mode and stop_after_first_success is on — place NOTHING. */
  laneHalted: boolean;
}

/** A row with a REAL fill — we own shares (partial fills count: money is deployed). */
const hasFill = (e: BuyTableEntryRow): boolean =>
  Number(e.sizeMatched) > 0 || e.status === 'partial' || e.status === 'filled';

/** A row whose venue state is UNKNOWN (the executor's needs-reconcile classes): a stuck 'intent'
 *  (shapeless post — the venue may hold the order) or a 'placed' row with no recorded fill (either a
 *  dead zero-fill FAK or a fill-poll failure hiding a real fill — indistinguishable from the ledger).
 *  These ALWAYS block their market: a blind retry could double-place/double-buy. */
const isUnknownState = (e: BuyTableEntryRow): boolean =>
  e.status === 'intent' || (e.status === 'placed' && !(Number(e.sizeMatched) > 0));

/**
 * Derive the entry gate from the lane's full (mode-scoped, ANY-status) ledger history. Per intent key:
 * blocked when a fill exists (never rebuy into a position), OR any row is in an unknown venue state,
 * OR total attempts (rows) ≥ maxEntryAttempts. With the default maxEntryAttempts=1 this reproduces the
 * original one-attempt-EVER gate exactly (any row blocks). Terminal 'failed' (clean venue rejection)
 * and zero-fill 'canceled' rows are the ONLY retryable classes — the same line the executor draws when
 * deciding whether to free a key.
 */
export function deriveEntryGate(entries: BuyTableEntryRow[], cfg: BuyTableCfg): EntryGate {
  const rows = Array.isArray(entries) ? entries : [];
  const byKey = new Map<string, BuyTableEntryRow[]>();
  for (const e of rows) {
    if (!e?.intentKey) continue;
    const list = byKey.get(e.intentKey);
    if (list) list.push(e);
    else byKey.set(e.intentKey, [e]);
  }
  const blocked = new Set<string>();
  let anyFill = false;
  for (const [key, group] of byKey) {
    const filled = group.some(hasFill);
    anyFill ||= filled;
    if (filled || group.some(isUnknownState) || group.length >= cfg.maxEntryAttempts) blocked.add(key);
  }
  return { blockedIntentKeys: blocked, laneHalted: cfg.stopAfterFirstSuccess && anyFill };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pure candidate selection — (captures, resolutions, existing keys, cfg) → candidates + verbatim skips.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface BuyTableCandidate {
  marketId: string;
  tokenId: string;
  /** station-local YYYY-MM-DD — the intent-key trade date. */
  tradeDate: string;
  city: string;
  bucketIdx: number;
  label: string | null;
  /** the capture's executable ask (execAsk, falling back to bestAsk) — the FAK worst-price + sizing denominator. */
  ask: number;
  /** floor(stake / ask) whole shares. */
  shares: number;
  hoursToClose: number;
  negRisk: boolean;
}

export interface BuyTableSkip {
  ref: string;
  reason: string;
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const tms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** One entry row from buy_table_entries(p_mode) — the lane's ANY-status ledger read (0095). */
export interface BuyTableEntryRow {
  marketId: string;
  tokenId: string;
  tradeDate: string;
  intentKey: string;
  status: string;
  sizeMatched: number;
}

export function selectBuyTableCandidates(args: {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
  /** EVERY intent key the lane has EVER used in this mode (any status) — the one-entry-per-market-ever gate. */
  existingIntentKeys: ReadonlySet<string>;
  cfg: BuyTableCfg;
  stakeUsd: number;
  minOrderSizeShares: number;
  now: Date;
}): { candidates: BuyTableCandidate[]; skips: BuyTableSkip[] } {
  const { captures, resolutions, existingIntentKeys, cfg, stakeUsd, minOrderSizeShares, now } = args;
  const candidates: BuyTableCandidate[] = [];
  const skips: BuyTableSkip[] = [];

  const resolvedBy = new Map<string, number | null>(
    (Array.isArray(resolutions) ? resolutions : []).map((r) => [String(r.id), r.winnerIdx ?? null]),
  );

  // latest capture per event — the tick's current view of each market.
  const latest = new Map<string, RawCaptureRow>();
  for (const r of Array.isArray(captures) ? captures : []) {
    if (r?.eventId == null) continue;
    const prev = latest.get(r.eventId);
    if (!prev || tms(r.capturedAt) > tms(prev.capturedAt)) latest.set(r.eventId, r);
  }

  for (const [eventId, r] of latest) {
    const ref = `${r.city ?? '?'}/${r.targetDate ?? '?'}`;

    if (resolvedBy.get(eventId) != null) {
      skips.push({ ref, reason: 'resolved — the market already graded' });
      continue;
    }
    const resolvesAtMs = tms(r.resolvesAt);
    if (!Number.isFinite(resolvesAtMs)) {
      skips.push({ ref, reason: 'no_resolves_at — the capture carries no resolution clock' });
      continue;
    }
    const hoursToClose = (resolvesAtMs - now.getTime()) / 3_600_000;
    if (!(hoursToClose >= cfg.leadMinH && hoursToClose <= cfg.leadMaxH)) {
      skips.push({
        ref,
        reason: `lead_window (${hoursToClose.toFixed(1)}h to close ∉ [${cfg.leadMinH}, ${cfg.leadMaxH}])`,
      });
      continue;
    }
    if (!r.targetDate) {
      skips.push({ ref, reason: 'no_target_date' });
      continue;
    }

    // OUR predicted bucket = argmax houseProb (the same house seed the daemon reads), identity required.
    const buckets = Array.isArray(r.buckets) ? r.buckets : [];
    let pick: RawBucket | null = null;
    for (const b of buckets) {
      if (!b?.conditionId || !b?.tokenYes || !fin(b.houseProb)) continue;
      if (pick == null || (b.houseProb as number) > (pick.houseProb as number)) pick = b;
    }
    if (pick == null) {
      skips.push({ ref, reason: 'no_house_prob — unseeded capture (no forecast center to buy)' });
      continue;
    }

    const ask = fin(pick.execAsk) ? pick.execAsk : fin(pick.bestAsk) ? pick.bestAsk : null;
    if (!fin(ask) || !(ask > 0 && ask <= 1)) {
      skips.push({ ref, reason: 'no_ask — the predicted bucket has no usable executable ask' });
      continue;
    }
    // 0097: the price gate honors a per-city [min, max] override when the operator set one; otherwise the
    // global [0, priceCap] — byte-identical to the original ≤cap gate (min 0 excludes nothing).
    const override = cfg.cityRanges[String(r.city ?? '').trim().toLowerCase()];
    if (override != null) {
      if (ask < override.min - 1e-9 || ask > override.max + 1e-9) {
        skips.push({
          ref,
          reason: `price_range (ask ${ask.toFixed(3)} ∉ [${override.min}, ${override.max}] — per-city override)`,
        });
        continue;
      }
    } else if (ask > cfg.priceCap + 1e-9) {
      skips.push({ ref, reason: `price_cap (ask ${ask.toFixed(3)} > cap ${cfg.priceCap})` });
      continue;
    }

    const shares = Math.floor(stakeUsd / ask);
    if (!(shares >= Math.max(1, minOrderSizeShares))) {
      skips.push({ ref, reason: `below_min_size (${shares} sh < ${Math.max(1, minOrderSizeShares)})` });
      continue;
    }

    const marketId = String(pick.conditionId);
    const intentKey = orderIntentKey({ marketId, side: 'BUY', purpose: 'entry', tradeDate: r.targetDate });
    if (existingIntentKeys.has(intentKey)) {
      skips.push({
        ref,
        reason: `already_entered (${marketId} ${r.targetDate}) — entry gate (position held / unknown state / attempt cap)`,
      });
      continue;
    }

    candidates.push({
      marketId,
      tokenId: String(pick.tokenYes),
      tradeDate: String(r.targetDate),
      city: String(r.city ?? ''),
      bucketIdx: Number(pick.idx ?? -1),
      label: pick.label ?? null,
      ask,
      shares,
      hoursToClose,
      negRisk: r.negRisk ?? true,
    });
  }

  return { candidates, skips };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pure resolution sweep — which held entries' markets resolved AGAINST them (book the full-stake loss).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function resolvedAgainstEntries(args: {
  entries: BuyTableEntryRow[];
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
}): Array<{ marketId: string; tokenId: string }> {
  const { entries, captures, resolutions } = args;

  const winnerIdxBy = new Map<string, number>();
  for (const r of Array.isArray(resolutions) ? resolutions : []) {
    if (r?.winnerIdx != null && Number.isInteger(r.winnerIdx)) winnerIdxBy.set(String(r.id), r.winnerIdx);
  }

  // latest capture per event → per-market (conditionId) event + the event's winner token.
  const latest = new Map<string, RawCaptureRow>();
  for (const r of Array.isArray(captures) ? captures : []) {
    if (r?.eventId == null) continue;
    const prev = latest.get(r.eventId);
    if (!prev || tms(r.capturedAt) > tms(prev.capturedAt)) latest.set(r.eventId, r);
  }
  const winnerTokenByMarket = new Map<string, string>();
  for (const [eventId, r] of latest) {
    const wIdx = winnerIdxBy.get(eventId);
    if (wIdx == null) continue;
    const buckets = Array.isArray(r.buckets) ? r.buckets : [];
    const winner = buckets.find((b) => Number(b?.idx) === wIdx);
    const winnerTok = winner?.tokenYes ? String(winner.tokenYes) : null;
    if (!winnerTok) continue;
    for (const b of buckets) {
      if (b?.conditionId) winnerTokenByMarket.set(String(b.conditionId), winnerTok);
    }
  }

  const out: Array<{ marketId: string; tokenId: string }> = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e?.marketId || !e?.tokenId) continue;
    if (!(Number(e.sizeMatched) > 0)) continue; // nothing held — the RPC would no-op anyway
    if (e.status === 'canceled' || e.status === 'failed') continue;
    const winnerTok = winnerTokenByMarket.get(e.marketId);
    if (winnerTok != null && winnerTok !== e.tokenId) out.push({ marketId: e.marketId, tokenId: e.tokenId });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Local classifier — Postgres 42883 undefined-function etc. (the city-lane/web-loader idiom, kept local
// so the function pulls no script deps). Pre-0095, buy_table_entries / the 'buy-table' preflight branch
// may be absent — a staged-dark skip, never a throw.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function isMissingObjectError(message: string): boolean {
  if (/PGRST202|42883|42703/i.test(message)) return true;
  return /(could not find the function|does not exist|not exist in the schema cache|no function matches|undefined function|undefined column)/i.test(
    message,
  );
}

const errMsg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The tick
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface CaptureInputs {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
}

export async function buyTableTick(ctx: JobCtx, deps: BuyTableTickDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const now = deps.now;

  // 1 · TRADE MODE LADDER — 'off' is inert (nothing constructed, no key read, no DB writes).
  const mode: TradeMode = resolveTradeMode(deps.getEnvVar);
  if (mode === 'off') {
    log('buy-table.off', { note: 'TRADE_MODE=off — the lane is inert this tick' });
    return { mode, skipped: 'trade_mode_off' };
  }

  // 2 · config — buy_table.* tunables + the bot.* fallbacks (capture-universe cities, venue min-size, fee).
  const configRows = await db.getConfigRows();
  const cfg = parseBuyTableConfig(configRows);
  if (!cfg.tickEnabled) {
    log('buy-table.disabled', { note: 'buy_table.tick_enabled=false — tick skipped by operator config' });
    return { mode, skipped: 'tick_disabled' };
  }
  const botCfg = parseBotConfig(configRows);

  // 3 · trade_config — stake + allowlist (throws loudly if 0082 is missing; it IS applied on prod).
  const tradeConfig = await loadTradeConfig(db);
  const allowlist =
    tradeConfig.cityAllowlist && tradeConfig.cityAllowlist.length > 0 ? tradeConfig.cityAllowlist : botCfg.cities;
  const stakeUsd = tradeConfig.stakePerBuyUsd;
  const feeRateBps = Math.round(botCfg.takerFeeRate * 10_000);

  // 4 · lane ledger read — EVERY intent key the lane has ever used (the one-entry-ever gate) + the
  //     held rows for the resolution sweep. Absent RPC (0095 not applied) ⇒ STAGED-DARK skip; a failed
  //     read ⇒ tick DEGRADED (placing without the ever-gate could re-enter past a freed terminal key).
  let entries: BuyTableEntryRow[] = [];
  let stagedDark = false;
  let entriesDegraded = false;
  try {
    const rows = await db.rpc<{ buy_table_entries: { rows?: unknown } | null }>('buy_table_entries', {
      p_mode: mode,
    });
    const env = rows[0]?.buy_table_entries;
    const list = Array.isArray(env?.rows) ? (env!.rows as BuyTableEntryRow[]) : null;
    if (list == null) {
      entriesDegraded = true;
      log('buy-table.entries_shapeless', {
        note: 'buy_table_entries returned no {rows:[…]} envelope — treated as a failed read (tick degraded)',
      });
    } else {
      entries = list;
    }
  } catch (e) {
    const msg = errMsg(e);
    if (isMissingObjectError(msg)) {
      stagedDark = true;
      log('buy-table.staged_dark', {
        note: 'buy_table_entries() absent — migration 0095 not applied; lane inert this tick',
      });
    } else {
      entriesDegraded = true;
      log('buy-table.entries_failed', { error: redactText(msg) });
    }
  }
  if (stagedDark) return { mode, stagedDark: true, degraded: false };

  // 5 · discovery — the same capture RPC the daemon reads. Failed/shapeless ⇒ DEGRADED, never 'no candidates'.
  let captures: RawCaptureRow[] = [];
  let resolutions: RawResolution[] = [];
  let discoveryDegraded = false;
  try {
    const rows = await db.rpc<{ convergence_capture_inputs: CaptureInputs | null }>('convergence_capture_inputs', {
      p_days: 2,
      p_cities: allowlist,
    });
    const env = rows[0]?.convergence_capture_inputs;
    if (env == null || !Array.isArray(env.captures)) {
      discoveryDegraded = true;
      log('buy-table.discovery_shapeless', {
        note: 'convergence_capture_inputs returned no {captures:[…]} envelope — treated as a failed read (tick degraded)',
      });
    } else {
      captures = env.captures;
      resolutions = Array.isArray(env.resolutions) ? (env.resolutions as RawResolution[]) : [];
    }
  } catch (e) {
    discoveryDegraded = true;
    log('buy-table.discovery_failed', { error: redactText(errMsg(e)) });
  }

  const degraded = discoveryDegraded || entriesDegraded;
  if (degraded && mode === 'live') {
    // live-risk: the live lane is scanning blind — page (day-bucketed, 0092 policy).
    await deps.notify({
      kind: 'BUY_TABLE_DEGRADED',
      severity: 'WARN',
      title: 'buy-table-tick: discovery/ledger read FAILED while LIVE',
      body:
        `${discoveryDegraded ? 'convergence_capture_inputs is unreadable — no candidates can be discovered and resolution losses cannot be booked. ' : ''}` +
        `${entriesDegraded ? 'buy_table_entries is unreadable — the one-entry-ever gate cannot be checked, so no placement is safe. ' : ''}` +
        'The tick placed NOTHING (a failed read is never "no candidates"). Held positions are hold-to-close by design and need no management. Recurs max once/day.',
      dedupeKey: `buy-table-degraded:${now.toISOString().slice(0, 10)}`,
    });
  }

  // 6 · resolution-loss sweep (hold-to-close): book full-stake losses for markets that resolved against us,
  //     so the N1 daily-loss kill sees them. Idempotent server-side (0084 #18) — safe every tick.
  let lossesBooked = 0;
  if (!degraded) {
    for (const hit of resolvedAgainstEntries({ entries, captures, resolutions })) {
      try {
        const res = await recordResolutionLoss(db, { mode, marketId: hit.marketId, tokenId: hit.tokenId });
        if (res.booked) {
          lossesBooked++;
          log('buy-table.resolution_loss_booked', {
            marketRef: hit.marketId,
            heldSize: res.heldSize,
            lossUsd: res.lossUsd,
          });
        }
      } catch (e) {
        log('buy-table.resolution_loss_failed', { marketRef: hit.marketId, error: redactText(errMsg(e)) });
      }
    }
  }

  // 7 · candidates (pure) — the BUY-TABLE gates over the latest capture per market, behind the 0102
  //     entry gate (rule 1: bounded retry only after PROVABLY-dead attempts; rule 2: a real fill +
  //     stop_after_first_success halts ALL new entries — the operator's one-verified-buy semantics).
  const gate = deriveEntryGate(entries, cfg);
  let { candidates, skips } = degraded
    ? { candidates: [] as BuyTableCandidate[], skips: [{ ref: 'ALL', reason: 'degraded — failed read is never "no candidates"' }] }
    : selectBuyTableCandidates({
        captures,
        resolutions,
        existingIntentKeys: gate.blockedIntentKeys,
        cfg,
        stakeUsd,
        minOrderSizeShares: botCfg.minOrderSizeShares,
        now,
      });
  if (gate.laneHalted && candidates.length > 0) {
    skips = skips.concat(
      candidates.map((c) => ({
        ref: `${c.city}/${c.tradeDate}`,
        reason: 'lane_halted — a successful buy exists and stop_after_first_success is on (working as designed)',
      })),
    );
    candidates = [];
  }
  for (const s of skips) log('buy-table.skip', { ref: s.ref, reason: s.reason });

  // 8 · the LIVE interlock — trade_live_preflight('buy-table'), read this tick, gating every placement.
  //     null = not read (dry-run); in live mode anything but true blocks ALL posts (fail closed).
  let preflightOk: boolean | null = null;
  if (mode === 'live' && candidates.length > 0) {
    try {
      const rows = await db.rpc<{ trade_live_preflight: { ok?: boolean; reasons?: string[] } | null }>(
        'trade_live_preflight',
        { p_strategy: 'buy-table' },
      );
      preflightOk = rows[0]?.trade_live_preflight?.ok === true;
      if (!preflightOk) {
        log('buy-table.preflight_blocked', {
          reasons: rows[0]?.trade_live_preflight?.reasons ?? null,
          note: 'trade_live_preflight(buy-table) returned a negative verdict — no live posts this tick',
        });
      }
    } catch (e) {
      preflightOk = false; // absent (pre-0095) or a read error → hold all live posts (fail closed)
      log('buy-table.preflight_unavailable', { error: redactText(errMsg(e)) });
    }
  }

  // 9 · placement — taker marketable-limit BUY (FAK) at the observed ask, hold to close (purpose 'entry',
  //     strategy 'buy-table'; the ledger partial-unique is the hard idempotency stop under the ever-gate).
  let placed = 0;
  let dryRun = 0;
  let duplicate = 0;
  let failed = 0;
  let haltedAfterFill = false;
  const blocked = mode === 'live' && preflightOk !== true;
  if (candidates.length > 0 && !blocked) {
    const executor = new MakerExecutor({
      db,
      client: deps.liveClient ?? createClobClient,
      notify: deps.notify,
      getEnvVar: deps.getEnvVar,
      log: (entry) => log('buy-table.executor', entry),
    });
    for (const [i, c] of candidates.entries()) {
      try {
        const result = await executor.placeTaker({
          marketId: c.marketId,
          tokenId: c.tokenId,
          side: 'BUY',
          purpose: 'entry',
          tradeDate: c.tradeDate,
          worstPrice: c.ask,
          size: c.shares,
          negRisk: c.negRisk,
          feeRateBps,
          strategy: BUY_TABLE_STRATEGY,
        });
        if (result.status === 'placed') placed++;
        else if (result.status === 'dry_run') dryRun++;
        else if (result.status === 'duplicate') duplicate++;
        log('buy-table.intent', {
          marketRef: c.marketId,
          city: c.city,
          label: c.label,
          status: result.status,
          limitPrice: result.limitPrice,
          size: result.size,
          sizeMatched: result.sizeMatched,
          hoursToClose: Math.round(c.hoursToClose * 10) / 10,
          reason: result.reason,
        });
        // 0102 rule 2, in-tick: the first REAL fill halts the rest of this tick's candidates too —
        // one successful buy, then quiet (later ticks halt via deriveEntryGate reading the fill row).
        if (cfg.stopAfterFirstSuccess && (result.sizeMatched ?? 0) > 0) {
          haltedAfterFill = true;
          for (const rest of candidates.slice(i + 1)) {
            log('buy-table.skip', {
              ref: `${rest.city}/${rest.tradeDate}`,
              reason: 'lane_halted — first successful buy this tick; stop_after_first_success is on',
            });
          }
          break;
        }
      } catch (e) {
        failed++;
        const message = redactText(errMsg(e));
        log('buy-table.intent_failed', { marketRef: c.marketId, city: c.city, error: message });
        if (mode === 'live') {
          // live-risk: a live post attempt failed (the executor's own ORDER_FAIL/ORDER_NEEDS_RECONCILE
          // CRITICALs cover the venue paths; this covers the pre-venue throws — key/book/min-size).
          await deps.notify({
            kind: 'BUY_TABLE_POST_FAILED',
            severity: 'CRITICAL',
            title: `buy-table live entry failed: ${c.city} ${c.label ?? c.marketId}`,
            body: message,
            dedupeKey: `buy-table-post-fail:${c.marketId}`,
          });
        }
      }
    }
  } else if (candidates.length > 0 && blocked) {
    for (const c of candidates) {
      log('buy-table.skip', { ref: c.marketId, reason: 'preflight_blocked — live interlock not ok; no live posts' });
    }
  }

  const stats: JobStats = {
    mode,
    degraded,
    discoveryDegraded,
    entriesDegraded,
    captures: captures.length,
    entriesSeen: entries.length,
    candidates: candidates.length,
    skips: skips.length,
    placed,
    dryRun,
    duplicate,
    failed,
    lossesBooked,
    preflightOk,
    priceCap: cfg.priceCap,
    cityOverrides: Object.keys(cfg.cityRanges).length,
    leadWindowH: [cfg.leadMinH, cfg.leadMaxH],
    stakeUsd,
    cities: allowlist.length,
    maxEntryAttempts: cfg.maxEntryAttempts,
    laneHalted: gate.laneHalted || haltedAfterFill,
  };
  log('buy-table.tick', stats);
  return stats;
}
