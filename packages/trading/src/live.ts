/**
 * LiveExecutor — the real order path, DORMANT (ARCHITECTURE.md §6.20, F-032).
 *
 * Compiled + unit-tested against mocks from day one; constructible only behind
 * a passing goLiveGate (execute-bet enforces that — C1). The clob client and
 * POLY_PRIVATE_KEY live ONLY in this file (§15 grep invariant); production
 * constructs the client via dynamic npm: specifiers (Deno edge runtime),
 * tests inject a mock factory.
 *
 * Phase A semantics: GTC limit at the recommendation's executable ask
 * (taker-or-better); the maker-resting strategy is a §12 Phase-5 enhancement.
 * getOrder's response fields are mock-verified only — re-verify against the
 * live CLOB at P10 go-live (docs/GO-LIVE-CHECKLIST).
 */
import { ExecutionError, FillRejected } from '@weather-edge/core';
import {
  makerLimitPrice,
  matchDanglingIntent,
  orderIntentKey,
  parseCancelResult,
  parseOpenOrders,
  parseOrderBookTop,
  parseOrderFillPoll,
  parseTrades,
  redactOrderPayload,
  redactText,
  resolveTradeMode,
  takerLimitPrice,
  tradeCouldBeOurFill,
  tradesResponseTruncated,
} from './order-intent.ts';
import { rpcOrderLedger } from './order-ledger.ts';
import type {
  ApprovedBet,
  CancelResult,
  FillResult,
  FillRpcResult,
  MakerOrderRequest,
  OpenOrder,
  OrderFillPoll,
  OrderLedger,
  OrderPlacementResult,
  OrderType,
  ReconcileOutcome,
  TakerOrderRequest,
  TradeAlert,
  TradeExecutor,
  TradingDb,
} from './types.ts';

/** The slice of @polymarket/clob-client-v2 the Phase-A taker executor touches. */
export interface ClobClientish {
  getTickSize(tokenID: string): Promise<number | string>;
  createOrder(
    args: { tokenID: string; price: number; size: number; side: 'BUY' | 'SELL' },
    options: { tickSize: number; negRisk: boolean },
  ): Promise<unknown>;
  /** ⚠ ARG ORDER IS v2 (C75): `postOrder(order, orderType, postOnly?, deferExec?)` — v2's 3rd positional is
   *  a REAL `postOnly`, its 4th is `deferExec` (the SWAP from v4, whose 3rd was `deferExec` and which had
   *  no post_only at all). We call this **2-ARG ONLY and pass NEITHER**: maker-ness stays enforced entirely
   *  BY PRICE (`makerLimitPrice`), byte-for-byte the behavior the shadow week measured. Adopting v2's real
   *  `postOnly` is a DELIBERATE future lever — it changes fill semantics (a crossing "maker" order would be
   *  rejected instead of taking) and must not silently diverge from the shadow week, so it is gated on a
   *  live fill first proving the migration (see MakerExecutor.place / docs §5). The response's
   *  `success`/`errorMsg` fields distinguish a CLEAN VENUE REJECTION (success=false, request processed, no
   *  order created → safe to free the intent) from a transport throw or a shapeless response (order state
   *  UNKNOWN → the intent must be held for reconcile — HIGH-A). C46: HTTP-level failures surface as v2's
   *  http-helper shape `{error, status}` (no success field) — a 4xx there is ALSO a clean rejection. */
  postOrder(
    order: unknown,
    orderType: OrderType,
    postOnly?: boolean,
    deferExec?: boolean,
  ): Promise<{ orderID?: string; success?: boolean; errorMsg?: string }>;
  getOrder(orderID: string): Promise<{
    status?: string;
    price?: string | number;
    size?: string | number;
    original_size?: string | number;
    size_matched?: string | number;
    order_type?: string;
  }>;
  cancelOrder(payload: { orderID: string }): Promise<unknown>;
}

/**
 * The extended slice the MAKER-EXIT rail touches — adds the read-side book (for maker pricing) and the
 * full cancel/reconcile surface (research report §3/§4/§5). A superset of `ClobClientish`, so the same
 * live client drives both the dormant Phase-A taker path and the maker rail.
 */
export interface MakerClobClientish extends ClobClientish {
  getOrderBook(tokenID: string): Promise<unknown>;
  getOpenOrders(params?: { market?: string; asset_id?: string }): Promise<unknown>;
  /** our recent trades/fills for a token — reconcile's evidence read (research report §5). */
  getTrades(params?: { market?: string; asset_id?: string }): Promise<unknown>;
  cancelOrders(payload: { orderIDs: string[] }): Promise<unknown>;
  cancelAll(): Promise<unknown>;
  cancelMarketOrders(payload: { market?: string; asset_id?: string }): Promise<unknown>;
}

export interface LiveExecutorDeps {
  db: TradingDb;
  /** Mock in tests; createClobClient (below) in the Deno edge runtime. */
  client: () => Promise<ClobClientish>;
  notify: (alert: TradeAlert) => Promise<boolean>;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * A compact, REDACTED snapshot of a shapeless postOrder response — what actually came back when there was
 * no orderID and no clean {success:false} rejection. Without it, a 401 bad-credentials JSON, a
 * Cloudflare/geo block page (HTML), and a venue glitch are indistinguishable in the alert (the 2026-07-12
 * shanghai stuck-intent: the first-ever cloud live post failed exactly here with no way to tell which).
 * Redacted (MEDIUM-4) and truncated — safe for alert bodies and the ledger error column.
 */
function shapelessSnapshot(posted: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(posted) ?? String(posted);
  } catch {
    body = String(posted);
  }
  return redactText(`typeof=${typeof posted} body=${body.slice(0, 300)}`);
}

/** Deno.env in Edge Functions, process.env elsewhere — local copy so this package depends on nothing above it. */
function envVar(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env[name];
}

/**
 * Scope-silence the console for exactly one awaited call — used around the bootstrap `createOrDeriveApiKey`.
 * In the old V1 clob-client this suppressed its HTTP helper's `console.error` of the FULL axios error
 * (request config included — the transient L1 auth headers POLY_ADDRESS / POLY_SIGNATURE) on the EXPECTED
 * derive→create 400 fallback (C51 hygiene). clob-client-v2 no longer logs on error (its errorHandling
 * returns `{error,status}` silently — C75), so this is now DEFENSE-IN-DEPTH: any console noise emitted
 * during the one-shot bootstrap is dropped. Failures still THROW loudly through the normal ExecutionError
 * paths. Restoration is finally-guaranteed. Concurrency caveat: console is process-global, so unrelated
 * lines emitted DURING the awaited call are also dropped — acceptable for the one-shot bootstrap.
 */
export async function suppressConsoleDuring<T>(fn: () => Promise<T>): Promise<T> {
  const con = (globalThis as unknown as { console?: Record<string, unknown> }).console;
  if (!con) return fn();
  const methods = ['error', 'warn', 'log', 'info', 'debug'] as const;
  const saved: Array<[string, unknown]> = methods.map((m) => [m, con[m]]);
  const noop = (): void => {};
  for (const m of methods) con[m] = noop;
  try {
    return await fn();
  } finally {
    for (const [m, f] of saved) con[m] = f;
  }
}

/**
 * A REDACTING sibling of `suppressConsoleDuring` (C74 credential-leak hardening; C75 v2). Where suppress
 * DROPS all console output for one awaited call, this FORWARDS it — but each argument is first passed through
 * `redactText`, so credential material a DEPENDENCY prints stays masked. This was introduced to close the
 * acute v4 leak (the old V1 clob-client's HTTP helper `console.error`d the FULL axios error — request
 * `config.headers` INCLUDED, i.e. the L2 auth trio POLY_API_KEY / POLY_PASSPHRASE / POLY_SIGNATURE —
 * bypassing every one of OUR redactText catch paths). clob-client-v2 no longer logs on error, so the wrapper
 * is now DEFENSE-IN-DEPTH: any console path (a future dep, a v2 change, our own code) that ever prints an
 * error object carrying the L2 creds is masked here. The operator still sees the status + venue-error text;
 * only the secrets become `…REDACTED`.
 *
 * Concurrency-safe by DEPTH-COUNTING a single global install: the first entrant saves + installs the
 * redacting console, nested/concurrent entrants reuse it, and the console is restored ONLY when the last
 * one exits — so an interleaved pair can never restore the real console while another call is still
 * mid-flight (the hazard a naive per-call save/restore would have under daemon concurrency).
 */
