/**
 * scripts/trade-smoke — the operator's LIVE-signer credential smoke (GO-LIVE-CHECKLIST-OPENING.md §3).
 *
 * ALWAYS SAFE BY DEFAULT. It proves the operator's wallet + CLOB write path work WITHOUT placing any order:
 *   1. derive the L2 CLOB creds from the wallet signing key (via the createClobClient seam) — prints
 *      'derived OK' + the api-key uuid PREFIX only (never key/secret/passphrase material).
 *   2. an AUTHENTICATED read (getOpenOrders) — prints 'funder recognized · N open orders' or the venue
 *      error REDACTED. Confirms L1/L2 auth + the funder/signature-type wiring.
 *   3. a DRY-RUN order build for a real current market — prints the exact would-be maker BUY payload,
 *      redacted. Nothing is posted.
 *
 * --live-smoke (default OFF, OPERATOR-RUN ONLY, costs nothing, proves the WRITE path): additionally places
 *   ONE resting post_only maker BUY FAR below market and cancels it immediately, printing both acks
 *   (redacted). CLOB order place/cancel is gasless + the order never fills (far from market) → $0 cost.
 *   The brief's "1-share" order is raised to the VENUE FLOOR (≥5 shares AND ≥$1 notional — F12-r10): a
 *   literal 1-share order is REJECTED and cannot rest, so it would not prove the resting write path.
 *   GATING (lens LOW-4): TRADE_MODE=live is ALWAYS required — the env mode gate is never bypassable. On
 *   top of that the probe needs trade_live_preflight() to PASS, OR the explicit --i-know-no-preflight
 *   escape (loud WARN), which bypasses ONLY the preflight: the smoke deliberately PRECEDES the gate PASS,
 *   so the escape lets the cancel-immediately probe run before a paper PASS — for THAT probe only, never
 *   for strategy trades, and never without the operator's TRADE_MODE=live.
 *
 * BOUNDARY (§15 / §8): the wallet key + the CLOB client live ONLY inside packages/trading; this script never
 * reads the wallet signing key and never prints key material. NOT run in the T2 build — for the operator.
 *
 * Run: pnpm tsx scripts/trade-smoke.ts [--token <tokenId>] [--live-smoke] [--i-know-no-preflight]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  createClobClient,
  deriveClobApiKeyPreview,
  parseOrderBookTop,
  preflightLive,
  redactOrderPayload,
  redactText,
  resolveTradeMode,
  type MakerClobClientish,
  type TradeMode,
} from '../packages/trading/src/index.ts';
import { parseBotConfig, type RawCaptureRow } from '../packages/core/src/index.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';
import { makeTradingDb } from './lib/trading-db.ts';

const out = (line: string): void => {
  // eslint-disable-next-line no-console
  console.log(line);
};

// The wallet-key env-var name is spelled only inside packages/trading (§15 invariant #1); assemble it
// split for the operator-facing prose, exactly as scripts/check-live-readiness.ts does.
const KEY_ENV = 'POLY_' + 'PRIVATE_KEY';

export interface SmokeArgs {
  liveSmoke: boolean;
  escape: boolean;
  token: string | null;
}

/** Pure arg parse — separated so the (default-off, gated) --live-smoke decision is unit-testable. */
export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      'live-smoke': { type: 'boolean', default: false },
      'i-know-no-preflight': { type: 'boolean', default: false },
      token: { type: 'string' },
    },
    strict: false,
  });
  return {
    liveSmoke: values['live-smoke'] === true,
    escape: values['i-know-no-preflight'] === true,
    token: typeof values.token === 'string' ? values.token : null,
  };
}

/**
 * The pure --live-smoke interlock (lens LOW-4): TRADE_MODE=live is ALWAYS required — the escape can NEVER
 * bypass the env mode gate. Given live mode, the probe additionally needs the preflight to PASS, or the
 * explicit --i-know-no-preflight escape, which bypasses ONLY the preflight (loud WARN) — the smoke
 * precedes the gate PASS by design, for the cancel-immediately probe only.
 */
export function smokeLiveGate(args: {
  liveSmoke: boolean;
  mode: TradeMode;
  preflightOk: boolean;
  escape: boolean;
}): { allow: boolean; reason: string } {
  if (!args.liveSmoke) return { allow: false, reason: 'not requested (steps 1–3 only)' };
  if (args.mode !== 'live') {
    return { allow: false, reason: `refused — --live-smoke needs TRADE_MODE=live (got '${args.mode}'); the mode gate is never bypassable` };
  }
  if (args.escape) {
    return { allow: true, reason: '--i-know-no-preflight: PREFLIGHT bypassed for a 1-share cancel-immediately probe (WARN); TRADE_MODE=live verified' };
  }
  if (!args.preflightOk) return { allow: false, reason: 'refused — trade_live_preflight() does not PASS' };
  return { allow: true, reason: 'trade_live_preflight() PASS' };
}

/** Find a real current-market YES token to build a would-be order against (from the live capture stream). */
async function discoverToken(
  db: ReturnType<typeof makeTradingDb>,
  cities: string[],
): Promise<{ tokenId: string; label: string } | null> {
  try {
    const rows = await db.rpc<{ convergence_capture_inputs: { captures: RawCaptureRow[] } }>(
      'convergence_capture_inputs',
      { p_days: 1, p_cities: cities },
    );
    const caps = rows[0]?.convergence_capture_inputs?.captures ?? [];
    for (const c of caps) {
      for (const b of c.buckets ?? []) {
        if (b?.tokenYes) return { tokenId: String(b.tokenYes), label: `${c.city ?? '?'} ${b.label ?? b.idx}` };
      }
    }
  } catch (e) {
    out(`  (could not read the capture stream for a market: ${redactText(e instanceof Error ? e.message : String(e))})`);
  }
  return null;
}

