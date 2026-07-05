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
 *   TRADE_TICK_SEC             optional tick interval (default = bot.tickIntervalSec ≈ 30)
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
  createClobClient,
  danglingEnvelopeReady,
  loadTradeConfig,
  orderIntentKey,
  preflightLive,
  redactText,
  resolveTradeMode,
  parseTrades,
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
  type TradingDb,
} from '../packages/trading/src/index.ts';
import { buildAlertBlocks, slackPost } from '../packages/io/src/index.ts';
import {
  applyPlan,
  assemblePosition,
  decideTick,
  discoverCandidates,
  sellHoldAlerts,
  toDecideCfg,
  type DecideCfg,
  type DiscoveredCandidate,
  type LivePosition,
} from './lib/trade-bot-decide.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';
import { makeTradingDb } from './lib/trading-db.ts';

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
// Reconstruction meta — the market → position identity map, from the latest capture per event.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
interface EventMeta {
  marketId: string; // the forecast-center bucket's conditionId
  tokenId: string; // its YES token
  city: string;
  targetDate: string;
  tz: string;
  modelProb: number;
  resolvesAtMs: number | null;
  /** the center bucket's captured execBid — the dry-run exit mark (no live book fetch in dry-run). */
  execBidCapture: number | null;
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const tms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Per event's LATEST capture, the argmax-houseProb bucket → its market identity. Covers positions past the
 *  entry window too, so a still-open position is always reconstructable within the capture window. */
function buildEventMeta(captures: RawCaptureRow[]): Map<string, EventMeta> {
  const latest = new Map<string, RawCaptureRow>();
  for (const r of Array.isArray(captures) ? captures : []) {
    if (r?.eventId == null) continue;
    const prev = latest.get(r.eventId);
    if (!prev || tms(r.capturedAt) > tms(prev.capturedAt)) latest.set(r.eventId, r);
  }
  const out = new Map<string, EventMeta>();
  for (const r of latest.values()) {
    const buckets = Array.isArray(r.buckets) ? r.buckets : [];
    let best: { prob: number; b: (typeof buckets)[number] } | null = null;
    for (const b of buckets) {
      const prob = finite(b?.houseProb) ? Number(b.houseProb) : NaN;
      if (finite(prob) && (best == null || prob > best.prob)) best = { prob, b };
    }
    if (!best || !best.b?.conditionId || !best.b?.tokenYes) continue;
    out.set(String(best.b.conditionId), {
      marketId: String(best.b.conditionId),
      tokenId: String(best.b.tokenYes),
      city: String(r.city ?? ''),
      targetDate: String(r.targetDate ?? ''),
      tz: String(r.tzName ?? ''),
      modelProb: best.prob,
      resolvesAtMs: finite(tms(r.resolvesAt)) ? tms(r.resolvesAt) : null,
      execBidCapture: finite(best.b.execBid) ? Number(best.b.execBid) : null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The daemon
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Daemon {
  mode: TradeMode;
  db: TradingDb;
  ledger: OrderLedger;
  executor: MakerExecutor;
  client: MakerClobClientish;
  notify: (a: TradeAlert) => Promise<boolean>;
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
 */
async function refreshFill(
  d: Daemon,
  row: OrderLedgerRow | null,
): Promise<OrderLedgerRow | null> {
  if (row == null || d.mode !== 'live') return row;
  if (row.orderId == null || (row.status !== 'placed' && row.status !== 'partial')) return row;
  try {
    const poll = await d.executor.pollFill(row.orderId, row.size);
    if (poll.sizeMatched > row.sizeMatched + 1e-9) {
      await d.ledger.recordFill(
        row.clientOrderId,
        poll.sizeMatched,
        poll.avgPrice ?? row.price,
        poll.filled ? 'filled' : 'partial',
      );
      return (await d.ledger.findByIntentKey(row.intentKey, d.mode)) ?? row;
    }
  } catch (e) {
    await d.notify({
      kind: 'ORDER_NEEDS_RECONCILE',
      severity: 'CRITICAL',
      title: `trade-bot fill-poll/record failed: ${row.marketId} ${row.purpose}`,
      body: redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
      dedupeKey: `trade-bot-poll:${row.clientOrderId}`,
    });
  }
  return row;
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
 * Venue sell truth for one token (live only): Σ our SELL trade sizes from `getTrades` — the same evidence
 * read the startup reconcile uses. This floors the position's `soldSize` so fills whose ledger rows have
 * gone terminal-canceled (a lifted-then-cancelled TP, an adjudicated FAK corpse — invisible to
 * `bot_order_by_intent`) are never lost (lens CRITICAL-1/LOW-5). Failed venue trades are excluded.
 *
 * The read is SAFETY-LOAD-BEARING (lens NEW-LOW-1): on a live read outage it returns
 * `{ sold: null, degraded: true }` — the position's sells are then HELD for the tick (the decide spine
 * refuses to size any SELL from a possibly-understated soldSize) and the daemon fires a CRITICAL
 * `sellHoldAlerts` alert. dry-run: `{ sold: null, degraded: false }` — no venue read is applicable and
 * dry-run rows never fill, so the visible ledger sum is exact.
 */
async function venueSoldFor(d: Daemon, tokenId: string): Promise<{ sold: number | null; degraded: boolean }> {
  if (d.mode !== 'live') return { sold: null, degraded: false }; // dry-run rows never fill — visible sum exact
  try {
    const trades = parseTrades(await d.client.getTrades({ asset_id: tokenId }));
    let sold = 0;
    for (const t of trades) {
      if (t.side.toUpperCase() !== 'SELL') continue;
      if (t.status.toUpperCase() === 'FAILED') continue;
      sold += t.size;
    }
    return { sold, degraded: false };
  } catch (e) {
    log({ msg: 'trade-bot.venue_sold_failed', level: 'WARN', tokenId, error: redactText(e instanceof Error ? e.message : String(e)) });
    return { sold: null, degraded: true };
  }
}

/**
 * Reconstruct every open position from the LEDGER + the VENUE (never memory) — the crash-resume contract.
 * For each market in the capture window, look up the entry intent; markets WITH an entry become positions
 * (their tp/sl/time-stop handles + fill state refreshed, their live mark + venue sell truth read). Bounded
 * by the capture universe; markets whose captures have aged past the window are not reconstructable here
 * (see the report's flagged gap — a dedicated `list_open_live_orders` RPC would remove the bound, but 0082
 * is final).
 */
async function reconstructPositions(
  d: Daemon,
  metaByMarket: Map<string, EventMeta>,
): Promise<LivePosition[]> {
  const positions: LivePosition[] = [];
  for (const meta of metaByMarket.values()) {
    let entry = await findOrder(d.ledger, d.mode, meta.marketId, 'BUY', 'entry', meta.targetDate);
    if (entry == null) continue; // no position in this market
    entry = await refreshFill(d, entry);
    if (entry == null) continue;

    let tp = await findOrder(d.ledger, d.mode, meta.marketId, 'SELL', 'take_profit', meta.targetDate);
    let sl = await findOrder(d.ledger, d.mode, meta.marketId, 'SELL', 'stop_loss', meta.targetDate);
    let ts = await findOrder(d.ledger, d.mode, meta.marketId, 'SELL', 'time_stop', meta.targetDate);
    tp = await refreshFill(d, tp);
    sl = await refreshFill(d, sl);
    ts = await refreshFill(d, ts);

    const mark = await markFor(d, meta.tokenId, entry.sizeMatched || entry.size, meta.execBidCapture);
    const venueSold = await venueSoldFor(d, meta.tokenId);
    const pos = assemblePosition({
      meta: {
        marketId: meta.marketId,
        tokenId: meta.tokenId,
        city: meta.city,
        targetDate: meta.targetDate,
        tz: meta.tz,
        modelProb: meta.modelProb,
        resolvesAtMs: meta.resolvesAtMs,
      },
      entry,
      tp,
      stopLoss: sl,
      timeStop: ts,
      mark,
      venueSoldSize: venueSold.sold,
      soldTruthDegraded: venueSold.degraded,
    });
    if (pos) positions.push(pos);
  }
  return positions;
}

interface CaptureInputs {
  captures: RawCaptureRow[];
  resolutions: unknown[];
}

/** One tick: discover → reconstruct → preflight (live) → decide → apply → heartbeat. */
async function tick(d: Daemon, botCitiesFallback: string[], minOrderSizeShares: number): Promise<void> {
  const now = new Date();

  // config re-read each tick — mode/caps/allowlist can change under the running daemon.
  const config: TradeConfig = await loadTradeConfig(d.db);
  const allowlist = config.cityAllowlist && config.cityAllowlist.length > 0 ? config.cityAllowlist : botCitiesFallback;
  const cfgFull = makerExitCfg(allowlist);
  const cfg: DecideCfg = toDecideCfg(cfgFull, minOrderSizeShares);

  // discovery — the fresh capture window (p_days=2 covers a position's whole 1–2 day lifetime for the
  // reconstruction pass; discoverCandidates itself only enters currently-enterable buckets).
  let captures: RawCaptureRow[] = [];
  try {
    const rows = await d.db.rpc<{ convergence_capture_inputs: CaptureInputs }>('convergence_capture_inputs', {
      p_days: 2,
      p_cities: allowlist,
    });
    captures = rows[0]?.convergence_capture_inputs?.captures ?? [];
  } catch (e) {
    log({ msg: 'trade-bot.discovery_failed', level: 'WARN', error: redactText(e instanceof Error ? e.message : String(e)) });
  }

  const candidates: DiscoveredCandidate[] = discoverCandidates(captures, cfgFull, now);
  const metaByMarket = buildEventMeta(captures);
  const positions = await reconstructPositions(d, metaByMarket);

  // NEW-LOW-1 — the degraded-mode sell hold is escalated CRITICAL every affected tick (never silent):
  // a position whose venue sell-truth read failed has its taker exits + TP rest paused this tick.
  for (const a of sellHoldAlerts(positions)) await d.notify(a);

  // preflight interlock — LIVE only (a pure read; dry-run/off never post live so never gate on it).
  let preflight: TradePreflight | null = null;
  if (d.mode === 'live') {
    try {
      preflight = await preflightLive(d.db);
    } catch (e) {
      log({ msg: 'trade-bot.preflight_failed', level: 'CRITICAL', error: redactText(e instanceof Error ? e.message : String(e)) });
      preflight = { ok: false, reasons: ['preflight read failed'], checks: {} as TradePreflight['checks'] };
    }
  }

  const plan = decideTick({ mode: d.mode, config, preflight, cfg, now, candidates, positions });
  const applied = await applyPlan(plan, d.executor, d.notify, log, d.ledger);

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
    activeUntil: config.activeUntil,
  });

  await heartbeat(d, plan.intents.length, applied);
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
): Promise<void> {
  try {
    await d.db.rpc('record_bot_tick', {
      p_payload: {
        mode: d.mode,
        ran: true,
        placed: nIntents,
        filled: applied.posted + applied.dryRun,
        exited: 0,
        gateReason: `trade-bot ${d.mode} (posted ${applied.posted}, dry ${applied.dryRun}, failed ${applied.failed})`,
      },
    });
  } catch (e) {
    log({ msg: 'trade-bot.heartbeat_failed', level: 'WARN', error: redactText(e instanceof Error ? e.message : String(e)) });
  }
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

  // Construct the CLOB client ONCE (shared across placements + book reads) — dry-run + live both need it
  // (dry-run signs the would-be order to log the exact redacted payload). The key is read INSIDE
  // createClobClient (packages/trading/live.ts, §15) — never here.
  let client: MakerClobClientish;
  try {
    client = await createClobClient();
  } catch (e) {
    log({ msg: 'trade-bot.fatal', level: 'CRITICAL', error: redactText(e instanceof Error ? e.message : String(e)), hint: `dry-run + live require the wallet signing key (${'POLY_' + 'PRIVATE_KEY'}) in .env.local (to sign the would-be order); TRADE_MODE=off needs no key` });
    await sdb.end();
    return 1;
  }
  const clientFactory = (): Promise<MakerClobClientish> => Promise.resolve(client);
  const executor = new MakerExecutor({ db, client: clientFactory, notify, getEnvVar: (n) => process.env[n] });
  const d: Daemon = { mode, db, ledger, executor, client, notify };

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

  const tickSec = Number(process.env['TRADE_TICK_SEC'] ?? botCfg.tickIntervalSec) || 30;
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
  while (!stopping) {
    try {
      await tick(d, botCities, minOrderSizeShares);
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
