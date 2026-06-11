/**
 * execute-bet — the ONLY process that executes (ARCHITECTURE.md §6.20a, ADR-10).
 *
 * On-demand executor host (NOT cron-scheduled, no runJob wrapper, no waitUntil
 * — the operator is waiting; worst case two API calls). Auth: x-cron-secret,
 * supplied server-side by the web proxy — the browser never holds it.
 *
 * place: bet must be 'recommended' (else 409) → cfg.tradingMode 'live' ⇒
 * goLiveGate; gate FAIL ⇒ 503 with reasons verbatim — NEVER a silent
 * downgrade to a paper fill (C1) ⇒ else LiveExecutor; 'paper' ⇒ PaperExecutor.
 * cancel: TradeExecutor.cancel — pulls a resting GTC order (live), no-op (paper);
 * invoked by poll-markets' live-mode expiry via HTTP (the chokepoint stays intact).
 *
 * Response contract (§8.1): 200 {fill} · 400 · 401 ERR_CRON_AUTH ·
 * 404 ERR_NOT_FOUND · 409 ERR_BAD_STATUS · 422 ERR_STALE_BOOK|ERR_CAPS ·
 * 503 ERR_GATE_FAILED.
 */
import {
  AuthError,
  ExecutionError,
  FillRejected,
  parseConfigRows,
} from '../../../packages/core/src/index.ts';
import {
  LiveExecutor,
  PaperExecutor,
  createClobClient,
  goLiveGate,
  type ApprovedBet,
  type ClobClientish,
  type TradeAlert,
  type TradeExecutor,
} from '../../../packages/trading/src/index.ts';
import { requireCronAuth } from '../_shared/auth.ts';
import type { DbPort } from '../_shared/db.ts';

export interface ExecuteBetDeps {
  db: DbPort;
  /** Live CLOB book for a YES token (paper worse-of re-walk). */
  fetchBook: (tokenId: string) => Promise<unknown>;
  /** Polymarket geoblock list text (goLiveGate re-check). */
  fetchGeoblock: () => Promise<string>;
  getEnvVar: (name: string) => string | undefined;
  notify: (alert: TradeAlert) => Promise<boolean>;
  now: () => Date;
  /** Mock clob-client factory in tests; createClobClient in production. */
  liveClient?: () => Promise<ClobClientish>;
}

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface BetRow {
  betId: string;
  status: string;
  mode: string;
  eventId: string;
  eventSlug: string;
  citySlug: string;
  label: string;
  tokenYes: string;
  feeRate: number | string;
  minOrderSize: number | string;
  tickSize: number | string | null;
  execAsk: number | string;
  recShares: number | string;
  recStakeUsd: number | string;
  recommendedAt: string;
  notes: string | null;
}

const toApprovedBet = (r: BetRow): ApprovedBet => ({
  betId: r.betId,
  status: r.status,
  mode: r.mode as 'paper' | 'live',
  eventId: r.eventId,
  eventSlug: r.eventSlug,
  citySlug: r.citySlug,
  label: r.label,
  tokenYes: r.tokenYes,
  feeRate: Number(r.feeRate),
  minOrderSize: Number(r.minOrderSize),
  tickSize: r.tickSize === null ? null : Number(r.tickSize),
  execAsk: Number(r.execAsk),
  recShares: Number(r.recShares),
  recStakeUsd: Number(r.recStakeUsd),
  recommendedAt: r.recommendedAt,
  notes: r.notes,
});

export async function executeBet(req: Request, deps: ExecuteBetDeps): Promise<Response> {
  try {
    requireCronAuth(req);
  } catch (e) {
    if (e instanceof AuthError) return json(401, { error: 'ERR_CRON_AUTH' });
    throw e; // ConfigError on missing CRON_SECRET: fail loudly, not as a clean 401
  }

  let body: { betId?: unknown; action?: unknown };
  try {
    body = (await req.json()) as { betId?: unknown; action?: unknown };
  } catch {
    return json(400, { error: 'ERR_VALIDATION', details: ['body must be JSON'] });
  }
  const betId = body.betId;
  const action = body.action ?? 'place';
  if (typeof betId !== 'string' || betId.length === 0) {
    return json(400, { error: 'ERR_VALIDATION', details: ['betId required'] });
  }
  if (action !== 'place' && action !== 'cancel') {
    return json(400, { error: 'ERR_VALIDATION', details: [`unknown action '${String(action)}'`] });
  }

  const cfg = parseConfigRows(await deps.db.getConfigRows());
  const [row] = await deps.db.rpc<{ bet_for_execution: BetRow | null }>('bet_for_execution', {
    p_bet_id: betId,
  });
  const betRow = row?.bet_for_execution;
  if (!betRow) return json(404, { error: 'ERR_NOT_FOUND' });
  const bet = toApprovedBet(betRow);

  const paper = new PaperExecutor({
    db: deps.db,
    fetchBook: deps.fetchBook,
    cfg: { paperSlippage: cfg.paperSlippage, paperBookMaxAgeMin: cfg.paperBookMaxAgeMin },
    now: deps.now,
  });
  const live = (): LiveExecutor =>
    new LiveExecutor({
      db: deps.db,
      client: deps.liveClient ?? createClobClient,
      notify: deps.notify,
    });

  if (action === 'cancel') {
    if (cfg.tradingMode === 'live') await live().cancel(bet.betId);
    else await paper.cancel(bet.betId);
    return json(200, { canceled: true, mode: cfg.tradingMode });
  }

  if (bet.status !== 'recommended') {
    return json(409, { error: 'ERR_BAD_STATUS', status: bet.status });
  }

  let executor: TradeExecutor;
  if (cfg.tradingMode === 'live') {
    const gate = await goLiveGate(deps.db, cfg, {
      citySlug: bet.citySlug,
      getEnvVar: deps.getEnvVar,
      fetchGeoblock: deps.fetchGeoblock,
      now: deps.now(),
    });
    // C1: gate failure is a 503 with the reasons verbatim — NEVER a silent
    // downgrade to a paper fill.
    if (!gate.pass) return json(503, { error: 'ERR_GATE_FAILED', reasons: gate.reasons });
    if (bet.mode !== 'live') {
      // The rec was sized against the other mode's bankroll (config flipped
      // since recommendation) — state-machine conflict, not a silent re-mode.
      return json(409, { error: 'ERR_BAD_STATUS', status: `mode:${bet.mode}` });
    }
    executor = live();
  } else {
    if (bet.mode !== 'paper') {
      return json(409, { error: 'ERR_BAD_STATUS', status: `mode:${bet.mode}` });
    }
    executor = paper;
  }

  try {
    const fill = await executor.place(bet);
    return json(200, { fill });
  } catch (e) {
    if (e instanceof FillRejected) {
      const details = (e.details?.['details'] as string[] | undefined) ?? [e.message];
      if (e.reason === 'stale_book') return json(422, { error: 'ERR_STALE_BOOK', details });
      if (e.reason === 'caps') return json(422, { error: 'ERR_CAPS', details });
      return json(409, {
        error: 'ERR_BAD_STATUS',
        status: String(e.details?.['status'] ?? e.reason),
      });
    }
    if (e instanceof ExecutionError) {
      // LiveExecutor already set 'execution_failed' + CRITICAL — relay the code.
      return json(502, { error: e.code, details: [e.message] });
    }
    throw e;
  }
}