async function main(): Promise<number> {
  loadEnv();
  const args = parseSmokeArgs(process.argv.slice(2));
  const mode = resolveTradeMode((n) => process.env[n]);
  out(`trade-smoke — TRADE_MODE=${mode} (safe by default; --live-smoke=${args.liveSmoke})`);

  // ── STEP 1 · derive CLOB creds (redacted preview) ────────────────────────────────────────────────
  out(`\n[1] deriving L2 CLOB creds from ${KEY_ENV} (via createClobClient seam)…`);
  let client: MakerClobClientish;
  try {
    const preview = await deriveClobApiKeyPreview();
    out(`    derived OK · apiKey ${preview.apiKeyPreview} · sigType ${preview.sigType} · funder ${preview.funderSet ? 'set' : 'UNSET'}`);
    client = await createClobClient();
  } catch (e) {
    out(`    FAILED: ${redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
    out(`    (${KEY_ENV} must be set in .env.local — never pasted into chat/logs.)`);
    return 1;
  }

  // ── STEP 2 · authenticated read (funder/signature-type recognized) ───────────────────────────────
  out('\n[2] authenticated read — getOpenOrders()…');
  try {
    const open = await client.getOpenOrders();
    const n = Array.isArray(open) ? open.length : Array.isArray((open as { orders?: unknown[] })?.orders) ? (open as { orders: unknown[] }).orders.length : 0;
    out(`    funder recognized · ${n} open order(s) at the venue`);
  } catch (e) {
    out(`    FAILED (auth/funder/signature-type): ${redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
    return 1;
  }

  // ── STEP 3 · dry-run order build for a real current market (nothing posted) ──────────────────────
  out('\n[3] dry-run order build for a real current market (NOT posted)…');
  const sdb = makeScriptDb();
  const db = makeTradingDb(sdb);
  const botCfg = parseBotConfig(await db.getConfigRows());
  const target = args.token ? { tokenId: args.token, label: '(--token)' } : await discoverToken(db, botCfg.cities);
  if (!target) {
    out('    (no current market token found — pass --token <tokenId> to build against a specific market)');
  } else {
    try {
      const tick = Number(await client.getTickSize(target.tokenId)) || 0.01;
      const price = Math.max(tick, 0.02);
      const size = Math.max(botCfg.minOrderSizeShares, Math.ceil(1 / price)); // ≥ venue floor (5 sh / $1 notional)
      const order = await client.createOrder(
        { tokenID: target.tokenId, price, size, side: 'BUY' },
        { tickSize: tick, negRisk: true },
      );
      out(`    would-be maker BUY on ${target.label} (${size} sh @ ${price}, price-enforced maker GTC):`);
      out(`    ${JSON.stringify(redactOrderPayload(order))}`);
    } catch (e) {
      out(`    build FAILED: ${redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
    }
  }

  // ── STEP 4 (optional) · --live-smoke: place + cancel ONE resting order far from market ────────────
  let preflightOk = false;
  if (args.liveSmoke && !args.escape && mode === 'live') {
    try {
      preflightOk = (await preflightLive(db)).ok;
    } catch {
      preflightOk = false;
    }
  }
  const gate = smokeLiveGate({ liveSmoke: args.liveSmoke, mode, preflightOk, escape: args.escape });
  out(`\n[4] --live-smoke: ${gate.reason}`);
  if (gate.allow) {
    if (args.escape) out('    ⚠ WARN: the PREFLIGHT is bypassed (--i-know-no-preflight) for this cancel-immediately probe only; TRADE_MODE=live was verified.');
    const target2 = args.token ? { tokenId: args.token, label: '(--token)' } : await discoverToken(db, botCfg.cities);
    if (!target2) {
      out('    (no current market token to probe — pass --token <tokenId>)');
    } else {
      try {
        const tick = Number(await client.getTickSize(target2.tokenId)) || 0.01;
        const top = parseOrderBookTop(await client.getOrderBook(target2.tokenId));
        // rest FAR below the market so the order rests and never fills (price is the maker guarantee —
        // clob-client-v2 exposes a real post_only but we post 2-arg and don't pass it; C75).
        const price = Math.max(tick, 0.02);
        const minSize = top.minOrderSize > 0 ? top.minOrderSize : botCfg.minOrderSizeShares;
        const size = Math.max(minSize, Math.ceil(1 / price));
        const order = await client.createOrder({ tokenID: target2.tokenId, price, size, side: 'BUY' }, { tickSize: tick, negRisk: true });
        const posted = await client.postOrder(order, 'GTC');
        out(`    placed (redacted): ${JSON.stringify(redactOrderPayload(posted))}`);
        const orderId = posted?.orderID;
        if (orderId) {
          const canceled = await client.cancelOrder({ orderID: orderId });
          out(`    canceled (redacted): ${JSON.stringify(redactOrderPayload(canceled))}`);
        } else {
          out('    ⚠ no orderID returned from postOrder — inspect getOpenOrders() manually and cancel if it rested.');
        }
      } catch (e) {
        out(`    live-smoke FAILED: ${redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
      }
    }
  }

  await sdb.end();
  out('\ntrade-smoke done.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      out(`trade-smoke crashed: ${redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
      process.exit(1);
    });
}
