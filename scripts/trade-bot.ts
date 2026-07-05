/**
 * scripts/trade-bot — the LIVE maker-exit trading DAEMON (LIVE-RAIL T2 lane).
 *
 * Runs LOCALLY on the operator's box (`pnpm tsx scripts/trade-bot.ts`), drives the T1 `MakerExecutor`, and
 * is governed by the T3 activation console (migration 0082). It is the live twin of the maker-exit paper
 * loop (`supabase/functions/maker-exit-panel`): where the paper loop RE-REPLAYS the capture stream, this
 * daemon executes the SAME tuned strategy against the real venue — one resting maker entry per fresh
 * forecast-center bucket, a resting maker take-profit, and a taker stop-loss / `resolvesAt−18h` time-stop.
 *
 * DEFAULT POSTURE = DRY-RUN. `TRADE_MODE` (resolved by the T1 `resolveTradeMode`) is the master gate:
 *   • unset / typo / `dry-run` → build + log the exact (redacted) order, RECORD the intent under
 *     mode='dry-run' (the shadow harness reads it), NEVER post/cancel at the venue.
 *   • `off`                    → the daemon is inert: it logs and exits 0 (nothing constructed, no key read).
 *   • `live`                   → post for real — but ONLY after `trade_live_preflight()` PASSes, per placement.
 * A real post therefore requires BOTH `TRADE_MODE=live` AND a passing DB interlock (which itself requires
 * `trade_config.mode='live'`, an active run window, a PASS forward paper gate or an operator override, and
 * the daily-loss kill un-tripped). NO CAPITAL until a frozen paper PASS — the interlock encodes that in SQL.
 *
 * BOUNDARY (NON-NEGOTIABLE, §9R / GO-LIVE-CHECKLIST-OPENING.md §8): Claude builds the software; the OPERATOR
 * funds the dedicated wallet, holds the signing key in `.env.local`, and authorizes runs. This daemon never
 * handles the wallet signing key — the key + the CLOB client live ONLY inside `packages/trading/src/live.ts`
 * (§15); the daemon reaches the venue exclusively through the `createClobClient` seam + the `MakerExecutor`.
 *
 * ENV (names only — never printed):
 *   TRADE_MODE                 off | dry-run | live   (unset ⇒ dry-run; a live post needs the literal 'live')
 *   DATABASE_URL               the service-role Postgres DSN (the repo's script idiom, §11.2 — used to reach
 *                              the 0082 activation console + the T1 order ledger; see the runbook note below)
 *   the wallet signing key     (`POLY_…` in `.env.local`) — read ONLY by createClobClient inside
 *                              packages/trading (dry-run + live sign the would-be order to log/post it);
 *                              POLY_SIGNATURE_TYPE / POLY_FUNDER_ADDRESS as needed
 *   SLACK_WEBHOOK_URL          optional — the daemon posts CRITICAL/WARN alerts RAW (bypasses the DB Slack pause
 *                              gate by design; the local safety channel), and always logs them structured
 *   TRADE_TICK_SEC             optional tick interval (default = bot.tickIntervalSec ≈ 30; clamped ≥ 5s)
 *
 * (Runbook note on service creds: the LIVE-RAIL brief names SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. This
 * repo's scripts reach Postgres directly via `DATABASE_URL` + `postgres` (makeScriptDb) — using supabase-js
 * would add a runtime dep, which is forbidden. `DATABASE_URL` IS the service-role connection; it is the
 * faithful, no-new-dep realization of "service creds". See docs/ops/TRADING-ACTIVATION.md.)
 *
 * NOT RUN in this build: the daemon is delivered + typechecked + its decision spine unit-tested (fixtures
 * only). It is never executed against the live DB/venue here — that is the operator's dry-run first.
 */
import { pathToFileURL } from 'node:url';
import {
  executableBid,
  makerExitCfg,
  normalizeBook,
  parseBotConfig,
  type RawCaptureRow,
  type RawClobBook,
} from '../packages/core/src/index.ts';
import {
  createClobClientWithIdentity,
  danglingEnvelopeReady,
  loadTradeConfig,
  orderIntentKey,
  preflightLive,
  recordResolutionLoss,
  redactText,
  resolveTradeMode,
  parseTrades,
  sumOurSellSize,
  tradesResponseTruncated,
  rpcOrderLedger,
  MakerExecutor,
  type MakerClobClientish,
  type OrderLedger,
  type OrderLedgerRow,
  type OrderPurpose,
  type OrderSide,
  type TradeAlert,
  type TradeConfig,
  type TradeMode,
  type TradePreflight,
} from '../packages/trading/src/index.ts';
import { buildAlertBlocks, slackPost } from '../packages/io/src/index.ts';
import {
  applyPlan,
  assemblePosition,
  decideTick,
  discoverCandidates,
  dustParkAlerts,
  entryCancelDeferredAlerts,
  metaDegradedAlert,
  sellHoldAlerts,
  toDecideCfg,
  type DecideCfg,
  type DiscoveredCandidate,
  type LivePosition,
} from './lib/trade-bot-decide.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';
import { acquireTradeBotLock, makeTradingDb, type OpenEntryRow, type ScriptTradingDb } from './lib/trading-db.ts';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Structured, key-redacted logger (GO-LIVE-CHECKLIST-OPENING.md §8: "key-redacted by construction").
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const nowIso = (): string => new Date().toISOString();