let redactConsoleDepth = 0;
let redactConsoleSaved: Array<[string, (...a: unknown[]) => void]> | null = null;

function redactConsoleArg(a: unknown): unknown {
  if (typeof a === 'string') return redactText(a);
  if (a instanceof Error) return redactText(`${a.name}: ${a.message}`);
  try {
    return redactText(JSON.stringify(a));
  } catch {
    return '…REDACTED';
  }
}

export async function withRedactedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const con = (globalThis as unknown as { console?: Record<string, (...a: unknown[]) => void> }).console;
  if (!con) return fn();
  const methods = ['error', 'warn', 'log', 'info', 'debug'] as const;
  if (redactConsoleDepth === 0) {
    redactConsoleSaved = methods.map((m) => [m, con[m]] as [string, (...a: unknown[]) => void]);
    for (const [m, orig] of redactConsoleSaved) {
      con[m] = (...args: unknown[]): void => orig(...args.map(redactConsoleArg));
    }
  }
  redactConsoleDepth++;
  try {
    return await fn();
  } finally {
    redactConsoleDepth--;
    if (redactConsoleDepth === 0 && redactConsoleSaved) {
      for (const [m, f] of redactConsoleSaved) con[m] = f;
      redactConsoleSaved = null;
    }
  }
}

/**
 * Wrap a live CLOB client so EVERY venue-touching call runs inside `withRedactedConsole` (C74/C75). This is
 * the single chokepoint for the credential-log defense: if any error logging (the old v4 client's own, a
 * future dep, or our code) ever fires on a venue 4xx from postOrder / cancel / the authed reads — not only
 * the paths WE catch — wrapping the client at the `bootstrapClobClient` seam masks it across the daemon
 * (`trade-bot.ts`), the `execute-bet` LiveExecutor, AND the operator smoke at once, with no per-call-site
 * change. (clob-client-v2 itself no longer logs on error, so today this is defense-in-depth.) Only the known
 * async venue methods are proxied (an allowlist), so non-function properties and `this`/state pass through
 * untouched and the method's RETURN value is unchanged — redaction is log-only, never a behavior change on
 * the order path.
 */
const REDACTED_CLIENT_METHODS: ReadonlySet<string> = new Set([
  'getTickSize', 'createOrder', 'createMarketOrder', 'postOrder', 'postOrders', 'getOrder', 'getOpenOrders',
  'getTrades', 'getOrderBook', 'getOrderBooks', 'cancelOrder', 'cancelOrders', 'cancelAll', 'cancelMarketOrders',
]);

export function redactConsoleClient<C extends object>(client: C): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && typeof val === 'function' && REDACTED_CLIENT_METHODS.has(prop)) {
        const fn = val as (...a: unknown[]) => unknown;
        return (...args: unknown[]): Promise<unknown> => withRedactedConsole(() => Promise.resolve(fn.apply(target, args)));
      }
      return val;
    },
  });
}

/**
 * Production client factory: `@polymarket/clob-client-v2` ClobClient (options object — host, chain=137,
 * ethers signer from POLY_PRIVATE_KEY, creds via createOrDeriveApiKey, signatureType, funderAddress).
 *
 * WHY v2 (C75): the venue's CLOB V2 exchange cutover (~2026-04-28) bumped the EIP-712 order domain version
 * 1→2; the whole old `@polymarket/clob-client` line signs V1 orders and the venue now 400s them
 * ("invalid order version"). v2 resolves the order version at RUNTIME — `createOrder` calls
 * `resolveVersion()`→`getVersion()` (cached; defaults to 2) so it signs a V2 order, and `postOrder`
 * self-heals on an `order_version_mismatch` response (`resolveVersion(true)`) so a future V2→V3 bump
 * re-resolves without a code change. That dynamic resolution IS the fix.
 *
 * The ethers@5 Wallet stays a valid v2 signer: v2's `ClobSigner` union feature-detects `_signTypedData`
 * (the EthersSigner branch) — no viem needed on our side. sigType 2 === `SignatureTypeV2.POLY_GNOSIS_SAFE`
 * (unchanged numeric from v4). Dynamic non-literal specifiers stay so tsc/Node never eager-resolve them
 * (§15: the client + key live only here); Deno resolves the npm: specifier at run time.
 */
async function bootstrapClobClient(): Promise<{
  client: MakerClobClientish;
  creds: unknown;
  sigType: number;
  funderSet: boolean;
  /** the on-chain maker/funder address our orders carry (funder when set, else the signer address) —
   *  PUBLIC info (it is on every order we post), needed to attribute maker legs in venue trade records. */
  address: string | null;
}> {
  const key = envVar('POLY_PRIVATE_KEY');
  if (!key) {
    throw new ExecutionError('ERR_NO_KEY', 'POLY_PRIVATE_KEY missing from execute-bet function secrets');
  }
  // Runtime-aware specifiers: Deno (Edge Functions) resolves npm: at run time; Node (the local daemon/smoke,
  // pnpm tsx) needs the bare installed package (a workspace dep of @weather-edge/trading). Both stay
  // NON-LITERAL dynamic imports so tsc never tries to resolve them (§15: the client exists only here).
  const isDeno = (globalThis as { Deno?: unknown }).Deno != null;
  const ethersSpec = isDeno ? 'npm:ethers@5' : 'ethers';
  const clobSpec = isDeno ? 'npm:@polymarket/clob-client-v2@1' : '@polymarket/clob-client-v2';
  const { Wallet } = (await import(ethersSpec)) as { Wallet: new (k: string) => { address?: string } };
  // v2's constructor is an OPTIONS OBJECT (chain not chainId, funderAddress not funder, signatureType). The
  // numeric fields are cast so tsc need not resolve v2's Chain / SignatureTypeV2 enums (137 === Chain.POLYGON,
  // 2 === SignatureTypeV2.POLY_GNOSIS_SAFE).
  const { ClobClient } = (await import(clobSpec)) as {
    ClobClient: new (opts: {
      host: string;
      chain: number;
      signer: unknown;
      creds?: unknown;
      signatureType?: number;
      funderAddress?: string;
    }) => MakerClobClientish & { createOrDeriveApiKey(): Promise<unknown> };
  };
  const signer = new Wallet(key);
  const sigType = Number(envVar('POLY_SIGNATURE_TYPE') ?? 0);
  const funder = envVar('POLY_FUNDER_ADDRESS');
  const host = 'https://clob.polymarket.com';
  const bootstrap = new ClobClient({ host, chain: 137, signer, signatureType: sigType, funderAddress: funder });
  // The 400-fallback inside this call is EXPECTED (derive→create) — see suppressConsoleDuring.
  const creds = await suppressConsoleDuring(() => bootstrap.createOrDeriveApiKey());
  // C74/C75: wrap the live client at the seam in the redacting console guard — DEFENSE-IN-DEPTH. v2's
  // http-helper returns {error,status} WITHOUT logging, so the acute v4 leak (its errorHandling
  // console.error'd the full axios error, auth headers included) is removed BY the upgrade itself; the
  // wrapper stays so any console path that ever prints an error object carrying the L2 creds is masked
  // through one chokepoint (daemon + smoke). Redaction is log-only; order values pass through untouched.
  const client = redactConsoleClient(
    new ClobClient({ host, chain: 137, signer, creds, signatureType: sigType, funderAddress: funder }),
  );
  const funderSet = funder != null && funder !== '';
  return { client, creds, sigType, funderSet, address: (funderSet ? funder : signer.address) ?? null };
}

export async function createClobClient(): Promise<MakerClobClientish> {
  return (await bootstrapClobClient()).client;
}

/**
 * `createClobClient` + the trading identity the venue's TAKER-centric trade records need: our on-chain
 * maker/funder address (POLY_FUNDER_ADDRESS when set, else the signer's address). The address is PUBLIC
 * (it rides on every order we post) — the key itself never leaves this file (§15). The daemon threads it
 * into the sell-truth read so OUR maker legs in `getTrades` can be told apart from sibling makers'.
 */
export async function createClobClientWithIdentity(): Promise<{
  client: MakerClobClientish;
  address: string | null;
}> {
  const b = await bootstrapClobClient();
  return { client: b.client, address: b.address };
}

/**
 * SMOKE-ONLY credential preview (scripts/trade-smoke.ts, GO-LIVE-CHECKLIST-OPENING.md §3). Derives the L2
 * CLOB creds from `POLY_PRIVATE_KEY` (via the same bootstrap as `createClobClient`) and returns a REDACTED
 * preview: the api-key uuid's first 8 chars ONLY, the signature type, and whether a funder is configured —
 * NEVER the secret, the passphrase, or the private key. §15: the key + the client stay inside this file; the
 * caller receives only these non-sensitive facts to print a "derived OK" line.
 */
export async function deriveClobApiKeyPreview(): Promise<{ apiKeyPreview: string; sigType: number; funderSet: boolean }> {
  const { creds, sigType, funderSet } = await bootstrapClobClient();
  const c = (creds ?? {}) as { key?: unknown; apiKey?: unknown };
  const apiKey = String(c.key ?? c.apiKey ?? '');
  return { apiKeyPreview: apiKey ? `${apiKey.slice(0, 8)}…` : '(none returned)', sigType, funderSet };
}

/**
 * OFFLINE identity derivation (scripts/derive-deposit-wallet.ts, C46d): the PUBLIC trading identity the
 * env implies — the owner EOA (new Wallet(key).address), the configured funder + signature type, and
 * whether the funder IS the owner EOA (the deposit-wallet misconfig check). No venue call, no creds.
 * All fields are PUBLIC-CLASS (an address rides on every order; the sig type is a 0-3 mode flag) —
 * the key itself never leaves this file (§15).
 */
export async function deriveOwnerIdentity(): Promise<{
  ownerEoa: string;
  funder: string | null;
  sigType: number;
  funderIsOwner: boolean;
}> {
  const key = envVar('POLY_PRIVATE_KEY');
  if (!key) {
    throw new ExecutionError('ERR_NO_KEY', 'POLY_PRIVATE_KEY missing from the environment');
  }
  const isDeno = (globalThis as { Deno?: unknown }).Deno != null;
  const ethersSpec = isDeno ? 'npm:ethers@5' : 'ethers';
  const { Wallet } = (await import(ethersSpec)) as { Wallet: new (k: string) => { address: string } };
  const ownerEoa = new Wallet(key).address;
  const funder = envVar('POLY_FUNDER_ADDRESS') ?? null;
  return {
    ownerEoa,
    funder,
    sigType: Number(envVar('POLY_SIGNATURE_TYPE') ?? 0),
    funderIsOwner: (funder ?? '').toLowerCase() === ownerEoa.toLowerCase(),
  };
}

export class LiveExecutor implements TradeExecutor {
  readonly mode = 'live' as const;

  constructor(private readonly deps: LiveExecutorDeps) {}

  async place(bet: ApprovedBet): Promise<FillResult> {
    const { db, notify } = this.deps;
    let orderId: string | undefined;
    let limit = bet.execAsk;
    try {
      const client = await this.deps.client();
      // Tick-size & min-size re-fetched per market; BUY limit rounds DOWN to
      // the grid — never pay above the recommendation's executable ask.
      const tick = Number(await client.getTickSize(bet.tokenYes));
      if (tick > 0) limit = round6(Math.floor((bet.execAsk + 1e-9) / tick) * tick);
      if (bet.recShares < bet.minOrderSize) {
        throw new ExecutionError(
          'ERR_MIN_SIZE',
          `recShares ${bet.recShares} < market min order size ${bet.minOrderSize}`,
        );
      }
      const order = await client.createOrder(
        { tokenID: bet.tokenYes, price: limit, size: bet.recShares, side: 'BUY' },
        { tickSize: tick, negRisk: true },
      );
      const posted = await client.postOrder(order, 'GTC');
      orderId = posted?.orderID;
      if (!orderId) {
        throw new ExecutionError('ERR_CLOB_POST', `postOrder returned no orderID (${shapelessSnapshot(posted)})`);
      }

      const status = await client.getOrder(orderId);
      if (status?.status === 'matched') {
        const px = round6(Number(status.price ?? limit));
        const matched = Math.floor(Number(status.size_matched ?? bet.recShares));
        const [res] = await db.rpc<{ fill_bet_with_caps: FillRpcResult }>('fill_bet_with_caps', {
          p_bet_id: bet.betId,
          p_price: px,
          p_shares: matched,
        });
        const out = res?.fill_bet_with_caps;
        if (out?.outcome !== 'filled') {
          // A real order matched but the record was refused — operational
          // anomaly (poll-markets sized within caps); surface loudly.
          throw new ExecutionError(
            'ERR_FILL_RECORD',
            `live order ${orderId} matched but fill record refused: ${out?.outcome} ${(out?.details ?? []).join('; ')}`,
          );
        }
        return { price: Number(out.price), shares: Number(out.shares), feeUsd: Number(out.feeUsd), mode: 'live' };
      }

      // Posted but unmatched: record the resting GTC so poll-markets' expiry
      // can pull it via execute-bet {action:'cancel'} (§6.20a chokepoint).
      await db.rpc('note_resting_order', { p_bet_id: bet.betId, p_order_id: orderId });
      return { price: limit, shares: 0, feeUsd: 0, mode: 'live' };
    } catch (e) {
      // NEVER retries placement automatically — no accidental doubles
      // (idempotency by client order id). Bet → 'execution_failed' + CRITICAL.
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await db.rpc('set_bet_execution_failed', { p_bet_id: bet.betId, p_error: message });
      await notify({
        kind: 'EXECUTION_FAIL',
        severity: 'CRITICAL',
        title: `Live execution failed: ${bet.eventSlug} · ${bet.label}`,
        body: `${message}${orderId ? `\norder ${orderId} may be resting — verify on Polymarket` : ''}`,
        dedupeKey: `exec-fail:${bet.betId}`,
      });
      if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
      throw new ExecutionError('ERR_CLOB', message);
    }
  }