function log(entry: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: nowIso(), ...entry }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Alerting — the daemon's local safety channel. RAW webhook post (packages/io slackPost) bypasses the DB
// Slack pause gate by design (that gate lives in functions/_shared notifySlack, which this local process
// never touches) — so a CRITICAL from the daemon ALWAYS pages, regardless of the prod whale-noise pause.
// EVERY alert is also logged structured + REDACTED, so a missing webhook never silences a safety event.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function makeNotify(webhookUrl: string | undefined): (a: TradeAlert) => Promise<boolean> {
  return async (a: TradeAlert): Promise<boolean> => {
    const body = redactText(a.body);
    log({ msg: 'trade-bot.alert', level: a.severity, kind: a.kind, title: redactText(a.title), body });
    if (!webhookUrl) return false;
    return slackPost(webhookUrl, buildAlertBlocks({ kind: a.kind, severity: a.severity, title: redactText(a.title), body }));
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reconstruction meta — the market → capture-meta map, from the latest capture per event. EVERY
// identity-carrying bucket is indexed (findings #4/#5/#9): position identity comes from the LEDGER, and
// this map only ENRICHES it (city/tz/resolvesAt/houseProb/execBid) — so a forecast-center drift (the
// argmax moving to an adjacent bucket) or an unseeded capture (houseProb null by design on a seed outage)
// can never make an open position's market unlookupable. The argmax bucket drives NEW entry candidacy
// only (discoverCandidates → selectEntries), never position management.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface EventMeta {
  marketId: string; // the bucket's conditionId
  tokenId: string; // its YES token
  city: string;
  targetDate: string;
  tz: string;
  /** the bucket's houseProb — null when the latest capture is unseeded (management never needs it). */
  modelProb: number | null;
  resolvesAtMs: number | null;
  /** the bucket's captured execBid — the dry-run exit mark (no live book fetch in dry-run). */
  execBidCapture: number | null;
  /** the RESOLVED winner's YES token (0084 #18) — the capture-inputs RPC live-joins market_events, so
   *  `winnerIdx` appears on a row once the event grades; null until then (or if the winning bucket
   *  carries no identity). A held position whose token ≠ this token has resolved AGAINST us. */
  winnerTokenId: string | null;
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const tms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Per event's LATEST capture, EVERY bucket with venue identity → its capture meta. Buckets without a
 *  conditionId/tokenYes (pre-0083 rows) are skipped — reconstruction then degrades to ledger-only meta. */
export function buildEventMeta(captures: RawCaptureRow[]): Map<string, EventMeta> {
  const latest = new Map<string, RawCaptureRow>();
  for (const r of Array.isArray(captures) ? captures : []) {
    if (r?.eventId == null) continue;
    const prev = latest.get(r.eventId);
    if (!prev || tms(r.capturedAt) > tms(prev.capturedAt)) latest.set(r.eventId, r);
  }
  const out = new Map<string, EventMeta>();
  for (const r of latest.values()) {
    const buckets = Array.isArray(r.buckets) ? r.buckets : [];
    // 0084 #18 — the RPC emits `winnerIdx` (poly_resolved_winner_idx ?? winning_bucket_idx, live-joined)
    // untyped on the row; it indexes the buckets ladder. Only an identity-carrying winning bucket counts.
    const wIdx = (r as { winnerIdx?: number | null }).winnerIdx;
    const wTok = wIdx != null && Number.isInteger(wIdx) && buckets[wIdx]?.tokenYes ? String(buckets[wIdx].tokenYes) : null;
    for (const b of buckets) {
      if (!b?.conditionId || !b?.tokenYes) continue;
      out.set(String(b.conditionId), {
        marketId: String(b.conditionId),
        tokenId: String(b.tokenYes),
        city: String(r.city ?? ''),
        targetDate: String(r.targetDate ?? ''),
        tz: String(r.tzName ?? ''),
        modelProb: finite(b.houseProb) ? Number(b.houseProb) : null,
        resolvesAtMs: finite(tms(r.resolvesAt)) ? tms(r.resolvesAt) : null,
        execBidCapture: finite(b.execBid) ? Number(b.execBid) : null,
        winnerTokenId: wTok,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The daemon
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface Daemon {
  mode: TradeMode;
  db: ScriptTradingDb;
  ledger: OrderLedger;
  executor: MakerExecutor;
  client: MakerClobClientish;
  notify: (a: TradeAlert) => Promise<boolean>;
  /** OUR on-chain maker/funder address (PUBLIC — it rides on every order we post; from
   *  `createClobClientWithIdentity`). The venue's trade records are TAKER-centric: when we were the
   *  MAKER our fill is a `maker_orders[]` leg, and this address is what tells OUR legs apart from
   *  sibling makers' matched in the same taker order. null ⇒ maker legs are unattributable and the
   *  sell-truth read DEGRADES (holds sells) rather than guessing. */
  address: string | null;
  /** one-shot dedupe for the dust-park WARN (finding: a sub-min remainder must warn ONCE, not
   *  CRITICAL-page every tick) — alert keys already warned this process lifetime. */
  warnedDust: Set<string>;
}

/** findByIntentKey for one purpose of a market/day. Redacting-safe; returns null on any read error. */
async function findOrder(
  ledger: OrderLedger,
  mode: TradeMode,
  marketId: string,
  side: OrderSide,
  purpose: OrderPurpose,
  tradeDate: string,
): Promise<OrderLedgerRow | null> {
  const key = orderIntentKey({ marketId, side, purpose, tradeDate });
  return ledger.findByIntentKey(key, mode);
}

/**
 * Refresh a resting order's fill state from the venue (live only) and record any NEW fill through the
 * ledger — this is how a maker order that fills AFTER posting (the entry lifting, or the TP being lifted by
 * a buyer) enters the ledger. A record_* raise routes to a needs-reconcile CRITICAL (never suppressed); the
 * stale row is returned so the tick still makes a decision. dry-run/off: the venue is never polled.
 *
 * Returns `{ row, fresh }`. `fresh` = the row's venue fill-state is TRUSTWORTHY this tick — true when no
 * poll was needed (dry-run/off, no orderId, or a terminal status) OR the live poll SUCCEEDED; **false only
 * when a live poll of a resting order THREW**. The entry cancel-on-kill path (§11.2) consumes this: a stale
 * `sizeMatched=0` from a failed poll must NOT license a `cancel_entry` that could orphan a poll-missed
 * partial fill (entry BUYs have no `getTrades` floor — only SELLs do).
 */
export async function refreshFill(
  d: Daemon,
  row: OrderLedgerRow | null,
): Promise<{ row: OrderLedgerRow | null; fresh: boolean }> {
  if (row == null || d.mode !== 'live') return { row, fresh: true };
  if (row.orderId == null || (row.status !== 'placed' && row.status !== 'partial')) return { row, fresh: true };
  try {
    const poll = await d.executor.pollFill(row.orderId, row.size);
    if (poll.sizeMatched > row.sizeMatched + 1e-9) {
      await d.ledger.recordFill(
        row.clientOrderId,
        poll.sizeMatched,
        poll.avgPrice ?? row.price,
        poll.filled ? 'filled' : 'partial',
      );
      return { row: (await d.ledger.findByIntentKey(row.intentKey, d.mode)) ?? row, fresh: true };
    }
    return { row, fresh: true }; // poll succeeded, no new fill — the resting-at-0 state is CONFIRMED fresh
  } catch (e) {
    await d.notify({
      kind: 'ORDER_NEEDS_RECONCILE',
      severity: 'CRITICAL',
      title: `trade-bot fill-poll/record failed: ${row.marketId} ${row.purpose}`,
      body: redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
      dedupeKey: `trade-bot-poll:${row.clientOrderId}`,
    });
  }
  return { row, fresh: false }; // live poll threw — the fill state is STALE this tick
}

/** The current executable sell mark for a held position. live: the real book; else the capture execBid. */
async function markFor(d: Daemon, tokenId: string, size: number, fallback: number | null): Promise<number | null> {
  if (d.mode !== 'live') return fallback;
  try {
    const book = normalizeBook((await d.client.getOrderBook(tokenId)) as RawClobBook);
    const res = executableBid(book, Math.max(size, 1));
    return res.fillableShares > 0 && Number.isFinite(res.avgPrice) ? res.avgPrice : fallback;
  } catch {
    return fallback; // best-effort — a book outage falls back to the last capture mark
  }
}

/**
 * Venue sell truth for one token (live only): Σ OUR SELL fill sizes from `getTrades` — the same evidence
 * read the startup reconcile uses. This floors the position's `soldSize` so fills whose ledger rows have
 * gone terminal-canceled (a lifted-then-cancelled TP, an adjudicated FAK corpse — invisible to
 * `bot_order_by_intent`) are never lost (lens CRITICAL-1/LOW-5). Failed venue trades are excluded.
 *
 * ⚠ VENUE SEMANTICS (the /data/trades record is TAKER-centric — installed SDK v4.22.8 Trade type):
 * the top-level `side`/`size` describe the TAKER order, `trader_side` says which side WE were, and our
 * maker fills live in `maker_orders[]` legs. For this maker-first strategy the dominant fills are MAKER
 * legs — a naive top-level read INVERTS them (our filled maker BUY entry arrives as side='SELL' and
 * would be counted as sold → position marked flattened, no TP/SL ever rests; our maker TP SELL arrives
 * as side='BUY' and would be missed → over-sell). `sumOurSellSize` resolves the perspective and
 * attributes maker legs by OUR address (`d.address`), falling back to the position's known SELL order
 * ids; an unattributable SELL leg degrades the read (hold sells) rather than guessing.
 *
 * The read is SAFETY-LOAD-BEARING (lens NEW-LOW-1): on a live read outage it returns
 * `{ sold: null, degraded: true }` — the position's sells are then HELD for the tick (the decide spine
 * refuses to size any SELL from a possibly-understated soldSize) and the daemon fires a CRITICAL
 * `sellHoldAlerts` alert. dry-run: `{ sold: null, degraded: false }` — no venue read is applicable and
 * dry-run rows never fill, so the visible ledger sum is exact.
 *
 * §11.1 — a successful-but-TRUNCATED page (a non-terminal `next_cursor`, or a page at/above
 * `CLOB_TRADES_PAGE_LIMIT`) would UNDER-count our SELL fills exactly like a lost read, so it is treated
 * IDENTICALLY to a throw: degrade and hold. We do NOT follow the cursor (single-call read is the contract;
 * the strategy trades ~1 BUY + ≤3 SELLs per token, so a real page is never near the limit).
 */
export async function venueSoldFor(
  d: Daemon,
  tokenId: string,
  knownSellOrderIds?: ReadonlySet<string>,
): Promise<{ sold: number | null; degraded: boolean }> {
  if (d.mode !== 'live') return { sold: null, degraded: false }; // dry-run rows never fill — visible sum exact
  try {
    const raw = await d.client.getTrades({ asset_id: tokenId });
    if (tradesResponseTruncated(raw)) {
      // §11.1: a cursor-bearing / at-page-limit response may be an incomplete first page — sizing a SELL
      // from its partial soldSize could OVER-SELL. Degrade (hold the sells) exactly as on a throw.
      log({ msg: 'trade-bot.venue_sold_truncated', level: 'WARN', tokenId, note: 'getTrades page is cursor-bearing/at page limit — treated as degraded (sell-truth may under-count)' });
      return { sold: null, degraded: true };
    }
    const trades = parseTrades(raw);
    const { sold, unattributed } = sumOurSellSize(trades, { tokenId, ourAddress: d.address, knownOrderIds: knownSellOrderIds });
    if (unattributed) {
      // A maker-perspective SELL leg we could not attribute (ours vs a sibling maker's): counting it
      // could under-manage the position, dropping it could over-sell — so hold the sells instead.
      log({ msg: 'trade-bot.venue_sold_unattributable', level: 'WARN', tokenId, note: 'a maker SELL leg in getTrades could not be attributed (no address match, unknown order id) — treated as degraded (sells held this tick)' });
      return { sold: null, degraded: true };
    }
    return { sold, degraded: false };
  } catch (e) {
    log({ msg: 'trade-bot.venue_sold_failed', level: 'WARN', tokenId, error: redactText(e instanceof Error ? e.message : String(e)) });
    return { sold: null, degraded: true };
  }
}

/**
 * Reconstruct every open position from the LEDGER + the VENUE (never memory) — the crash-resume contract.
 * The position set is enumerated from the ledger's OPEN BUY/entry rows (`listOpenEntryRows` — findings
 * #4/#5/#9): a position, once entered, is managed by ITS OWN conditionId/tokenYes identity for its whole
 * life. The capture-derived `metaByMarket` only ENRICHES it (city/tz/resolvesAt/houseProb/execBid); when
 * the capture window lacks the market this tick (a discovery outage, an aged capture), the position is
 * STILL reconstructed with `metaDegraded: true` — ledger-truth exits keep working, the capture-derived
 * pieces are held, and the daemon fires a WARN. Never dropped. (The old capture-argmax keying silently
 * orphaned a position on a forecast-center drift or an unseeded capture — both routine.)
 */
export async function reconstructPositions(
  d: Daemon,
  openEntries: OpenEntryRow[],
  metaByMarket: Map<string, EventMeta>,
): Promise<LivePosition[]> {
  const positions: LivePosition[] = [];
  const seen = new Set<string>();
  for (const ref of Array.isArray(openEntries) ? openEntries : []) {
    if (!ref?.marketId || !ref?.tradeDate) continue;
    const posKey = `${ref.marketId}|${ref.tradeDate}`;
    if (seen.has(posKey)) continue; // the partial-unique index makes dupes impossible; belt-and-braces
    seen.add(posKey);

    let entry = await findOrder(d.ledger, d.mode, ref.marketId, 'BUY', 'entry', ref.tradeDate);
    if (entry == null) continue; // raced terminal between the list and the read — nothing open to manage
    const entryRes = await refreshFill(d, entry);
    entry = entryRes.row;
    if (entry == null) continue;

    const meta = metaByMarket.get(ref.marketId) ?? null;
    // the position's OWN token identity: the ledger row placed at entry, then the list read, then capture.
    const tokenId = entry.tokenId || ref.tokenId || meta?.tokenId || '';

    const tp = (await refreshFill(d, await findOrder(d.ledger, d.mode, ref.marketId, 'SELL', 'take_profit', ref.tradeDate))).row;
    const sl = (await refreshFill(d, await findOrder(d.ledger, d.mode, ref.marketId, 'SELL', 'stop_loss', ref.tradeDate))).row;
    const ts = (await refreshFill(d, await findOrder(d.ledger, d.mode, ref.marketId, 'SELL', 'time_stop', ref.tradeDate))).row;

    const mark = await markFor(d, tokenId, entry.sizeMatched || entry.size, meta?.execBidCapture ?? null);
    // the position's OPEN sell rows' venue ids — the secondary maker-leg attribution key (the primary
    // is d.address; canceled rows' ids are unreadable through the port, which is exactly why). Same
    // ledger rows the ledger-keyed reconstruction already enumerates for this market/date.
    const knownSellIds = new Set([tp, sl, ts].flatMap((r) => (r?.orderId ? [r.orderId] : [])));
    const venueSold = await venueSoldFor(d, tokenId, knownSellIds);
    const pos = assemblePosition({
      meta: {
        marketId: ref.marketId,
        tokenId,
        city: meta?.city ?? '',
        targetDate: ref.tradeDate,
        tz: meta?.tz ?? '',
        modelProb: meta?.modelProb ?? null,
        resolvesAtMs: meta?.resolvesAtMs ?? null,
      },
      entry,
      tp,
      stopLoss: sl,
      timeStop: ts,
      mark,
      venueSoldSize: venueSold.sold,
      soldTruthDegraded: venueSold.degraded,
      // §11.2 — the entry's fill state must be FRESHLY confirmed this tick before a kill may cancel it.
      entryPollFresh: entryRes.fresh,
      // findings #4/#5/#9 — no capture meta this tick: retained + WARN, never dropped.
      metaDegraded: meta == null,
    });
    if (pos) positions.push(pos);
  }
  return positions;
}

interface CaptureInputs {
  captures: RawCaptureRow[];
  resolutions: unknown[];
}

/** Cross-tick runtime state (the daemon loop owns one) — consecutive-failure counters for escalation. */
export interface TickRuntime {
  /** consecutive ticks whose LIVE preflight READ threw (finding #15) — resets on any successful read. */
  preflightReadFailures: number;
}

export const makeTickRuntime = (): TickRuntime => ({ preflightReadFailures: 0 });

/** finding #15 — escalate a PERSISTENT preflight-read outage to CRITICAL after this many consecutive ticks
 *  (a single blip is a WARN-and-hold; a sustained one means the interlock is unreadable and must page). */
export const PREFLIGHT_READ_FAIL_ESCALATE_AFTER = 3;

/** The CRITICAL escalation for a persistent preflight-read outage, or null below the threshold. PURE. */
export function preflightReadFailedAlert(consecutiveFailures: number): TradeAlert | null {
  if (consecutiveFailures < PREFLIGHT_READ_FAIL_ESCALATE_AFTER) return null;
  return {
    kind: 'TRADE_BOT_PREFLIGHT_READ_FAILED',
    severity: 'CRITICAL',
    title: `trade-bot: live preflight read failing (${consecutiveFailures} consecutive ticks)`,
    body:
      `trade_live_preflight has been unreadable for ${consecutiveFailures} consecutive ticks. The daemon ` +
      `is HOLDING honestly (no new entries, no reprices, resting entries left in place — a read failure ` +
      `is never treated as a kill verdict), but while the interlock is unreadable the daily-loss kill ` +
      `cannot gate entries and a real kill would not be seen. Investigate DB connectivity / statement ` +
      `timeouts on the preflight aggregation now.`,
    dedupeKey: 'trade-bot-preflight-read',
  };
}

/** One tick: discover → reconstruct (from the LEDGER) → preflight (live) → decide → apply → heartbeat. */
export async function tick(
  d: Daemon,
  botCitiesFallback: string[],
  minOrderSizeShares: number,
  runtime: TickRuntime,
): Promise<void> {
  const now = new Date();

  // Alerts that carry LIVE operational risk page through notify (raw Slack + structured log); in dry-run
  // nothing rests at the venue, so they degrade to the structured WARN log only (the file's alert
  // convention: every live-risk predicate in this file is live-gated; local logs are never silent).
  const alertLiveOrLog = async (a: TradeAlert): Promise<void> => {
    if (d.mode === 'live') await d.notify(a);
    else log({ msg: 'trade-bot.alert_dry_run_logged', level: a.severity, kind: a.kind, title: redactText(a.title), body: redactText(a.body) });
  };

  // config re-read each tick — mode/caps/allowlist can change under the running daemon.
  const config: TradeConfig = await loadTradeConfig(d.db);
  const allowlist = config.cityAllowlist && config.cityAllowlist.length > 0 ? config.cityAllowlist : botCitiesFallback;
  const cfgFull = makerExitCfg(allowlist);
  const cfg: DecideCfg = toDecideCfg(cfgFull, minOrderSizeShares);

  // discovery — the fresh capture window (p_days=2 covers a position's whole 1–2 day lifetime for the
  // meta-enrichment pass; discoverCandidates itself only enters currently-enterable buckets). Findings
  // #13/#14/#24 — a failed (or shapeless) read marks the tick DEGRADED: candidates are impossible, but
  // the position set is NOT emptied (it comes from the ledger below) and the degradation is surfaced in
  // the tick log, the heartbeat, and ONE alert — 'read failed' is never treated as 'no positions'.
  let captures: RawCaptureRow[] = [];
  let discoveryDegraded = false;
  try {
    const rows = await d.db.rpc<{ convergence_capture_inputs: CaptureInputs }>('convergence_capture_inputs', {
      p_days: 2,
      p_cities: allowlist,
    });
    const env = rows[0]?.convergence_capture_inputs;
    if (env == null || !Array.isArray(env.captures)) {
      discoveryDegraded = true; // version skew / SQL NULL — a shapeless envelope must not pass as 'empty'
      log({ msg: 'trade-bot.discovery_shapeless', level: 'WARN', note: 'convergence_capture_inputs returned no {captures:[…]} envelope — treated as a failed read (tick degraded)' });
    } else {
      captures = env.captures;
    }
  } catch (e) {
    discoveryDegraded = true;
    log({ msg: 'trade-bot.discovery_failed', level: 'WARN', error: redactText(e instanceof Error ? e.message : String(e)) });
  }
  if (discoveryDegraded) {
    await alertLiveOrLog({
      kind: 'TRADE_BOT_DISCOVERY_DEGRADED',
      severity: 'WARN',
      title: 'trade-bot: capture discovery FAILED this tick — managing from the ledger alone',
      body:
        'convergence_capture_inputs is unreadable, so no new candidates can be discovered and capture ' +
        'meta (resolvesAt clocks, house probs, dry-run marks) is unavailable. Open positions remain ' +
        'ENUMERATED FROM THE LEDGER and managed on ledger truth (live venue marks still drive the ' +
        'stop-loss); the tick is marked degraded in the heartbeat. Recurs every affected tick.',
      dedupeKey: 'trade-bot-discovery-degraded',
    });
  }

  const candidates: DiscoveredCandidate[] = discoverCandidates(captures, cfgFull, now);
  const metaByMarket = buildEventMeta(captures);
  // findings #4/#5/#9 — the position set comes from the LEDGER's open entry rows (the position's own
  // identity), never from the capture stream's current argmax bucket. A failure here fails the whole tick
  // loudly (CIRCUIT_BREAK path in the main loop) — the one honest answer when positions are unknowable.
  const openEntries = await d.db.listOpenEntryRows(d.mode);
  const positions = await reconstructPositions(d, openEntries, metaByMarket);

  // NEW-LOW-1 — the degraded-mode sell hold is escalated CRITICAL every affected tick (never silent):
  // a position whose venue sell-truth read failed has its taker exits + TP rest paused this tick.
  for (const a of sellHoldAlerts(positions)) await d.notify(a);

  // findings #4/#5/#9 — ONE WARN naming every position managed without capture meta this tick.
  const mAlert = metaDegradedAlert(positions);
  if (mAlert) await alertLiveOrLog(mAlert);

  // DUST PARK — an unsold remainder below the venue min-order floor can never execute an exit order
  // (place/placeTaker reject it), so the decide spine plans nothing for it (no ERR_MIN_SIZE CRITICAL
  // livelock); surface it to the operator ONCE per position (an already-resting TP keeps working
  // venue-side and can still flatten the dust as a maker).
  for (const a of dustParkAlerts(positions, cfg)) {
    const k = a.dedupeKey ?? `${a.kind}:${a.title}`;
    if (d.warnedDust.has(k)) continue;
    d.warnedDust.add(k);
    await d.notify(a);
  }

  // 0084 #18 — hold-to-resolution loss booking: a position whose market resolved AGAINST it (the graded
  // winner's token ≠ ours) never gets a SELL fill, so the N1 daily-loss kill is blind to the full-stake
  // loss until this books it. The RPC is idempotent ('already booked') and no-ops when nothing is held —
  // safe to call every tick; a throw only defers to the next tick (never kills the tick).
  for (const p of positions) {
    const m = metaByMarket.get(p.marketId);
    if (!m?.winnerTokenId || m.winnerTokenId === p.tokenId) continue;
    try {
      const res = await recordResolutionLoss(d.db, { mode: d.mode, marketId: p.marketId, tokenId: p.tokenId });
      if (res.booked) {
        log({ msg: 'trade-bot.resolution_loss_booked', marketRef: p.marketId, tokenId: p.tokenId, heldSize: res.heldSize ?? null, lossUsd: res.lossUsd ?? null });
        await alertLiveOrLog({
          kind: 'TRADE_BOT_RESOLUTION_LOSS',
          severity: 'WARN',
          title: 'trade-bot: hold-to-resolution loss booked into the daily-loss kill',
          body: `market ${p.marketId} resolved against the held position — full residual stake realized at $0 proceeds (idempotent booking).`,
          dedupeKey: `resolution-loss:${p.marketId}:${p.tokenId}`,
        });
      }
    } catch (e) {
      log({ msg: 'trade-bot.resolution_loss_failed', level: 'WARN', marketRef: p.marketId, error: redactText(e instanceof Error ? e.message : String(e)) });
    }
  }

  // preflight interlock — LIVE only (a pure read; dry-run/off never post live so never gate on it).
  // finding #15 — a THROWN read is a distinct state (verdict UNKNOWN): hold + WARN + retry next tick,
  // escalating to CRITICAL after PREFLIGHT_READ_FAIL_ESCALATE_AFTER consecutive failures. It is NEVER
  // synthesized into an ok:false verdict — that conflation cancelled real resting entries on a DB blip.
  let preflight: TradePreflight | null = null;
  let preflightReadFailed = false;
  if (d.mode === 'live') {
    try {
      preflight = await preflightLive(d.db);
      runtime.preflightReadFailures = 0;
    } catch (e) {
      preflightReadFailed = true;
      runtime.preflightReadFailures += 1;
      log({
        msg: 'trade-bot.preflight_read_failed',
        level: 'WARN',
        consecutive: runtime.preflightReadFailures,
        error: redactText(e instanceof Error ? e.message : String(e)),
        note: 'read failure ≠ kill verdict — entries/reprices HELD, resting entries NOT cancelled; retrying next tick',
      });
      const esc = preflightReadFailedAlert(runtime.preflightReadFailures);
      if (esc) await d.notify(esc);
    }
  }

  // §11.2 — a live kill wants to cancel fully-unfilled resting entries, but only when THIS tick freshly
  // polled them. Any entry whose fill state is stale (poll threw) has its cancel DEFERRED (decideTick skips
  // it) — fire a loud WARN so the operator knows a kill-cancel is waiting on a healthy poll. WARN, not
  // CRITICAL (bounded: the §9R-capped entry retries next tick, and a stale poll can't hide an over-sell).
  // Only a REAL negative verdict wants a cancel — a failed READ holds instead (finding #15).
  const killWantsCancel = d.mode === 'live' && !preflightReadFailed && preflight != null && !preflight.ok;
  for (const a of entryCancelDeferredAlerts(positions, killWantsCancel)) await d.notify(a);

  const plan = decideTick({ mode: d.mode, config, preflight, preflightReadFailed, cfg, now, candidates, positions });
  const applied = await applyPlan(plan, d.executor, d.notify, log, d.ledger, cfg.minOrderSizeShares);

  const degraded = discoveryDegraded || preflightReadFailed;
  log({
    msg: 'trade-bot.tick',
    mode: d.mode,
    candidates: candidates.length,
    positions: positions.length,
    intents: plan.intents.length,
    posted: applied.posted,
    dryRun: applied.dryRun,
    duplicate: applied.duplicate,
    failed: applied.failed,
    canceled: applied.canceled,
    aborted: applied.aborted,
    skips: plan.skips.length,
    preflightOk: preflight?.ok ?? null,
    degraded,
    discoveryDegraded,
    preflightReadFailed,
    metaDegradedPositions: positions.filter((p) => p.metaDegraded).length,
    activeUntil: config.activeUntil,
  });

  await heartbeat(d, plan.intents.length, applied, degraded);
}

/** Heartbeat — reuse the 0073 `record_bot_tick` idiom (mode-scoped bot_tick_log row) + a structured log.
 *  Best-effort: a heartbeat write must never fail a tick. NOTE (flagged in the report): bot_deadman_check
 *  watches a SINGLE mode (config.tradingMode, default 'paper'), so it will NOT auto-alarm on this live/
 *  dry-run daemon's staleness unless the operator points tradingMode at this mode — until a dedicated
 *  live-mode deadman is wired (config/cron, out of scope: 0082 is final), monitor the daemon's own logs. */
async function heartbeat(
  d: Daemon,
  nIntents: number,
  applied: { posted: number; dryRun: number; failed: number },
  /** findings #13/#14/#24 — a degraded tick (failed discovery/preflight read) must not look healthy. The
   *  marker rides gate_reason (record_bot_tick's schema is final) + a self-describing payload field. */
  degraded = false,
): Promise<void> {
  try {
    await d.db.rpc('record_bot_tick', {
      p_payload: {
        mode: d.mode,
        ran: true,
        placed: nIntents,
        filled: applied.posted + applied.dryRun,
        exited: 0,
        degraded,
        gateReason: `trade-bot ${d.mode} (posted ${applied.posted}, dry ${applied.dryRun}, failed ${applied.failed})${degraded ? ' [DEGRADED: discovery/preflight read failed this tick]' : ''}`,
      },
    });
  } catch (e) {
    log({ msg: 'trade-bot.heartbeat_failed', level: 'WARN', error: redactText(e instanceof Error ? e.message : String(e)) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tick cadence — finding #26: TRADE_TICK_SEC accepted negative/sub-second values, degenerating the
// sleep into a hot spin loop (a DB/venue hammer). Clamp to a sane floor, loudly.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The tick-interval floor in seconds — below it the daemon would hammer the DB + venue. */
export const MIN_TICK_SEC = 5;

/** Resolve the tick interval from TRADE_TICK_SEC (else bot.tickIntervalSec, else 30), clamped to the
 *  MIN_TICK_SEC floor. `clamped` tells the caller to WARN. PURE — unit-tested. */
export function resolveTickSec(envVal: string | undefined, cfgTickSec: number): { tickSec: number; clamped: boolean } {
  const raw = Number(envVal ?? cfgTickSec) || 30; // 0/NaN/'' → the 30s default (pre-existing semantics)
  return raw >= MIN_TICK_SEC ? { tickSec: raw, clamped: false } : { tickSec: MIN_TICK_SEC, clamped: true };
}

async function sleep(ms: number, stop: () => boolean): Promise<void> {
  // wake early on a shutdown request (poll every 250ms) so SIGINT flattens the loop promptly.
  const until = Date.now() + ms;
  while (Date.now() < until && !stop()) {
    await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
  }
}

export async function main(): Promise<number> {
  loadEnv();
  const mode = resolveTradeMode((n) => process.env[n]);

  if (mode === 'off') {
    log({ msg: 'trade-bot.exit', reason: 'TRADE_MODE=off — the rail is inert; nothing constructed, no key read' });
    return 0;
  }

  const sdb: ScriptDb = makeScriptDb();
  const db = makeTradingDb(sdb);
  const notify = makeNotify(process.env['SLACK_WEBHOOK_URL']);
  const ledger = rpcOrderLedger(db);

  // ── SINGLE-INSTANCE GUARD (finding #16) ─────────────────────────────────────────────────────────
  // Two concurrent same-mode daemons can OVER-SELL: daemon B, deciding from a snapshot that predates
  // daemon A's just-posted FAK exit, adjudicates A's live partial FAK as a venue-dead corpse and re-fires
  // the full stale remainder. A session advisory lock (held until this process's DB session ends) makes
  // the second instance refuse to start — dry-run and live alike (mode-scoped: the two may coexist).
  try {
    if (!(await acquireTradeBotLock(sdb, mode))) {
      log({
        msg: 'trade-bot.fatal',
        level: 'CRITICAL',
        error: `another trade-bot instance already holds the '${mode}' single-instance lock — refusing to start`,
        hint: 'stop the other daemon first (two concurrent daemons can over-sell via FAK adjudication from a stale snapshot); the lock frees automatically when its session ends',
      });
      await sdb.end();
      return 1;
    }
  } catch (e) {
    log({ msg: 'trade-bot.fatal', level: 'CRITICAL', error: redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)), hint: 'single-instance lock probe failed — is DATABASE_URL reachable?' });
    await sdb.end();
    return 1;
  }

  // Construct the CLOB client ONCE (shared across placements + book reads) — dry-run + live both need it
  // (dry-run signs the would-be order to log the exact redacted payload). The key is read INSIDE
  // createClobClientWithIdentity (packages/trading/live.ts, §15) — never here; only the PUBLIC on-chain
  // maker address comes back (the sell-truth read's maker-leg attribution key).
  let client: MakerClobClientish;
  let address: string | null = null;
  try {
    const identity = await createClobClientWithIdentity();
    client = identity.client;
    address = identity.address;
  } catch (e) {
    log({ msg: 'trade-bot.fatal', level: 'CRITICAL', error: redactText(e instanceof Error ? e.message : String(e)), hint: `dry-run + live require the wallet signing key (${'POLY_' + 'PRIVATE_KEY'}) in .env.local (to sign the would-be order); TRADE_MODE=off needs no key` });
    await sdb.end();
    return 1;
  }
  const clientFactory = (): Promise<MakerClobClientish> => Promise.resolve(client);
  const executor = new MakerExecutor({ db, client: clientFactory, notify, getEnvVar: (n) => process.env[n] });
  const d: Daemon = { mode, db, ledger, executor, client, notify, address, warnedDust: new Set() };

  // ── STARTUP ────────────────────────────────────────────────────────────────────────────────────
  let config: TradeConfig;
  try {
    config = await loadTradeConfig(db);
  } catch (e) {
    log({ msg: 'trade-bot.fatal', level: 'CRITICAL', error: redactText(e instanceof Error ? e.message : String(e)), hint: 'trade_config_get failed — is migration 0082 applied?' });
    await sdb.end();
    return 1;
  }
  const botCfg = parseBotConfig(await db.getConfigRows());
  const botCities = botCfg.cities;
  const minOrderSizeShares = botCfg.minOrderSizeShares;

  // the strategy centers on the CALIBRATED forecast (POST-FABLE steady-state + the 73.9% CONVERGENCE-TUNING
  // selector). The daemon reads the capture stream's houseProb, which reflects bot.consensusSource — so it
  // WARNs (once) if the operator has not flipped the seed to 'calibrated'. Not fatal (the daemon still runs
  // on whatever the captures carry) — but the tuned edge assumes the calibrated selector.
  if (botCfg.consensusSource !== 'calibrated') {
    log({ msg: 'trade-bot.warn', level: 'WARN', warn: 'bot.consensusSource is not "calibrated"', value: botCfg.consensusSource, hint: 'the tuned maker-exit edge selects the forecast-center bucket via the CALIBRATED house seed (CONVERGENCE-TUNING 73.9% vs 52.8%); flip bot.consensusSource=calibrated so the capture stream seeds it' });
  }

  // boot probe: is the ledger's dangling-sweep RPC live? (false ⇒ reconcile is inert / 0082 not applied)
  const scope: TradeMode = mode === 'live' ? 'live' : 'dry-run';
  if (!(await danglingEnvelopeReady(db, scope))) {
    await notify({ kind: 'BOT_DEADMAN', severity: 'WARN', title: 'trade-bot: order-ledger dangling sweep not ready', body: `bot_order_list_dangling did not return a well-formed {rows:[…]} envelope for mode=${scope} — the startup reconcile is INERT (migration 0082 not applied or version-skewed). Fix before a live run.`, dedupeKey: 'trade-bot-dangling-notready' });
  }

  // startup reconcile — STARTUP ONLY, before the first tick (never mid-run — the ledger contract). Live-only
  // inside the executor; a crash+restart <5min leaves a just-reserved intent unadjudicated until it ages
  // (safe: the key stays reserved, a re-place is 'duplicate', reconcile is startup-only).
  try {
    const outcomes = await executor.reconcileOpenOrders();
    if (outcomes.length > 0) log({ msg: 'trade-bot.reconcile', outcomes: outcomes.map((o) => ({ kind: o.kind, intentKey: o.intentKey, reason: o.reason })) });
  } catch (e) {
    log({ msg: 'trade-bot.reconcile_failed', level: 'CRITICAL', error: redactText(e instanceof Error ? e.message : String(e)) });
  }

  // finding #26 — clamp negative/sub-second intervals (a typo'd TRADE_TICK_SEC=-30 spun the loop hot).
  const { tickSec, clamped } = resolveTickSec(process.env['TRADE_TICK_SEC'], botCfg.tickIntervalSec);
  if (clamped) {
    log({ msg: 'trade-bot.warn', level: 'WARN', warn: `tick interval below the ${MIN_TICK_SEC}s floor — clamped`, tickSec, hint: 'TRADE_TICK_SEC (or bot.tickIntervalSec) was negative/sub-floor; a hot loop would hammer the DB + venue' });
  }
  log({ msg: 'trade-bot.start', mode, tickSec, cities: config.cityAllowlist ?? botCities, stakePerBuyUsd: config.stakePerBuyUsd, perMarketCapUsd: config.perMarketCapUsd, totalConcurrentCapUsd: config.totalConcurrentCapUsd, activeUntil: config.activeUntil });

  // ── GRACEFUL SHUTDOWN — leave resting orders (maker orders ARE the strategy); log open state loudly. ──
  let stopping = false;
  const onSignal = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log({ msg: 'trade-bot.shutdown', level: 'WARN', signal: sig, note: 'RESTING ORDERS LEFT IN PLACE (maker orders are the strategy) — verify open state on Polymarket / dash_trading before restart' });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // ── MAIN LOOP ────────────────────────────────────────────────────────────────────────────────────
  const runtime = makeTickRuntime();
  while (!stopping) {
    try {
      await tick(d, botCities, minOrderSizeShares, runtime);
    } catch (e) {
      // a whole-tick failure is logged CRITICAL + alerted, but the loop SURVIVES (the next tick re-derives
      // all state from the ledger + venue — never memory — so a transient failure self-heals).
      const message = redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      log({ msg: 'trade-bot.tick_failed', level: 'CRITICAL', error: message });
      await notify({ kind: 'CIRCUIT_BREAK', severity: 'CRITICAL', title: 'trade-bot tick failed', body: message, dedupeKey: `trade-bot-tick:${Math.floor(Date.now() / 300000)}` });
    }
    if (!stopping) await sleep(tickSec * 1000, () => stopping);
  }

  await sdb.end();
  log({ msg: 'trade-bot.stopped' });
  return 0;
}

// Run only when invoked directly (importing this module in a test never starts the loop).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      log({ msg: 'trade-bot.crash', level: 'CRITICAL', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      process.exit(1);
    });
}