  /** Pull a resting GTC order recorded by place() (notes 'resting:{orderID}'). */
  async cancel(betId: string): Promise<void> {
    const [row] = await this.deps.db.rpc<{ bet_for_execution: { notes?: string | null } | null }>(
      'bet_for_execution',
      { p_bet_id: betId },
    );
    const notes = row?.bet_for_execution?.notes ?? '';
    const m = /resting:(\S+)/.exec(notes);
    if (!m) return; // nothing resting — cancel is a no-op
    const client = await this.deps.client();
    await client.cancelOrder({ orderID: m[1]! });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// MakerExecutor — the tuned MAKER-EXIT strategy's live order rail (T1, amended per the F4/CRITICAL-1
// adjudication).
//
// Extends the dormant taker rail above with: (1) MAKER placement (resting GTC/GTD, maker-ness enforced
// BY PRICE — BUY strictly below best ask, SELL strictly above best bid; clob-client-v2 DOES expose a real
// post_only but we do NOT pass it (C75 decision), so price remains the ONLY guarantee, unchanged from the
// shadow week); (2) the order lifecycle (cancel / cancel-all-for-market / list /
// fill-poll with partial-fill accounting / cancel-then-repost reprice / startup reconcile); (3)
// MODE-SCOPED DB-ledger idempotency — a retry or crash-restart NEVER double-places, and a failure
// AFTER a successful post NEVER frees the intent key: the row stays 'placed' and a needs-reconcile
// CRITICAL fires (only a provably pre-post failure reaches recordFailed); (4) a `TRADE_MODE`
// (off | dry-run | live) that defaults to dry-run and can only reach a real post via the explicit
// `TRADE_MODE=live`. Dry-run RECORDS its intents in the ledger under mode='dry-run' (the shadow
// harness reads them) but NEVER posts/cancels at the venue; the (mode, intent_key) partial-unique
// ledger key means a dry-run row can never block a live intent. Every error string that leaves the
// executor (ledger error column, alert bodies, thrown messages) passes through redactText. T3-final:
// a raise from ANY record_* RPC (unknown client_order_id) on the live money path routes to a
// needs-reconcile CRITICAL via `ledgerWriteOrAlert` — never into the key-freeing branch. Mock-tested
// from day one exactly like `LiveExecutor`; the wallet key + clob client stay inside this file (§15).
// A taker FAK exit (`placeTaker`) completes the strategy's stop-loss / time-stop leg.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

export interface MakerExecutorDeps {
  db: TradingDb;
  /** Mock in tests; `createClobClient` in the live runtime. */
  client: () => Promise<MakerClobClientish>;
  notify: (alert: TradeAlert) => Promise<boolean>;
  /** Deno.env.get / process.env probe — `TRADE_MODE` gate. */
  getEnvVar: (name: string) => string | undefined;
  /** The idempotency + lifecycle ledger. Defaults to `rpcOrderLedger(db)` (goes through TradingDb). */
  ledger?: OrderLedger;
  /** Client-order-id minter — injected for deterministic tests; defaults to `crypto.randomUUID`.
   *  MUST return globally-unique ids, never reused across retries/reprices (T3 round-2: the record_*
   *  RPCs are keyed by client_order_id alone; a reuse would splice two attempts' lifecycles). */
  newClientOrderId?: () => string;
  /** Structured logger for the dry-run payload + audit; defaults to redacting-console JSON. */
  log?: (entry: Record<string, unknown>) => void;
}

const defaultLog = (entry: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
};

export class MakerExecutor {
  private readonly ledger: OrderLedger;
  private readonly newId: () => string;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly deps: MakerExecutorDeps) {
    this.ledger = deps.ledger ?? rpcOrderLedger(deps.db);
    this.newId = deps.newClientOrderId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? defaultLog;
  }

  get mode(): ReturnType<typeof resolveTradeMode> {
    return resolveTradeMode(this.deps.getEnvVar);
  }

  /**
   * Post a resting MAKER order for the tuned strategy (entry or take-profit). The limit is re-priced to
   * sit strictly inside the spread (never crosses → never pays taker fees), then posted GTC/GTD — the
   * price IS the maker guarantee. (clob-client-v2 exposes a real post_only, but we post 2-arg and do NOT
   * pass it — C75; the result's `postOnly` field stays a posture marker only.) Idempotent per
   * (mode, market|side|purpose|date): an OPEN intent is never re-placed.
   */
  async place(req: MakerOrderRequest): Promise<OrderPlacementResult> {
    const mode = this.mode;
    const intentKey = orderIntentKey(req);
    const orderType: OrderType = req.orderType ?? 'GTC';
    const base = {
      mode,
      intentKey,
      side: req.side,
      purpose: req.purpose,
      orderType,
      postOnly: true,
      size: req.size,
    } as const;

    if (mode === 'off') {
      return { ...base, status: 'skipped_off', clientOrderId: null, orderId: null, limitPrice: null, sizeMatched: 0, reason: 'TRADE_MODE=off' };
    }

    // Idempotency gate #1 — an open intent for this (mode, key) must NEVER be re-placed (crash-restart
    // safety). Mode-scoped (F4): a dry-run row never blocks a live intent, and vice versa.
    const open = await this.ledger.findByIntentKey(intentKey, mode);
    if (open) {
      return { ...base, status: 'duplicate', clientOrderId: open.clientOrderId, orderId: open.orderId, limitPrice: open.price, sizeMatched: open.sizeMatched, reason: `open intent already ${open.status}` };
    }

    const client = await this.deps.client();
    const top = parseOrderBookTop(await client.getOrderBook(req.tokenId));
    const tick = top.tickSize > 0 ? top.tickSize : Number(await client.getTickSize(req.tokenId));
    const priced = makerLimitPrice({ side: req.side, targetPrice: req.targetPrice, bestBid: top.bestBid, bestAsk: top.bestAsk, tick });
    if (!priced.ok) {
      return { ...base, status: 'not_makeable', clientOrderId: null, orderId: null, limitPrice: null, sizeMatched: 0, reason: priced.reason };
    }
    const minSize = req.minOrderSize ?? top.minOrderSize;
    if (minSize > 0 && req.size < minSize) {
      throw new ExecutionError('ERR_MIN_SIZE', `size ${req.size} < market min order size ${minSize}`);
    }

    const clientOrderId = this.newId();
    const order = await client.createOrder(
      { tokenID: req.tokenId, price: priced.price, size: req.size, side: req.side },
      { tickSize: tick, negRisk: req.negRisk ?? true },
    );

    // Both remaining modes RESERVE the intent (the crash-safety anchor; mode-scoped partial-unique).
    const reserved = await this.ledger.reserveIntent({ mode, intentKey, clientOrderId, marketId: req.marketId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType, price: priced.price, size: req.size, tradeDate: req.tradeDate });
    if (reserved === 'exists') {
      // Idempotency gate #2 — a concurrent placer won the partial-unique race; do NOT double-place.
      return { ...base, status: 'duplicate', clientOrderId: null, orderId: null, limitPrice: priced.price, sizeMatched: 0, reason: 'intent reserved concurrently' };
    }

    // DRY-RUN (coordination change A): record the intent + a SYNTHETIC placed marker for the shadow
    // harness, log the EXACT (redacted) payload — the venue is NEVER touched (no postOrder, no cancel).
    if (mode === 'dry-run') {
      const syntheticId = `dry-run:${clientOrderId}`;
      await this.ledger.recordPlaced(clientOrderId, syntheticId);
      this.log({ msg: 'maker.dry_run', intentKey, clientOrderId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType, postOnly: true, price: priced.price, size: req.size, payload: redactOrderPayload(order) });
      return { ...base, status: 'dry_run', clientOrderId, orderId: syntheticId, limitPrice: priced.price, sizeMatched: 0 };
    }

    // maker path: priced-to-rest, never crosses → $0 venue fee by construction (feeRateBps 0).
    return this.postAndRecord(client, order, clientOrderId, { ...base, clientOrderId, limitPrice: priced.price }, orderType, req.size, 0, `${req.marketId} ${req.side} ${req.purpose}`, req.tokenId);
  }

  /**
   * Post a TAKER exit (FAK marketable-limit with a worst-price slippage guard) — the stop-loss /
   * time-stop leg. FAK takes whatever depth exists and cancels the rest (never hangs a resting order in
   * a thin weather book — research report §1). Idempotent through the same ledger.
   */
  async placeTaker(req: TakerOrderRequest): Promise<OrderPlacementResult> {
    const mode = this.mode;
    const intentKey = orderIntentKey(req);
    const base = { mode, intentKey, side: req.side, purpose: req.purpose, orderType: 'FAK' as OrderType, postOnly: false, size: req.size } as const;

    if (mode === 'off') {
      return { ...base, status: 'skipped_off', clientOrderId: null, orderId: null, limitPrice: null, sizeMatched: 0, reason: 'TRADE_MODE=off' };
    }
    const open = await this.ledger.findByIntentKey(intentKey, mode);
    if (open) {
      return { ...base, status: 'duplicate', clientOrderId: open.clientOrderId, orderId: open.orderId, limitPrice: open.price, sizeMatched: open.sizeMatched, reason: `open intent already ${open.status}` };
    }

    // LOW-7: read tick + min order size from the live book (like place()) when the caller omits them.
    const client = await this.deps.client();
    const top = parseOrderBookTop(await client.getOrderBook(req.tokenId));
    const tick = top.tickSize > 0 ? top.tickSize : Number(await client.getTickSize(req.tokenId));
    const price = takerLimitPrice(req.side, req.worstPrice, tick);
    const minSize = req.minOrderSize ?? top.minOrderSize;
    if (minSize > 0 && req.size < minSize) {
      throw new ExecutionError('ERR_MIN_SIZE', `size ${req.size} < market min order size ${minSize}`);
    }
    const clientOrderId = this.newId();
    const order = await client.createOrder({ tokenID: req.tokenId, price, size: req.size, side: req.side }, { tickSize: tick, negRisk: req.negRisk ?? true });

    const reserved = await this.ledger.reserveIntent({ mode, intentKey, clientOrderId, marketId: req.marketId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType: 'FAK', price, size: req.size, tradeDate: req.tradeDate, strategy: req.strategy });
    if (reserved === 'exists') {
      return { ...base, status: 'duplicate', clientOrderId: null, orderId: null, limitPrice: price, sizeMatched: 0, reason: 'intent reserved concurrently' };
    }
    if (mode === 'dry-run') {
      const syntheticId = `dry-run:${clientOrderId}`;
      await this.ledger.recordPlaced(clientOrderId, syntheticId);
      this.log({ msg: 'taker.dry_run', intentKey, clientOrderId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType: 'FAK', price, size: req.size, payload: redactOrderPayload(order) });
      return { ...base, status: 'dry_run', clientOrderId, orderId: syntheticId, limitPrice: price, sizeMatched: 0 };
    }
    // 0084 #17: a FAK exit pays the venue's taker fee — book it with the fill so the N1 daily-loss kill
    // sees it (the caller supplies the rate; omitted ⇒ 0, the pre-0084 behavior).
    return this.postAndRecord(client, order, clientOrderId, { ...base, clientOrderId, limitPrice: price }, 'FAK', req.size, req.feeRateBps ?? 0, `${req.marketId} ${req.side} ${req.purpose}`, req.tokenId);
  }

  /**
   * Post + record the fill (shared live tail). NEVER auto-retries on error — no accidental doubles.
   * Failure semantics (CRITICAL-1 + HIGH-A), by where the failure lands:
   *
   *   - AFTER an orderId is known (recordPlaced / fill-poll / recordFill failed): the row stays
   *     'placed' (best-effort re-record in case the failure WAS the record write) + a needs-reconcile
   *     CRITICAL naming the resting orderId. recordFailed NEVER runs here.
   *   - postOrder invoked but NO decisive response (a transport THROW, or a response with no orderID
   *     that is not a clean rejection): the venue MAY have accepted the order and the response was
   *     lost — freeing the key would let a retry double-place. The row is LEFT AT 'intent' (it was
   *     reserved pre-call; recordPlaced never ran) + a needs-reconcile CRITICAL naming the intent.
   *     The startup reconcile sweep lists EXACTLY these rows (status='intent', order_id IS NULL) and
   *     adopts-or-frees them against venue evidence — that sweep, not a heartbeat, is the mechanism.
   *   - CLEAN VENUE REJECTION (a response with success=false: the venue processed the request and
   *     refused it — no order was created): recordFailed frees the key (ERR_CLOB_REJECTED).
   *   - Throws BEFORE any venue interaction (book/tick/pricing/min-size/sign in place()/placeTaker())
   *     never reach this method — they occur before reserveIntent, so no ledger row exists and no key
   *     is ever held; the error simply propagates.
   */
  private async postAndRecord(
    client: MakerClobClientish,
    order: unknown,
    clientOrderId: string,
    result: Omit<OrderPlacementResult, 'status' | 'orderId' | 'sizeMatched'> & { clientOrderId: string },
    orderType: OrderType,
    requestedSize: number,
    feeRateBps: number,
    label: string,
    /** the order's token — the fill-truth trades read (avg execution price) is scoped to it. */
    tokenId?: string,
  ): Promise<OrderPlacementResult> {
    let orderId: string | undefined;
    let postAttempted = false;
    // 0084 #17: the venue fee attributed to a fill's CUMULATIVE snapshot — feeRateBps/10 000 × the filled
    // notional (avg × size). 0 on the maker path (post_only never pays); the taker FAK exit passes its rate.
    const feeFor = (sizeMatched: number, avgPrice: number): number =>
      feeRateBps > 0 ? round6((feeRateBps / 10_000) * avgPrice * sizeMatched) : 0;
    try {
      postAttempted = true;
      // ⚠ 2-ARG ONLY: v2's postOrder is (order, orderType, postOnly?, deferExec?). We pass NEITHER extra —
      // maker-ness is enforced by price upstream, and adopting v2's real post_only is a gated future lever
      // (C75 decision), not switched on here. postOrder self-heals an order_version_mismatch internally.
      const posted = await client.postOrder(order, orderType);
      orderId = posted?.orderID;
      if (!orderId) {
        if (posted?.success === false) {
          // The venue processed the request and REFUSED it — no order exists; safe to free.
          throw new ExecutionError(
            'ERR_CLOB_REJECTED',
            redactText(`venue rejected the order: ${posted.errorMsg ?? 'no errorMsg in response'}`),
          );
        }
        // C46: v2's http-helper returns HTTP-level failures as {error, status} — NO success field at all —
        // so before this branch every venue 4xx (geoblock 403, "maker address not allowed" 400, bad-creds
        // 401) was mis-classed SHAPELESS and its reason lived only in console logs. A 4xx means the request
        // was processed and REFUSED — no order exists (Cloudflare 4xx blocks never reach the origin; origin
        // 4xx refuses before creating) — the same decisive semantics as success:false, so free the key and
        // put the venue's verbatim words in the ledger reason. 5xx / missing status stays shapeless below:
        // the order state is genuinely unknown there and MUST be held for reconcile.
        const httpErr = posted as { error?: unknown; status?: unknown } | null | undefined;
        const httpStatus = Number(httpErr?.status);
        if (typeof httpErr?.error === 'string' && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500) {
          throw new ExecutionError(
            'ERR_CLOB_REJECTED',
            redactText(`venue rejected the order (http ${httpStatus}): ${httpErr.error.slice(0, 300)}`),
          );
        }
        // A response arrived but carries no orderID and no explicit rejection — order state UNKNOWN.
        // The snapshot names WHAT came back (a 5xx JSON vs a venue glitch) —
        // the 2026-07-12 shanghai stuck-intent was undiagnosable without it.
        throw new ExecutionError(
          'ERR_CLOB_POST',
          `postOrder returned no orderID (shapeless response — order state unknown): ${shapelessSnapshot(posted)}`,
        );
      }
      await this.ledger.recordPlaced(clientOrderId, orderId);

      const poll = parseOrderFillPoll(await client.getOrder(orderId), orderId, requestedSize);
      let avgPrice: number | null = null; // 0110: surfaced to the caller so a fill notification can say the price paid
      // FILL-PRICE TRUTH (the 2026-07-19 wellington lesson): getOrder's `price` is the order's LIMIT, not
      // the execution average — a negRisk-adapter fill can execute FAR better than limit (32.18 sh @ 0.1585
      // avg on a 15-sh 0.34-limit FAK; the poll recorded 0.34 → a $10.94 phantom notional on a $5.10 spend).
      // When the poll shows a fill, prefer the venue's TRADE RECORDS for the size-weighted average — our
      // taker fills carry this order's id. Fail-soft: any trades-read problem falls back to the poll price.
      const tradeTruthAvg = async (): Promise<number | null> => {
        if (!tokenId) return null;
        try {
          const trades = parseTrades(await client.getTrades({ asset_id: tokenId }))
            .filter((t) => t.traderSide === 'TAKER' && t.takerOrderId === orderId && t.size > 0);
          const totSize = trades.reduce((s, t) => s + t.size, 0);
          if (totSize <= 0) return null;
          return round6(trades.reduce((s, t) => s + t.size * t.price, 0) / totSize);
        } catch {
          return null;
        }
      };
      if (poll.filled) {
        // p_size_matched is CUMULATIVE (T3 schema appends only positive deltas to live_fills).
        const matched = poll.sizeMatched || requestedSize;
        const avg = (await tradeTruthAvg()) ?? poll.avgPrice ?? result.limitPrice ?? 0;
        avgPrice = avg;
        await this.ledger.recordFill(clientOrderId, matched, avg, 'filled', feeFor(matched, avg));
      } else if (poll.partial) {
        const avg = (await tradeTruthAvg()) ?? poll.avgPrice ?? result.limitPrice ?? 0;
        avgPrice = avg;
        await this.ledger.recordFill(clientOrderId, poll.sizeMatched, avg, 'partial', feeFor(poll.sizeMatched, avg));
      }
      // resting (maker unmatched): stays 'placed'; the loop repolls / reprices / cancels via the chokepoint.
      return { ...result, status: 'placed', orderId, sizeMatched: poll.sizeMatched, avgPrice };
    } catch (e) {
      // MEDIUM-4: every string that leaves the executor (ledger error column, alert body, thrown
      // message) is redacted — a venue/HTTP error can echo auth-header or signature material.
      const message = redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));

      if (orderId !== undefined) {
        // CRITICAL-1: the post SUCCEEDED — a live order may rest at the venue. NEVER recordFailed
        // (freeing the key would let a retry double-place). Keep the row 'placed': recordPlaced
        // normally already ran; re-run it best-effort in case the failure WAS the record write.
        // T3 round-2 note: a record_* RPC RAISES on a client_order_id with no ledger row (reconcile-bug
        // surfacing) — such a raise lands HERE, on the alert path, never in the key-freeing branch below.
        try {
          await this.ledger.recordPlaced(clientOrderId, orderId);
        } catch {
          /* the needs-reconcile alert below still fires; reconcile adopts the order on restart */
        }
        await this.deps.notify({
          kind: 'ORDER_NEEDS_RECONCILE',
          severity: 'CRITICAL',
          title: `Live order needs reconcile: ${label}`,
          body: `post succeeded (order ${orderId}) but the post-place flow failed: ${message}\nrow ${clientOrderId} kept 'placed' — verify fill state on Polymarket before any retry`,
          dedupeKey: `order-reconcile:${clientOrderId}`,
        });
        if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
        throw new ExecutionError('ERR_CLOB', message);
      }

      const cleanRejection = e instanceof ExecutionError && e.code === 'ERR_CLOB_REJECTED';
      if (postAttempted && !cleanRejection) {
        // (T3-final @ 742018d: ALL FOUR record_* RPCs raise on an unknown client_order_id; a raise
        // from recordPlaced/recordFill above lands in the orderId-known branch — the alert path.)
        // HIGH-A: postOrder was invoked but no orderId came back and the venue did NOT cleanly
        // reject — a transport throw (lost response after a possible accept) or a shapeless response
        // can hide an ACCEPTED order. Do NOT recordFailed: the row stays at 'intent' (reserved
        // pre-call), which is exactly what the startup reconcile sweep lists and adjudicates against
        // venue evidence (adopt-or-free). Freeing here would let a retry double-place.
        await this.deps.notify({
          kind: 'ORDER_NEEDS_RECONCILE',
          severity: 'CRITICAL',
          title: `Order state unknown after post attempt: ${label}`,
          body: `postOrder failed without a decisive response: ${message}\nintent ${result.intentKey} (row ${clientOrderId}) LEFT RESERVED at 'intent' — run the startup reconcile sweep before any retry`,
          dedupeKey: `order-reconcile:${clientOrderId}`,
        });
        if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
        throw new ExecutionError('ERR_CLOB', message);
      }

      // Clean venue rejection (or a provably pre-post failure) — no order exists; free the key.
      // The free itself goes through ledgerWriteOrAlert: if record_failed RAISES (T3-final unknown-cid
      // semantics), the key was NOT freed — alert needs-reconcile and propagate, never pretend success.
      await this.ledgerWriteOrAlert('record_failed (after venue rejection)', clientOrderId, label, () =>
        this.ledger.recordFailed(clientOrderId, message),
      );
      await this.deps.notify({
        kind: 'ORDER_FAIL',
        severity: 'CRITICAL',
        title: `Live order failed: ${label}`,
        body: message,
        dedupeKey: `order-fail:${clientOrderId}`,
      });
      if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
      throw new ExecutionError('ERR_CLOB', message);
    }
  }

  /**
   * T3-FINAL (merged @ 742018d): ALL FOUR record_* RPCs RAISE on an unknown client_order_id
   * (reconcile-bug surfacing; echoes onto an already-terminal row stay silent). A raise from ANY
   * record_* call on the live money path routes HERE — a needs-reconcile CRITICAL + rethrow. It must
   * NEVER be handled by (or routed into) the key-freeing recordFailed branch: a ledger/executor state
   * mismatch is a reconcile problem, not a licence to free a key.
   */
  private async ledgerWriteOrAlert<T>(
    op: string,
    clientOrderId: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const message = redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      await this.deps.notify({
        kind: 'ORDER_NEEDS_RECONCILE',
        severity: 'CRITICAL',
        title: `Ledger write failed: ${label}`,
        body: `${op} raised for row ${clientOrderId}: ${message}\nledger/executor state mismatch — reconcile before any retry`,
        dedupeKey: `order-reconcile:${clientOrderId}`,
      });
      if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
      throw new ExecutionError('ERR_LEDGER_WRITE', message);
    }
  }

  /**
   * Cancel one resting order (live only; dry-run/off are no-ops — no real order exists).
   *
   * RACED-FILL ADJUDICATION: a venue cancel can race a fill even when it reports `allCanceled` (the
   * fill landed in the caller's poll→cancel window; the venue then cancels only the remainder). So the
   * post-cancel state is ALWAYS polled before any ledger transition (the same discipline `reprice`
   * uses), and the poll's cumulative matched decides it:
   *
   *   matched == 0        → record_canceled (the key frees) — the previous behavior, now PROVEN safe.
   *   0 < matched < size  → record_fill('partial') and NO record_canceled: the row stays VISIBLE to
   *                         `bot_order_by_intent`, so the raced fill survives into next-tick position
   *                         reconstruction (entry BUYs have NO venue getTrades floor — hiding the row
   *                         would orphan the held shares from all TP/stop/time-stop management).
   *   matched >= size     → record_fill('filled') (terminal-but-blocking) — the intent SUCCEEDED.
   *
   * The poll result is surfaced as `CancelResult.sizeMatched` so callers sizing a follow-up SELL
   * (the TP-cancel → taker-exit path) can re-derive `remaining` from fresh truth instead of the
   * stale pre-cancel read. A poll THROW propagates (no ledger transition — the row stays open and the
   * next tick's fill-poll/retry re-adjudicates); a not-fully-canceled response returns unpolled as
   * before (the caller aborts; nothing was freed).
   */
  async cancel(orderId: string, clientOrderId?: string): Promise<CancelResult> {
    if (this.mode !== 'live') {
      return { requested: [orderId], canceled: [orderId], notCanceled: {}, allCanceled: true, sizeMatched: 0 };
    }
    const client = await this.deps.client();
    const res = parseCancelResult(await client.cancelOrder({ orderID: orderId }), [orderId]);
    if (!clientOrderId || !res.allCanceled) return res;

    const poll = parseOrderFillPoll(await client.getOrder(orderId), orderId);
    const matched = poll.sizeMatched;
    if (matched > 0) {
      await this.ledgerWriteOrAlert('record_fill (cancel raced a fill)', clientOrderId, orderId, () =>
        this.ledger.recordFill(clientOrderId, matched, poll.avgPrice ?? 0, poll.filled ? 'filled' : 'partial'),
      );
      // Deliberately NO record_canceled: the row must stay visible so the fill is never orphaned.
      return { ...res, sizeMatched: matched };
    }
    await this.ledgerWriteOrAlert('record_canceled', clientOrderId, orderId, () =>
      this.ledger.recordCanceled(clientOrderId),
    );
    return { ...res, sizeMatched: 0 };
  }

  /** Cancel every resting order on a market (the flatten/kill primitive; live only). */
  async cancelAllForMarket(marketId: string, tokenId?: string): Promise<CancelResult> {
    if (this.mode !== 'live') {
      return { requested: [], canceled: [], notCanceled: {}, allCanceled: true };
    }
    const client = await this.deps.client();
    const payload = tokenId ? { market: marketId, asset_id: tokenId } : { market: marketId };
    return parseCancelResult(await client.cancelMarketOrders(payload), []);
  }

  /** List our open orders (reconcile source of truth; live only). */
  async listOpenOrders(params?: { market?: string; asset_id?: string }): Promise<OpenOrder[]> {
    if (this.mode !== 'live') return [];
    const client = await this.deps.client();
    return parseOpenOrders(await client.getOpenOrders(params));
  }

  /** Poll one order for fills (partial-fill aware). Non-live returns a synthetic resting poll. */
  async pollFill(orderId: string, requestedSize = 0): Promise<OrderFillPoll> {
    if (this.mode !== 'live') {
      return { orderId, status: 'dry-run', originalSize: requestedSize, sizeMatched: 0, avgPrice: null, filled: false, partial: false, resting: true };
    }
    const client = await this.deps.client();
    return parseOrderFillPoll(await client.getOrder(orderId), orderId, requestedSize);
  }

  /**
   * Reprice a resting maker order: cancel-then-repost the UNFILLED REMAINDER (no atomic amend exists —
   * research report §3). MEDIUM-5/LOW-6 semantics:
   *
   *   1. `oldClientOrderId` is REQUIRED — the old ledger row is the source of truth for the ORIGINAL
   *      size; the remainder is `originalSize − poll.sizeMatched` (cumulative), never `newReq.size`
   *      arithmetic. A `newReq.size` that disagrees with the open row's size is rejected (ERR_REPRICE_SIZE).
   *   2. The old order's post-cancel state is ALWAYS polled — a cancel can race a fill both ways
   *      (`allCanceled` with a prior partial, or `not_canceled` because it just filled).
   *   3. If the cancel failed AND the order is still open at the venue (e.g. rate-limited cancel), the
   *      reprice ABORTS with no ledger change — freeing/reposting beside a live resting order would
   *      double-place.
   *   4. A raced fill (full OR partial) keeps the old row VISIBLE: full → recordFill('filled')
   *      (terminal-but-blocking); partial → recordFill('partial') and NO recordCanceled/repost — the
   *      remainder is abandoned. `bot_order_by_intent` hides terminal canceled rows and entry BUYs have
   *      no venue getTrades floor, so record_canceled-ing a filled entry row would orphan the held
   *      shares from all next-tick position management (no TP/stop/time-stop). Only a PROVEN-unfilled
   *      (matched == 0) old order is freed and its full size reposted.
   *   5. Crash-safety ordering on the matched==0 path (why free-then-place is safe): the old row is
   *      freed (recordCanceled), THEN the remainder is placed. At every crash point at most ONE live
   *      resting order exists for the intent: before the venue cancel there is only the old order;
   *      between cancel and recordCanceled the venue holds NO resting order and the key is still
   *      blocked (a re-place returns 'duplicate'; a follow-up reprice re-runs the transition
   *      idempotently); between recordCanceled and place() the key is free but the venue is empty — a
   *      crash-restart place() creates exactly one new order. The double-place shape
   *      (place-before-free) is unreachable: reserveIntent would return 'exists'.
   *
   * Non-live: dry-run frees the old dry-run row + re-places (ledger-only, venue untouched); off is a no-op.
   */
  async reprice(
    oldOrderId: string,
    oldClientOrderId: string,
    newReq: MakerOrderRequest,
  ): Promise<{ cancel: CancelResult; placed: OrderPlacementResult }> {
    const mode = this.mode;
    const intentKey = orderIntentKey(newReq);
    const rejected = (reason: string, sizeMatched = 0, size = 0): OrderPlacementResult => ({
      mode,
      status: 'rejected',
      intentKey,
      clientOrderId: null,
      orderId: null,
      side: newReq.side,
      purpose: newReq.purpose,
      orderType: newReq.orderType ?? 'GTC',
      postOnly: true,
      limitPrice: null,
      size,
      sizeMatched,
      reason,
    });
    const syntheticCancel: CancelResult = { requested: [oldOrderId], canceled: [oldOrderId], notCanceled: {}, allCanceled: true };

    if (mode === 'off') {
      return { cancel: syntheticCancel, placed: rejected('TRADE_MODE=off') };
    }
    if (mode === 'dry-run') {
      // Ledger-only mirror of the live transition: free the old dry-run row, re-place (records anew).
      await this.ledger.recordCanceled(oldClientOrderId);
      return { cancel: syntheticCancel, placed: await this.place(newReq) };
    }

    // LOW-6: the OPEN ledger row is the source of truth for the original size.
    const oldRow = await this.ledger.findByIntentKey(intentKey, 'live');
    if (oldRow && oldRow.clientOrderId !== oldClientOrderId) {
      throw new ExecutionError(
        'ERR_REPRICE_STATE',
        `open intent row for ${intentKey} is ${oldRow.clientOrderId}, not the given ${oldClientOrderId}`,
      );
    }
    if (oldRow && Math.abs(newReq.size - oldRow.size) > 1e-6) {
      throw new ExecutionError(
        'ERR_REPRICE_SIZE',
        `newReq.size ${newReq.size} != original ledger size ${oldRow.size} — reprice must carry the original intent size`,
      );
    }
    const originalSize = oldRow?.size ?? newReq.size;

    const client = await this.deps.client();
    const cancel = parseCancelResult(await client.cancelOrder({ orderID: oldOrderId }), [oldOrderId]);
    // ALWAYS poll the post-cancel state — a cancel can race a fill in both directions.
    const poll = parseOrderFillPoll(await client.getOrder(oldOrderId), oldOrderId, originalSize);

    const stillOpen = !poll.filled && ['live', 'delayed'].includes(poll.status.toLowerCase());
    if (!cancel.allCanceled && stillOpen) {
      // Cancel failed and the order still rests — do NOT free the key or repost (double-place hazard).
      return { cancel, placed: rejected('cancel failed and the order is still live — reprice aborted', poll.sizeMatched, 0) };
    }

    const matched = poll.sizeMatched;
    const remainder = Math.max(0, originalSize - matched);

    // Every reprice ledger transition goes through ledgerWriteOrAlert (T3-final: record_* raises on an
    // unknown client_order_id) — a raise ABORTS the reprice before the repost (no key freed = no
    // double-place) with a needs-reconcile CRITICAL, never a silent skip.
    if (matched >= originalSize && originalSize > 0) {
      // The cancel raced a COMPLETE fill — the intent succeeded; the row stays (terminal-but-blocking).
      await this.ledgerWriteOrAlert('record_fill (reprice, full)', oldClientOrderId, oldOrderId, () =>
        this.ledger.recordFill(oldClientOrderId, matched, poll.avgPrice ?? oldRow?.price ?? 0, 'filled'),
      );
      return { cancel, placed: rejected('old order fully filled during reprice — nothing to repost', matched, 0) };
    }
    if (matched > 0) {
      // The cancel raced a PARTIAL fill. Book it and STOP — no record_canceled, no repost: freeing the
      // row would hide it from `bot_order_by_intent` (0082 filters terminal canceled/failed), and an
      // entry BUY has NO venue getTrades floor, so the raced shares would vanish from next-tick position
      // reconstruction — held at the wallet with no TP/stop-loss/time-stop ever sized for them (and, in
      // the below-min-remainder case, the whole position would disappear). The row stays 'partial'
      // (visible, key-blocking — a re-place is 'duplicate'); the venue holds no resting order, so the
      // unfilled remainder is deliberately ABANDONED: the held shares' manageability outranks re-pegging
      // the rest. Mirrors the full-fill branch's row-stays semantics.
      await this.ledgerWriteOrAlert('record_fill (reprice, partial)', oldClientOrderId, oldOrderId, () =>
        this.ledger.recordFill(oldClientOrderId, matched, poll.avgPrice ?? oldRow?.price ?? 0, 'partial'),
      );
      return {
        cancel,
        placed: rejected('old order partially filled during reprice — row kept partial (held shares stay reconstructable); remainder not reposted', matched, 0),
      };
    }
    // Free the key ONLY now: the venue holds no resting order AND nothing filled (matched == 0).
    await this.ledgerWriteOrAlert('record_canceled (reprice)', oldClientOrderId, oldOrderId, () =>
      this.ledger.recordCanceled(oldClientOrderId),
    );

    const min = newReq.minOrderSize ?? 0;
    if (remainder <= 0 || (min > 0 && remainder < min)) {
      return { cancel, placed: rejected(`reprice remainder ${remainder} below min ${min} — not reposted`, matched, remainder) };
    }
    return { cancel, placed: await this.place({ ...newReq, size: remainder }) };
  }

  /**
   * HIGH-2 — the startup reconcile sweep (T2 calls this BEFORE its first tick; research report §5,
   * ADR-OC-5). Two dangling classes (0120 widened the RPC):
   *
   *   · `intent` + no orderId — a crash inside the post→record_placed critical section. Venue identity
   *     is UNKNOWN → the HEURISTIC path below (open-orders match / trades match / free).
   *   · `placed` + orderId + size_matched 0 (0120, build-queue ④) — the fill-poll crashed AFTER a
   *     successful post+record. Venue identity is KNOWN → DIRECT evidence by order id: fills found ⇒
   *     record_fill (venue-truth avg); dead zero-fill FAK/FOK ⇒ record_canceled (the F1 outcome —
   *     kill-type orders cannot rest); GTC/GTD frees only on a known-dead status; still-open rests
   *     untouched (no ambiguity alert); unknown status holds.
   *
   * For the heuristic (no-orderId) class, decide:
   *
   *   adopt — exactly ONE venue open order matches HEURISTICALLY (side exact, price within one tick,
   *           original size exact — there is NO server-side client-order-id on the CLOB, so identity
   *           can only be inferred from what we know we sent) → recordPlaced(venue orderId).
   *   freed — NO open order matches AND the token's recent trades show no fill that could be ours at
   *           our side/price (perspective-aware: taker top-level OR any maker leg — the venue trade
   *           record is taker-centric) → confirmed never posted → the key is freed (recordFailed).
   *   held  — ANY ambiguity (multiple candidates, or a matching trade that could be our fill, or the
   *           evidence reads themselves fail) → the row stays non-terminal + a WARN alert. A key is
   *           NEVER freed on ambiguity.
   *
   * ⚠ T2 CONTRACT (LOW-A): the FREE path is valid ONLY as a STARTUP-AFTER-DOWNTIME sweep — call this
   * BEFORE the first tick, before any websocket heartbeat starts. The "no open order + no trade ⇒
   * never posted" inference assumes (a) the venue's heartbeat auto-cancel has already cleared any
   * order the crashed process left resting, and (b) `getOpenOrders` is authoritative for the current
   * book. Invoking this MID-RUN while the bot is heartbeating and placing is FORBIDDEN: a just-posted
   * order (in the post→record window) has a dangling 'intent' row and could be wrongly freed →
   * double-place on the next tick.
   *
   * Non-live modes return [] without touching the venue (dry-run rows carry synthetic orderIds and are
   * never dangling in this sense). Outcome `reason` strings are redacted at the source (LOW-B) — T2
   * may log or persist them.
   *
   * F4 (the cloud twin, C18d): `opts.strategies` scopes the sweep to rows carrying one of the given
   * strategy tags. This is what makes a PERIODIC caller (the buy-table Edge tick) safe alongside the
   * T2 contract above: the tick sweeps ONLY its own lane's rows (whose writer — the previous Edge
   * invocation — is provably dead: bot_order_list_dangling's ≥5-min N9 age floor plus the 10-min tick
   * cadence vs the Edge wall-clock cap), while the daemon's rows — tagged otherwise or untagged
   * pre-0085 — are never touched mid-daemon-run and wait for the daemon's own startup sweep.
   * Omitted ⇒ the unfiltered startup sweep, byte-identical to the pre-F4 behavior.
   */
  async reconcileOpenOrders(opts?: { strategies?: readonly string[] }): Promise<ReconcileOutcome[]> {
    if (this.mode !== 'live') return [];
    const all = await this.ledger.listDanglingIntents('live');
    const rows =
      opts?.strategies == null
        ? all
        : all.filter((r) => r.strategy != null && opts.strategies!.includes(r.strategy));
    if (rows.length === 0) return [];
    const client = await this.deps.client();
    const out: ReconcileOutcome[] = [];

    for (const row of rows) {
      const held = async (rawReason: string): Promise<void> => {
        // LOW-B: redact at the STRUCT, not just the alert — T2 may log/persist outcome.reason.
        const reason = redactText(rawReason);
        await this.deps.notify({
          kind: 'RECONCILE_AMBIGUOUS',
          severity: 'WARN',
          title: `Reconcile held: ${row.intentKey}`,
          body: `dangling intent ${row.clientOrderId} (${row.side} ${row.size} @ ${row.price}) — ${reason}\nrow kept non-terminal; resolve manually before re-placing`,
          dedupeKey: `reconcile-held:${row.clientOrderId}`,
        });
        out.push({ kind: 'held', clientOrderId: row.clientOrderId, intentKey: row.intentKey, orderId: null, reason });
      };

      try {
        // 0120 — the ORPHAN ZERO-FILL class (build-queue ④): the row already carries a venue orderId
        // (postOrder + recordPlaced succeeded; the fill-poll crashed before the same-tick F1
        // adjudication), so evidence is DIRECT — the order record itself, by id — never the heuristic
        // open-orders/trades match below. listDanglingIntents surfaces these only at size_matched = 0.
        if (row.orderId != null) {
          const poll = parseOrderFillPoll(await client.getOrder(row.orderId), row.orderId, row.size);
          if (poll.sizeMatched > 0) {
            // The "orphan" actually filled. FILL-PRICE TRUTH (the 2026-07-19 wellington lesson):
            // getOrder's `price` is the LIMIT — prefer the trade records' size-weighted average for
            // this order's own taker fills; fail-soft to the poll price (the avg is bookkeeping; the
            // fill DECISION is getOrder's size_matched, which is direct evidence).
            let avg = poll.avgPrice ?? row.price;
            try {
              const rawTrades = await client.getTrades({ asset_id: row.tokenId });
              if (!tradesResponseTruncated(rawTrades)) {
                const fills = parseTrades(rawTrades).filter(
                  (t) => t.traderSide === 'TAKER' && t.takerOrderId === row.orderId && t.size > 0,
                );
                const tot = fills.reduce((s, t) => s + t.size, 0);
                if (tot > 0) avg = round6(fills.reduce((s, t) => s + t.size * t.price, 0) / tot);
              }
            } catch {
              /* fail-soft: the poll price stands */
            }
            // The venue fee is unattributable at reconcile distance (the per-row rate isn't stored) —
            // recorded 0; the wallet aggregate carries fee truth.
            await this.ledger.recordFill(
              row.clientOrderId,
              poll.sizeMatched,
              avg,
              poll.filled ? 'filled' : 'partial',
            );
            out.push({
              kind: 'adopted',
              clientOrderId: row.clientOrderId,
              intentKey: row.intentKey,
              orderId: row.orderId,
              reason: `posted order has venue fills (${poll.sizeMatched} @ ${avg}) — recorded from venue truth`,
            });
            continue;
          }
          // Zero venue fills. A kill-type order (FAK/FOK) cannot rest — dead + 0 is PROVEN, the exact
          // outcome the crashed inline F1 adjudication would have written: canceled (retryable), never
          // failed (it DID post). A GTC/GTD row (a daemon maker order after downtime) frees only on a
          // known-dead venue status; a still-open resting order is left alone WITHOUT the ambiguity
          // alert (resting is legitimate, not ambiguous); anything else holds.
          const status = poll.status.toUpperCase();
          const killType = (row.orderType ?? '').toUpperCase();
          const cannotRest = killType === 'FAK' || killType === 'FOK';
          const knownDead = status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED';
          if (cannotRest || knownDead) {
            await this.ledger.recordCanceled(row.clientOrderId);
            out.push({
              kind: 'freed',
              clientOrderId: row.clientOrderId,
              intentKey: row.intentKey,
              orderId: row.orderId,
              reason: `posted order is dead at the venue with zero fills (${cannotRest ? `${killType} cannot rest` : `status ${poll.status}`}) — canceled (the F1 zero-fill outcome; key retryable)`,
            });
            continue;
          }
          if (status === 'LIVE') {
            out.push({
              kind: 'held',
              clientOrderId: row.clientOrderId,
              intentKey: row.intentKey,
              orderId: row.orderId,
              reason: 'order still open at the venue (legitimate resting order) — no action',
            });
            continue;
          }
          await held(
            `posted order ${row.orderId} reports zero fills with unrecognized status '${poll.status}' — cannot prove dead`,
          );
          continue;
        }

        const open = parseOpenOrders(await client.getOpenOrders({ asset_id: row.tokenId }));
        const tick = Number(await client.getTickSize(row.tokenId)) || 0.01;
        const match = matchDanglingIntent(row, open, tick);

        if (match.kind === 'adopt') {
          await this.ledger.recordPlaced(row.clientOrderId, match.orderId);
          out.push({ kind: 'adopted', clientOrderId: row.clientOrderId, intentKey: row.intentKey, orderId: match.orderId, reason: 'exactly one venue open order matched (side/price/size)' });
          continue;
        }
        if (match.kind === 'ambiguous') {
          await held(`${match.candidateIds.length} venue open orders match — cannot identify ours (no client-order-id on the CLOB)`);
          continue;
        }
        // No open order — check recent trades before concluding "never posted": the order could have
        // posted AND filled (or filled-then-expired) without ever resting long enough to list.
        const rawTrades = await client.getTrades({ asset_id: row.tokenId });
        // §11.1 — a TRUNCATED trades page (cursor/at-limit) is INCOMPLETE evidence: a fill could sit on a
        // later page. Freeing a key on it would double-place if the order actually filled → treat exactly
        // like a failed evidence read (hold, never free). Same detector the daemon's sell-truth read uses.
        if (tradesResponseTruncated(rawTrades)) {
          await held('trades evidence read was truncated (cursor-bearing / at page limit) — a fill could be on a later page; cannot conclude "never posted"');
          continue;
        }
        const trades = parseTrades(rawTrades);
        // PERSPECTIVE-AWARE match (the venue trade record is TAKER-centric): a crash-dangling MAKER
        // order that posted-and-filled arrives as a trade whose TOP-LEVEL side is the TAKER's (the
        // opposite of ours) with OUR fill as a maker leg — the naive `t.side === row.side` check would
        // read it as no-match and FREE a filled order's key → double-place. `tradeCouldBeOurFill`
        // checks the top-level side/price on taker-perspective trades and every maker LEG's own
        // side/price on maker-perspective ones (over-matching a sibling's leg only HOLDS — safe).
        const tradeHit = trades.some((t) => tradeCouldBeOurFill(t, row, tick));
        if (tradeHit) {
          await held('no open order, but a recent trade matching our side/price (taker top-level or a maker leg) could be our fill');
          continue;
        }
        await this.ledger.recordFailed(row.clientOrderId, 'reconcile: confirmed never posted (no open order, no matching trade)');
        out.push({ kind: 'freed', clientOrderId: row.clientOrderId, intentKey: row.intentKey, orderId: null, reason: 'no venue evidence the order exists' });
      } catch (e) {
        // An evidence read failed — freeing on missing evidence is exactly the mistake the ambiguity
        // rule forbids. Hold + alert.
        await held(`evidence read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }
}
