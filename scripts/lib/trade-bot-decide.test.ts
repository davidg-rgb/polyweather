/**
 * Tests for the live maker-exit daemon's PURE decision spine (tick → intents) + its driver. NO network:
 * every executor / ledger / preflight / book is a fixture. Covers the T2 test contract — entry gating
 * (maxEntry / depth / allowlist / caps / preflight-block), TP/SL/time-stop arming + firing, the reprice
 * window, restart resume (ledger rows → resumed state), off/dry-run never posting, and record_*-raise
 * routing — plus the t2-lens regressions: sold-truth accounting (CRITICAL-1/LOW-5), the live-kill
 * entry-cancel (MEDIUM-2), the venue-dead FAK adjudication against a by_intent-faithful fake ledger
 * (MEDIUM-3), and the TP-cancel race guard.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionError } from '../../packages/core/src/index.ts';
import { makerExitCfg } from '../../packages/core/src/index.ts';
import { orderIntentKey } from '../../packages/trading/src/index.ts';
import type {
  CancelResult,
  MakerOrderRequest,
  OrderLedger,
  OrderLedgerRow,
  OrderPlacementResult,
  ReserveIntentInput,
  TakerOrderRequest,
  TradeAlert,
  TradeConfig,
  TradeMode,
  TradePreflight,
} from '../../packages/trading/src/index.ts';
import {
  applyPlan,
  assemblePosition,
  decideTick,
  discoverCandidates,
  dustParkAlerts,
  dustRemainder,
  entryCancelDeferredAlerts,
  metaDegradedAlert,
  sellHoldAlerts,
  stopOf,
  timeStopMsOf,
  toDecideCfg,
  type DaemonExecutor,
  type DecideCfg,
  type DiscoveredCandidate,
  type Intent,
  type LivePosition,
  type OrderHandle,
  type TickState,
} from './trade-bot-decide.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const CFG: DecideCfg = toDecideCfg(makerExitCfg(['amsterdam', 'paris', 'madrid']), 5);
const NOW = new Date('2026-07-06T06:00:00Z');

function config(over: Partial<TradeConfig> = {}): TradeConfig {
  return {
    mode: 'live',
    stakePerBuyUsd: 10,
    perPositionCapUsd: 25,
    perMarketCapUsd: 40,
    totalConcurrentCapUsd: 100,
    dailyLossKillUsd: 30,
    dailyLossKillFrac: 0.25,
    cityAllowlist: null,
    activeUntil: '2026-12-31',
    ...over,
  };
}

function preflight(over: Partial<TradePreflight['checks']> = {}, ok = true, reasons: string[] = []): TradePreflight {
  return {
    ok,
    reasons,
    checks: {
      mode: 'live',
      activeUntil: '2026-12-31',
      stakePerBuyUsd: 10,
      perPositionCapUsd: 25,
      perMarketCapUsd: 40,
      totalConcurrentCapUsd: 100,
      gatePass: true,
      override: false,
      overrideReason: null,
      overrideExpiresAt: null,
      todayLossUsd: 0,
      lossWindowStart: '2026-07-06T00:00:00Z',
      dailyLossKillUsd: 30,
      dailyLossKillFracBasisUsd: 25,
      openExposureUsd: 0,
      perMarketExposureUsd: {},
      ...over,
    },
  };
}

function cand(over: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate {
  return {
    marketId: 'm1',
    tokenId: 't1',
    city: 'amsterdam',
    targetDate: '2026-07-06',
    tz: 'Europe/Amsterdam',
    bucketIdx: 5,
    label: '20-21C',
    execAsk: 0.15,
    modelProb: 0.3,
    depthUsd: 300,
    makerLimit: 0.14,
    bestBid: 0.12,
    bestAsk: 0.16,
    resolvesAtMs: Date.parse('2026-07-07T22:00:00Z'),
    ...over,
  };
}

function handle(over: Partial<OrderHandle> = {}): OrderHandle {
  return {
    orderId: 'v1',
    clientOrderId: 'c1',
    status: 'placed',
    purpose: 'entry',
    price: 0.14,
    size: 66,
    sizeMatched: 0,
    restingSinceMs: NOW.getTime(),
    ...over,
  };
}

function position(over: Partial<LivePosition> = {}): LivePosition {
  return {
    marketId: 'm1',
    tokenId: 't1',
    city: 'amsterdam',
    targetDate: '2026-07-06',
    tz: 'Europe/Amsterdam',
    resolvesAtMs: Date.parse('2026-07-07T22:00:00Z'),
    entryPrice: 0.15,
    modelProb: 0.3,
    filledSize: 66,
    soldSize: 0,
    soldTruthDegraded: false,
    entryPollFresh: true,
    metaDegraded: false,
    mark: 0.2,
    entry: handle({ status: 'filled', sizeMatched: 66 }),
    tp: null,
    exit: null,
    ...over,
  };
}

function state(over: Partial<TickState> = {}): TickState {
  return { mode: 'live', config: config(), preflight: preflight(), cfg: CFG, now: NOW, candidates: [], positions: [], ...over };
}

const enters = (p: { intents: Intent[] }): Extract<Intent, { kind: 'enter' }>[] =>
  p.intents.filter((i): i is Extract<Intent, { kind: 'enter' }> => i.kind === 'enter');

// ── cfg sanity — the tuned constants flow through ──────────────────────────────────────────────────
describe('toDecideCfg (the tuned MAKER-EXIT params)', () => {
  it('carries the §5 sweep optimum', () => {
    expect(CFG.maxEntryPrice).toBe(0.3);
    expect(CFG.depthFloorUsd).toBe(150);
    expect(CFG.tpDeltaPp).toBe(0.12);
    expect(CFG.slDeltaPp).toBe(0.2);
    expect(CFG.makerFillWindowMin).toBe(30);
    expect(CFG.tstopHoursBeforeResolve).toBe(18);
    expect(CFG.minOrderSizeShares).toBe(5);
  });
});

// ── ENTRY GATING ───────────────────────────────────────────────────────────────────────────────────
describe('decideTick — entry gating', () => {
  it('enters a clean candidate (live, preflight ok, within caps)', () => {
    const plan = decideTick(state({ candidates: [cand()] }));
    const e = enters(plan);
    expect(e).toHaveLength(1);
    expect(e[0]!.req).toMatchObject({ marketId: 'm1', tokenId: 't1', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-06', targetPrice: 0.14 });
    expect(e[0]!.req.size).toBeCloseTo(10 / 0.15, 4);
  });

  it('skips above the max entry price', () => {
    const plan = decideTick(state({ candidates: [cand({ execAsk: 0.35 })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('above_max_entry'))).toBe(true);
  });

  it('skips below the depth floor', () => {
    const plan = decideTick(state({ candidates: [cand({ depthUsd: 100 })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('below_depth_floor'))).toBe(true);
  });

  it('skips an off-allowlist city', () => {
    const plan = decideTick(state({ candidates: [cand({ city: 'tokyo' })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('off_allowlist'))).toBe(true);
  });

  it('skips below the venue min order size', () => {
    // stake $1 @ ask 0.30 ⇒ 3.33 shares < 5.
    const plan = decideTick(state({ config: config({ stakePerBuyUsd: 1 }), candidates: [cand({ execAsk: 0.3 })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('below_min_size'))).toBe(true);
  });

  it('skips a candidate already positioned', () => {
    const plan = decideTick(state({ candidates: [cand()], positions: [position()] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason === 'already_positioned')).toBe(true);
  });

  it('enforces the per-market cap from the preflight exposure', () => {
    const plan = decideTick(state({ candidates: [cand()], preflight: preflight({ perMarketExposureUsd: { m1: 35 } }) }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('per-market cap'))).toBe(true);
  });

  it('enforces the total-concurrent cap', () => {
    const plan = decideTick(state({ candidates: [cand()], preflight: preflight({ openExposureUsd: 95 }) }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('total-concurrent cap'))).toBe(true);
  });

  it('adds each accepted stake to the running exposure (no double-slip under the total cap)', () => {
    // two distinct markets, total cap 15, stake 10 → the first enters, the second breaches 10+10>15.
    const plan = decideTick(
      state({
        config: config({ totalConcurrentCapUsd: 15 }),
        candidates: [cand({ marketId: 'a' }), cand({ marketId: 'b' })],
      }),
    );
    expect(enters(plan)).toHaveLength(1);
    expect(plan.skips.some((s) => s.reason.includes('total-concurrent cap'))).toBe(true);
  });

  it('blocks ALL entries when the live preflight fails, but still fires exits', () => {
    const pos = position({ mark: 0.05 }); // below the SL → must still flatten
    const plan = decideTick(state({ candidates: [cand()], positions: [pos], preflight: preflight({}, false, ['daily-loss kill']) }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('preflight_blocked'))).toBe(true);
    expect(plan.intents.some((i) => i.kind === 'exit_taker' && i.purpose === 'stop_loss')).toBe(true);
  });

  it('off mode produces no intents at all', () => {
    const plan = decideTick(state({ mode: 'off', candidates: [cand()], positions: [position({ mark: 0.01 })] }));
    expect(plan.intents).toHaveLength(0);
  });

  it('dry-run enters WITHOUT preflight/caps (its ledger rows never count toward live caps)', () => {
    const plan = decideTick(
      state({ mode: 'dry-run', preflight: null, candidates: [cand()], config: config({ totalConcurrentCapUsd: 1 }) }),
    );
    expect(enters(plan)).toHaveLength(1); // the $1 total cap would block live, but dry-run ignores caps
  });
});

// ── EXIT ARMING + FIRING ─────────────────────────────────────────────────────────────────────────
describe('decideTick — position management', () => {
  it('rests the maker take-profit once when holding, below TP, above SL, before the time-stop', () => {
    const plan = decideTick(state({ positions: [position({ mark: 0.2, tp: null })] }));
    const tp = plan.intents.find((i) => i.kind === 'rest_tp');
    expect(tp).toBeDefined();
    expect((tp as Extract<Intent, { kind: 'rest_tp' }>).req).toMatchObject({ side: 'SELL', purpose: 'take_profit', targetPrice: 0.15 + 0.12, size: 66 });
  });

  it('does not re-rest a TP that is already resting', () => {
    const plan = decideTick(state({ positions: [position({ mark: 0.2, tp: handle({ purpose: 'take_profit', status: 'placed', orderId: 'tp1', clientOrderId: 'ctp1' }) })] }));
    expect(plan.intents.filter((i) => i.kind === 'rest_tp')).toHaveLength(0);
  });

  it('fires a taker stop-loss when the mark falls to/below the ternary stop, cancelling the resting TP', () => {
    // entry 0.15 → slStop = 0.15×0.5 = 0.075 (−0.20 is inert this cheap); mark 0.07 ≤ 0.075.
    const tp = handle({ purpose: 'take_profit', status: 'placed', orderId: 'tp1', clientOrderId: 'ctp1' });
    const plan = decideTick(state({ positions: [position({ mark: 0.07, tp })] }));
    const sl = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(sl.purpose).toBe('stop_loss');
    expect(sl.req).toMatchObject({ side: 'SELL', purpose: 'stop_loss', worstPrice: 0.07 });
    expect(sl.cancelTp).toEqual({ orderId: 'tp1', clientOrderId: 'ctp1', sizeMatched: 0 });
  });

  it('holds (no stop) when the mark sits above the stop', () => {
    const plan = decideTick(state({ positions: [position({ mark: 0.1, tp: handle({ purpose: 'take_profit', status: 'placed' }) })] }));
    expect(plan.intents.filter((i) => i.kind === 'exit_taker')).toHaveLength(0);
  });

  it('fires a taker time-stop at resolvesAt − 18h', () => {
    // resolvesAt = now + 1h ⇒ timeStop = now − 17h ⇒ already past.
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, tp: handle({ purpose: 'take_profit', status: 'placed', orderId: 'tp1', clientOrderId: 'ctp1' }) });
    const plan = decideTick(state({ positions: [pos] }));
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex.purpose).toBe('time_stop');
    expect(ex.cancelTp).toEqual({ orderId: 'tp1', clientOrderId: 'ctp1', sizeMatched: 0 });
  });

  it('the time-stop takes priority over the take-profit rest', () => {
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, tp: null });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents.some((i) => i.kind === 'exit_taker' && i.purpose === 'time_stop')).toBe(true);
    expect(plan.intents.some((i) => i.kind === 'rest_tp')).toBe(false);
  });

  it('re-fires only the UNSOLD remainder after a partial taker flatten', () => {
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, filledSize: 66, soldSize: 40, exit: handle({ purpose: 'time_stop', status: 'partial', sizeMatched: 40 }) });
    const plan = decideTick(state({ positions: [pos] }));
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex.req.size).toBe(26);
  });

  it('no intent once fully flattened', () => {
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, filledSize: 66, soldSize: 66, exit: handle({ purpose: 'time_stop', status: 'filled', sizeMatched: 66 }) });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents).toHaveLength(0);
  });
});

// ── SOLD-TRUTH ACCOUNTING (lens CRITICAL-1 + LOW-5) — the over-sell path is closed ─────────────────
describe('decideTick — sold-truth accounting (CRITICAL-1/LOW-5)', () => {
  const tpFilled = (matched: number, size = 66) =>
    handle({ purpose: 'take_profit', status: matched >= size ? 'filled' : 'partial', orderId: 'tp1', clientOrderId: 'ctp1', size, sizeMatched: matched });

  it('CRIT-1a: a FULLY-filled take-profit closes the position — no exit fires even past the time-stop', () => {
    // resolvesAt = now + 1h ⇒ the time-stop clock has tripped; the TP already sold everything.
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.3, soldSize: 66, tp: tpFilled(66) });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents).toHaveLength(0);
  });

  it('CRIT-1b: a PARTIAL take-profit (40/66) + time-stop exits EXACTLY the 26 unsold shares, cancelling the TP rest', () => {
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.3, soldSize: 40, tp: tpFilled(40) });
    const plan = decideTick(state({ positions: [pos] }));
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex.purpose).toBe('time_stop');
    expect(ex.req.size).toBe(26);
    // the decide-time TP matched rides along as the raced-fill baseline for applyPlan's re-derive.
    expect(ex.cancelTp).toEqual({ orderId: 'tp1', clientOrderId: 'ctp1', sizeMatched: 40 });
  });

  it('CRIT-1c: a fully-filled take-profit suppresses the stop-loss — no sell on a crashed mark', () => {
    const pos = position({ mark: 0.01, soldSize: 66, tp: tpFilled(66) }); // mark deep below the stop
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents.filter((i) => i.kind === 'exit_taker')).toHaveLength(0);
    expect(plan.intents.filter((i) => i.kind === 'rest_tp')).toHaveLength(0);
  });

  it('LOW-5: both stop_loss and time_stop fills count once — a covered position plans nothing', () => {
    // 30 sold by an SL partial + 36 by a later time-stop = 66 = held (assembly sums them into soldSize).
    const pos = position({
      resolvesAtMs: NOW.getTime() + 3_600_000,
      mark: 0.01,
      soldSize: 66,
      exit: handle({ purpose: 'stop_loss', status: 'partial', sizeMatched: 30 }),
    });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents).toHaveLength(0);
  });

  it('a partial TP shrinks what a stop-loss may sell (no over-sell through the SL path)', () => {
    const pos = position({ mark: 0.05, soldSize: 40, tp: tpFilled(40) }); // SL trigger, 26 unsold
    const plan = decideTick(state({ positions: [pos] }));
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex.purpose).toBe('stop_loss');
    expect(ex.req.size).toBe(26);
  });
});

// ── DEGRADED-MODE SELL HOLD (lens NEW-LOW-1) — getTrades is safety-load-bearing ─────────────────────
describe('decideTick — degraded sell-truth holds every SELL for the position', () => {
  // the invisible-fill fixture: the TP partial-filled 40 then was cancelled (its row is terminal →
  // invisible), the visible ledger shows only soldSize 0, and the venue read is DOWN — soldSize is
  // understated and any SELL sized from it would over-sell.
  const degraded = (over: Partial<LivePosition> = {}) =>
    position({ soldTruthDegraded: true, soldSize: 0, tp: null, ...over });

  it('NEW-LOW-1: no taker exit posts while venue sell-truth is unavailable — even past the time-stop', () => {
    const plan = decideTick(state({ positions: [degraded({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25 })] }));
    expect(plan.intents.filter((i) => i.kind === 'exit_taker')).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('sell_hold_degraded'))).toBe(true);
  });

  it('NEW-LOW-1: no stop-loss posts on a crashed mark while degraded', () => {
    const plan = decideTick(state({ positions: [degraded({ mark: 0.01 })] }));
    expect(plan.intents.filter((i) => i.kind === 'exit_taker')).toHaveLength(0);
  });

  it('NEW-LOW-1: the TP rest is held too (its sizing has the same over-sell exposure)', () => {
    const plan = decideTick(state({ positions: [degraded({ mark: 0.2 })] }));
    expect(plan.intents.filter((i) => i.kind === 'rest_tp')).toHaveLength(0);
  });

  it('entry-side management is unaffected (BUY side has no over-sell risk)', () => {
    const entry = handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 31 * 60_000 });
    const plan = decideTick(state({ positions: [degraded({ filledSize: 0, entry, mark: null })] }));
    expect(plan.intents.some((i) => i.kind === 'reprice_entry')).toBe(true);
  });

  it('venueSold restored → the exit resumes, correctly sized from the venue floor', () => {
    // same position, read recovered: venue truth says 40 already sold → the time-stop fires exactly 26.
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, soldTruthDegraded: false, soldSize: 40, tp: null });
    const plan = decideTick(state({ positions: [pos] }));
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex.purpose).toBe('time_stop');
    expect(ex.req.size).toBe(26);
    expect(plan.skips.some((s) => s.reason.includes('sell_hold_degraded'))).toBe(false);
  });

  it('sellHoldAlerts maps each degraded held position to a CRITICAL alert (fired every affected tick)', () => {
    const alerts = sellHoldAlerts([degraded({ mark: 0.01 }), position({ soldTruthDegraded: false })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'TRADE_BOT_SELL_HOLD', severity: 'CRITICAL' });
    expect(alerts[0]!.body).toContain('PAUSED');
  });

  it('sellHoldAlerts stays quiet for a degraded position already fully covered by VISIBLE fills', () => {
    // nothing is held back — no sell would fire anyway, so no CRITICAL page.
    const alerts = sellHoldAlerts([degraded({ soldSize: 66 })]);
    expect(alerts).toHaveLength(0);
  });
});

// ── REPRICE WINDOW ─────────────────────────────────────────────────────────────────────────────────
describe('decideTick — entry reprice window', () => {
  it('holds a resting entry within the maker window', () => {
    const entry = handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 10 * 60_000 }); // 10 min
    const plan = decideTick(state({ positions: [position({ filledSize: 0, entry, tp: null, mark: null })] }));
    expect(plan.intents).toHaveLength(0);
  });

  it('reprices a resting entry past the maker window (re-peg the remainder)', () => {
    const entry = handle({ status: 'placed', sizeMatched: 0, size: 66, restingSinceMs: NOW.getTime() - 31 * 60_000 }); // 31 min > 30
    const plan = decideTick(state({ positions: [position({ filledSize: 0, entry, tp: null, mark: null })] }));
    const rp = plan.intents.find((i) => i.kind === 'reprice_entry') as Extract<Intent, { kind: 'reprice_entry' }>;
    expect(rp).toBeDefined();
    expect(rp.oldOrderId).toBe('v1');
    expect(rp.oldClientOrderId).toBe('c1');
    expect(rp.req.size).toBe(66); // the ORIGINAL intent size (executor reposts the remainder)
    expect(rp.req.targetPrice).toBeCloseTo(Math.min(0.3, 0.3 - 0.05), 6);
  });

  it('does NOT reprice a dangling entry (no venue orderId — reconcile owns it)', () => {
    const entry = handle({ status: 'placed', orderId: null, sizeMatched: 0, restingSinceMs: NOW.getTime() - 60 * 60_000 });
    const plan = decideTick(state({ positions: [position({ filledSize: 0, entry, tp: null, mark: null })] }));
    expect(plan.intents.filter((i) => i.kind === 'reprice_entry')).toHaveLength(0);
  });
});

// ── LIVE-KILL ENTRY CANCEL (lens MEDIUM-2) — a kill stops new exposure within one tick ──────────────
describe('decideTick — live kill (preflight fail) cancels resting entries, never reprices', () => {
  const failedPre = preflight({}, false, ['daily-loss kill tripped']);

  it('MEDIUM-2: preflight fail → NO reprice_entry; the resting unfilled entry is CANCELLED instead', () => {
    // 31 min resting — would reprice on a healthy tick.
    const entry = handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 31 * 60_000 });
    const plan = decideTick(state({ preflight: failedPre, positions: [position({ filledSize: 0, entry, tp: null, mark: null })] }));
    expect(plan.intents.filter((i) => i.kind === 'reprice_entry')).toHaveLength(0);
    const ce = plan.intents.find((i) => i.kind === 'cancel_entry') as Extract<Intent, { kind: 'cancel_entry' }>;
    expect(ce).toBeDefined();
    expect(ce.orderId).toBe('v1');
    expect(ce.clientOrderId).toBe('c1');
  });

  it('cancels a resting entry even INSIDE the maker window (a kill does not wait for the reprice clock)', () => {
    const entry = handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 5 * 60_000 }); // 5 min
    const plan = decideTick(state({ preflight: failedPre, positions: [position({ filledSize: 0, entry, tp: null, mark: null })] }));
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(true);
  });

  it("NEW-LOW-2: a PARTIALLY-filled entry's resting remainder is deliberately LEFT WORKING under a kill; exits stay armed", () => {
    // entry partial: 20 filled of 66, remainder resting; mark below the stop → the SL must still fire.
    // Cancelling the remainder would record_canceled the entry row → terminal → invisible to by_intent →
    // the NEXT tick could not reconstruct the position and the 20 held shares would lose their SL/time-stop
    // backstop. The remainder's exposure is already committed capital in the preflight accounting.
    const entry = handle({ status: 'partial', sizeMatched: 20 });
    const pos = position({ filledSize: 20, soldSize: 0, entry, tp: null, mark: 0.05 });
    const plan = decideTick(state({ preflight: failedPre, positions: [pos] }));
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(false); // remainder NOT cancelled
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex.purpose).toBe('stop_loss'); // exits still armed — the held shares stay managed
    expect(ex.req.size).toBe(20); // only what is held
  });

  it('the TP rest still arms under a kill (it only flattens — not new exposure)', () => {
    const plan = decideTick(state({ preflight: failedPre, positions: [position({ mark: 0.2, tp: null })] }));
    expect(plan.intents.some((i) => i.kind === 'rest_tp')).toBe(true);
  });

  it('dry-run never emits cancel_entry (the kill gate is live-only)', () => {
    const entry = handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 31 * 60_000 });
    const plan = decideTick(state({ mode: 'dry-run', preflight: null, positions: [position({ filledSize: 0, entry, tp: null, mark: null })] }));
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(false);
    expect(plan.intents.some((i) => i.kind === 'reprice_entry')).toBe(true); // the normal window action
  });

  it('does not cancel a dangling entry (no orderId — reconcile owns it) even under a kill', () => {
    const entry = handle({ status: 'placed', orderId: null, sizeMatched: 0, restingSinceMs: NOW.getTime() - 60 * 60_000 });
    const plan = decideTick(state({ preflight: failedPre, positions: [position({ filledSize: 0, entry, tp: null, mark: null })] }));
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(false);
  });

  // ── §11.2 — the kill-cancel is gated on a FRESH successful entry poll this tick ──────────────────
  const restingUnfilled = () => handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 31 * 60_000 });

  it('§11.2: a STALE entry poll (entryPollFresh=false) DEFERS the cancel — no cancel_entry, a skip is surfaced', () => {
    const plan = decideTick(state({ preflight: failedPre, positions: [position({ filledSize: 0, entry: restingUnfilled(), entryPollFresh: false, tp: null, mark: null })] }));
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(false); // NOT cancelled on stale data
    expect(plan.intents.some((i) => i.kind === 'reprice_entry')).toBe(false); // reprice is still kill-suppressed
    expect(plan.skips.some((s) => s.reason.includes('cancel_entry_deferred_stale_poll'))).toBe(true);
  });

  it('§11.2: a later tick with a FRESH 0-matched poll (entryPollFresh=true) DOES cancel the entry', () => {
    const plan = decideTick(state({ preflight: failedPre, positions: [position({ filledSize: 0, entry: restingUnfilled(), entryPollFresh: true, tp: null, mark: null })] }));
    const ce = plan.intents.find((i) => i.kind === 'cancel_entry') as Extract<Intent, { kind: 'cancel_entry' }>;
    expect(ce).toBeDefined();
    expect(ce.orderId).toBe('v1');
    expect(plan.skips.some((s) => s.reason.includes('cancel_entry_deferred_stale_poll'))).toBe(false);
  });

  it('§11.2: a stale poll on a KNOWN partial does NOT trigger the defer skip (the remainder is left working anyway, NEW-LOW-2)', () => {
    // filledSize>0 → the partial-remainder path (never cancelled) owns this; the stale-poll defer excludes it.
    const entry = handle({ status: 'partial', sizeMatched: 20 });
    const plan = decideTick(state({ preflight: failedPre, positions: [position({ filledSize: 20, soldSize: 0, entry, entryPollFresh: false, tp: null, mark: 0.05 })] }));
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(false);
    expect(plan.skips.some((s) => s.reason.includes('cancel_entry_deferred_stale_poll'))).toBe(false);
    expect(plan.intents.some((i) => i.kind === 'exit_taker' && i.purpose === 'stop_loss')).toBe(true); // exits still armed
  });

  it('§11.2: entryCancelDeferredAlerts fires a WARN per deferred position, and only when entriesBlocked', () => {
    const stale = position({ filledSize: 0, entry: restingUnfilled(), entryPollFresh: false, tp: null, mark: null });
    const fresh = position({ filledSize: 0, entry: restingUnfilled(), entryPollFresh: true, tp: null, mark: null });
    // entriesBlocked=true → exactly the stale one pages (WARN, never CRITICAL)
    const alerts = entryCancelDeferredAlerts([stale, fresh], true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'TRADE_BOT_ENTRY_CANCEL_DEFERRED', severity: 'WARN' });
    expect(alerts[0]!.body).toContain('DEFERRED');
    // no kill → no alert at all
    expect(entryCancelDeferredAlerts([stale], false)).toHaveLength(0);
  });

  it('§11.2: a stale poll is HARMLESS on a healthy tick (no kill) — the reprice window still governs', () => {
    // entriesBlocked=false → the stale flag is never consulted; the 31-min window reprices as normal.
    const plan = decideTick(state({ positions: [position({ filledSize: 0, entry: restingUnfilled(), entryPollFresh: false, tp: null, mark: null })] }));
    expect(plan.intents.some((i) => i.kind === 'reprice_entry')).toBe(true);
    expect(plan.skips.some((s) => s.reason.includes('cancel_entry_deferred_stale_poll'))).toBe(false);
  });
});

// ── PREFLIGHT READ FAILURE (finding #15) — a hold, never a kill ─────────────────────────────────────
describe('decideTick — a failed preflight READ holds; only a REAL verdict cancels (finding #15)', () => {
  const restingUnfilled = () => handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 31 * 60_000 });

  it('read failure → NO cancel_entry AND NO reprice: the resting entry is left untouched at the venue', () => {
    const plan = decideTick(
      state({ preflight: null, preflightReadFailed: true, positions: [position({ filledSize: 0, entry: restingUnfilled(), tp: null, mark: null })] }),
    );
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(false); // a DB blip must not cancel at the venue
    expect(plan.intents.some((i) => i.kind === 'reprice_entry')).toBe(false); // the interlock cannot be confirmed
  });

  it('read failure → candidates are skipped with the distinct preflight_read_failed reason (not preflight_blocked)', () => {
    const plan = decideTick(state({ preflight: null, preflightReadFailed: true, candidates: [cand()] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('preflight_read_failed'))).toBe(true);
    expect(plan.skips.some((s) => s.reason.includes('preflight_blocked'))).toBe(false);
  });

  it('read failure → exits still fire and the TP rest still arms (exits are NEVER preflight-gated)', () => {
    const crashed = position({ mark: 0.05 }); // below the ternary stop
    const healthy = position({ marketId: 'm2', mark: 0.2, tp: null });
    const plan = decideTick(state({ preflight: null, preflightReadFailed: true, positions: [crashed, healthy] }));
    expect(plan.intents.some((i) => i.kind === 'exit_taker' && i.purpose === 'stop_loss')).toBe(true);
    expect(plan.intents.some((i) => i.kind === 'rest_tp')).toBe(true);
  });

  it('read failure never raises the stale-poll defer skip (nothing wants a cancel in the first place)', () => {
    const stale = position({ filledSize: 0, entry: restingUnfilled(), entryPollFresh: false, tp: null, mark: null });
    const plan = decideTick(state({ preflight: null, preflightReadFailed: true, positions: [stale] }));
    expect(plan.skips.some((s) => s.reason.includes('cancel_entry_deferred_stale_poll'))).toBe(false);
    // the daemon computes killWantsCancel=false on a read failure → no defer WARN either
    expect(entryCancelDeferredAlerts([stale], false)).toHaveLength(0);
  });

  it('a REAL negative verdict (successful read) still cancels — the two states stay distinct', () => {
    const plan = decideTick(
      state({ preflight: preflight({}, false, ['daily-loss kill']), preflightReadFailed: false, positions: [position({ filledSize: 0, entry: restingUnfilled(), tp: null, mark: null })] }),
    );
    expect(plan.intents.some((i) => i.kind === 'cancel_entry')).toBe(true);
  });

  it('dry-run ignores preflightReadFailed entirely (the interlock is live-only)', () => {
    const plan = decideTick(state({ mode: 'dry-run', preflight: null, preflightReadFailed: true, candidates: [cand()] }));
    expect(enters(plan)).toHaveLength(1);
  });
});

// ── DEGRADED / UNSEEDED CAPTURE META (findings #4/#5/#9) — positions never lose their exits ────────
describe('decideTick — degraded/unseeded capture meta never gates the exits', () => {
  it('an UNSEEDED capture (modelProb null) still fires the time-stop from the known resolvesAt clock', () => {
    const pos = position({ modelProb: null, resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, tp: null });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents.some((i) => i.kind === 'exit_taker' && i.purpose === 'time_stop')).toBe(true);
  });

  it('an unseeded capture holds ONLY the reprice: no re-peg target without houseProb, skip surfaced', () => {
    const entry = handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 31 * 60_000 }); // past window
    const plan = decideTick(state({ positions: [position({ filledSize: 0, entry, modelProb: null, tp: null, mark: null })] }));
    expect(plan.intents.some((i) => i.kind === 'reprice_entry')).toBe(false);
    expect(plan.skips.some((s) => s.reason.includes('reprice_held_unseeded'))).toBe(true);
  });

  it('metaDegraded: the stop-loss still fires on a live mark (exits run on ledger truth)', () => {
    const pos = position({ metaDegraded: true, modelProb: null, resolvesAtMs: null, city: '', tz: '', mark: 0.05 });
    const plan = decideTick(state({ positions: [pos] }));
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex).toBeDefined();
    expect(ex.purpose).toBe('stop_loss');
  });

  it('metaDegraded: the TP rest still arms (sized from entryPrice + delta — no capture dependency)', () => {
    const pos = position({ metaDegraded: true, modelProb: null, resolvesAtMs: null, city: '', tz: '', mark: 0.2, tp: null });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents.some((i) => i.kind === 'rest_tp')).toBe(true);
  });

  it('metaDegraded surfaces the meta_degraded skip and holds the reprice', () => {
    const entry = handle({ status: 'placed', sizeMatched: 0, restingSinceMs: NOW.getTime() - 31 * 60_000 });
    const pos = position({ metaDegraded: true, modelProb: null, resolvesAtMs: null, city: '', tz: '', filledSize: 0, entry, tp: null, mark: null });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents.some((i) => i.kind === 'reprice_entry')).toBe(false);
    expect(plan.skips.some((s) => s.reason.includes('meta_degraded'))).toBe(true);
  });

  it('metaDegradedAlert maps the degraded positions to ONE WARN naming them; null when none', () => {
    const degraded = position({ metaDegraded: true, modelProb: null, city: '', tz: '' });
    const alert = metaDegradedAlert([degraded, position({ marketId: 'm2' })]);
    expect(alert).not.toBeNull();
    expect(alert).toMatchObject({ kind: 'TRADE_BOT_META_DEGRADED', severity: 'WARN' });
    expect(alert!.body).toContain('m1');
    expect(alert!.body).not.toContain('m2 '); // only the degraded one is named
    expect(metaDegradedAlert([position()])).toBeNull();
  });
});

// ── ONE BUCKET PER EVENT (findings #4/#5/#9) — the drift double-entry guard ─────────────────────────
describe('decideTick — a drifted forecast center cannot open a second position in the same event', () => {
  it('a candidate in the SAME event (city+date, different bucket/conditionId) is skipped', () => {
    const plan = decideTick(state({ positions: [position()], candidates: [cand({ marketId: 'm2', tokenId: 't2' })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('already_positioned_event'))).toBe(true);
  });

  it('a different event (other city or date) still enters', () => {
    const plan = decideTick(
      state({
        positions: [position()],
        candidates: [cand({ marketId: 'm3', city: 'paris', tz: 'Europe/Paris' }), cand({ marketId: 'm4', targetDate: '2026-07-07' })],
      }),
    );
    expect(enters(plan)).toHaveLength(2);
  });

  it('a metaDegraded position (unknown city) still market-blocks its own conditionId', () => {
    const pos = position({ metaDegraded: true, modelProb: null, city: '', tz: '' });
    const plan = decideTick(state({ positions: [pos], candidates: [cand()] })); // same marketId m1
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason === 'already_positioned')).toBe(true);
  });
});

// ── EXIT MATH ──────────────────────────────────────────────────────────────────────────────────────
describe('exit math', () => {
  it('stopOf is the ternary (absolute −slDeltaPp where positive, else the relative floor)', () => {
    expect(stopOf(0.4, CFG)).toBeCloseTo(0.2, 6); // 0.4 − 0.2
    expect(stopOf(0.15, CFG)).toBeCloseTo(0.075, 6); // 0.15×0.5 (−0.2 inert)
  });
  it('timeStopMsOf prefers resolvesAt − Nh', () => {
    const p = position({ resolvesAtMs: Date.parse('2026-07-07T18:00:00Z') });
    expect(timeStopMsOf(p, CFG)).toBe(Date.parse('2026-07-07T18:00:00Z') - 18 * 3_600_000);
  });
  it('timeStopMsOf falls back to local noon when resolvesAt is unknown', () => {
    const p = position({ resolvesAtMs: null, tz: 'Europe/Amsterdam', targetDate: '2026-07-06' });
    // Amsterdam is UTC+2 in July ⇒ local noon = 10:00Z.
    expect(timeStopMsOf(p, CFG)).toBe(Date.parse('2026-07-06T10:00:00Z'));
  });
});

// ── RESTART RESUME (ledger rows → resumed state) ────────────────────────────────────────────────────
describe('assemblePosition — restart resume from ledger rows', () => {
  const row = (over: Partial<OrderLedgerRow> = {}): OrderLedgerRow => ({
    mode: 'live',
    intentKey: 'm1|BUY|entry|2026-07-06',
    clientOrderId: 'c1',
    status: 'filled',
    orderId: 'v1',
    side: 'BUY',
    purpose: 'entry',
    price: 0.14,
    size: 66,
    sizeMatched: 66,
    tokenId: 't1',
    marketId: 'm1',
    createdAt: '2026-07-06T05:00:00Z',
    ...over,
  });
  const meta = { marketId: 'm1', tokenId: 't1', city: 'amsterdam', targetDate: '2026-07-06', tz: 'Europe/Amsterdam', modelProb: 0.3, resolvesAtMs: 1 };

  it('returns null with no entry row', () => {
    expect(assemblePosition({ meta, entry: null, tp: null, stopLoss: null, timeStop: null, mark: 0.2 })).toBeNull();
  });

  it('rebuilds a filled position + its resting TP from the ledger', () => {
    const pos = assemblePosition({ meta, entry: row(), tp: row({ side: 'SELL', purpose: 'take_profit', status: 'placed', clientOrderId: 'ctp', orderId: 'tp1', sizeMatched: 0, price: 0.27 }), stopLoss: null, timeStop: null, mark: 0.2 });
    expect(pos).not.toBeNull();
    expect(pos!.filledSize).toBe(66);
    expect(pos!.entryPrice).toBe(0.14);
    expect(pos!.entry!.status).toBe('filled');
    expect(pos!.tp!.clientOrderId).toBe('ctp');
    expect(pos!.mark).toBe(0.2);
  });

  it('exposes the stop-loss row as the single exit handle', () => {
    const pos = assemblePosition({ meta, entry: row(), tp: null, stopLoss: row({ side: 'SELL', purpose: 'stop_loss', status: 'partial', clientOrderId: 'csl', orderId: 'sl1', sizeMatched: 30 }), timeStop: null, mark: 0.05 });
    expect(pos!.exit!.purpose).toBe('stop_loss');
    expect(pos!.exit!.sizeMatched).toBe(30);
  });

  it('LOW-5: soldSize sums fills across TP + stop_loss + time_stop rows (each counted once)', () => {
    const pos = assemblePosition({
      meta,
      entry: row(),
      tp: row({ side: 'SELL', purpose: 'take_profit', status: 'partial', clientOrderId: 'ctp', orderId: 'tp1', sizeMatched: 20 }),
      stopLoss: row({ side: 'SELL', purpose: 'stop_loss', status: 'partial', clientOrderId: 'csl', orderId: 'sl1', sizeMatched: 30 }),
      timeStop: row({ side: 'SELL', purpose: 'time_stop', status: 'partial', clientOrderId: 'cts', orderId: 'ts1', sizeMatched: 16 }),
      mark: 0.05,
    });
    expect(pos!.soldSize).toBe(66); // 20 + 30 + 16 — fully covered, decide will plan nothing
  });

  it('CRIT-1: venue trade truth FLOORS soldSize — fills on canceled rows (invisible to by_intent) are never lost', () => {
    // The TP partial-filled 40 then was cancelled before a taker exit → its row is terminal-canceled and
    // findByIntentKey returns null; the SL row shows 26. The venue trade log still knows all 66.
    const pos = assemblePosition({
      meta,
      entry: row(),
      tp: null, // canceled → invisible
      stopLoss: row({ side: 'SELL', purpose: 'stop_loss', status: 'filled', clientOrderId: 'csl', orderId: 'sl1', sizeMatched: 26 }),
      timeStop: null,
      mark: 0.05,
      venueSoldSize: 66,
    });
    expect(pos!.soldSize).toBe(66); // NOT 26 — the venue floor closes the over-sell path
  });

  it('a venue read outage (venueSoldSize null) degrades to the visible-ledger sum', () => {
    const pos = assemblePosition({
      meta,
      entry: row(),
      tp: row({ side: 'SELL', purpose: 'take_profit', status: 'partial', clientOrderId: 'ctp', orderId: 'tp1', sizeMatched: 40 }),
      stopLoss: null,
      timeStop: null,
      mark: 0.2,
      venueSoldSize: null,
    });
    expect(pos!.soldSize).toBe(40);
  });

  it('NEW-LOW-1: the degraded flag propagates (and defaults false)', () => {
    const degraded = assemblePosition({ meta, entry: row(), tp: null, stopLoss: null, timeStop: null, mark: 0.2, venueSoldSize: null, soldTruthDegraded: true });
    expect(degraded!.soldTruthDegraded).toBe(true);
    const healthy = assemblePosition({ meta, entry: row(), tp: null, stopLoss: null, timeStop: null, mark: 0.2, venueSoldSize: 0 });
    expect(healthy!.soldTruthDegraded).toBe(false);
  });

  it('§11.2: entryPollFresh propagates and DEFAULTS TRUE (omitted ⇒ trustworthy; explicit false gates the kill-cancel)', () => {
    const dflt = assemblePosition({ meta, entry: row(), tp: null, stopLoss: null, timeStop: null, mark: 0.2 });
    expect(dflt!.entryPollFresh).toBe(true); // omitted ⇒ true (dry-run / non-kill paths never consult it)
    const stale = assemblePosition({ meta, entry: row(), tp: null, stopLoss: null, timeStop: null, mark: 0.2, entryPollFresh: false });
    expect(stale!.entryPollFresh).toBe(false);
  });
});

// ── DISCOVERY (reuses selectEntries — maxEntry/depth via the shared semantics) ──────────────────────
describe('discoverCandidates — reuses the replay twin selectEntries', () => {
  const bucket = (over: Record<string, unknown> = {}) => ({
    idx: 5,
    label: '20-21C',
    loF: 20,
    hiF: 21,
    mid: 0.14,
    bestAsk: 0.16,
    execAsk: 0.15,
    depthUsd: 300,
    bestBid: 0.12,
    sellbackUsd: 5,
    execBid: 0.12,
    sellbackDepthUsd: 200,
    houseProb: 0.3,
    tokenYes: 't1',
    tokenNo: 't2',
    conditionId: 'm1',
    ...over,
  });
  const raw = (buckets: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
    eventId: 'e1',
    capturedAt: '2026-07-06T05:59:00Z',
    city: 'amsterdam',
    targetDate: '2026-07-06',
    tzName: 'Europe/Amsterdam',
    createdAtGamma: '2026-07-06T05:30:00Z',
    resolvesAt: '2026-07-07T22:00:00Z',
    hoursSinceListing: 0.5,
    peakMid: 0.14,
    isFlatOpen: true,
    houseSeeded: true,
    buckets,
    evVol24h: 9000,
    negRisk: true,
    ...over,
  });
  const cfgFull = makerExitCfg(['amsterdam']);

  it('yields the forecast-center candidate for an enterable fresh market', () => {
    const cs = discoverCandidates([raw([bucket()]) as never], cfgFull, NOW);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ marketId: 'm1', tokenId: 't1', bucketIdx: 5, depthUsd: 300 });
    expect(cs[0]!.resolvesAtMs).toBe(Date.parse('2026-07-07T22:00:00Z'));
  });

  it('rejects a bucket above the max entry price (via selectEntries)', () => {
    const cs = discoverCandidates([raw([bucket({ houseProb: 0.5, execAsk: 0.35, bestAsk: 0.36 })]) as never], cfgFull, NOW);
    expect(cs).toHaveLength(0);
  });

  it('rejects a bucket below the depth floor (via selectEntries)', () => {
    const cs = discoverCandidates([raw([bucket({ depthUsd: 100 })]) as never], cfgFull, NOW);
    expect(cs).toHaveLength(0);
  });

  it('keeps only the LATEST tick per event', () => {
    const older = raw([bucket()], { capturedAt: '2026-07-06T05:00:00Z' });
    const newer = raw([bucket({ execAsk: 0.35, bestAsk: 0.36, houseProb: 0.5 })], { capturedAt: '2026-07-06T05:59:00Z' });
    // newer tick is un-enterable ⇒ 0 candidates (proves the newer tick, not the older, was used).
    expect(discoverCandidates([older as never, newer as never], cfgFull, NOW)).toHaveLength(0);
  });
});

// ── applyPlan — the driver (off/dry-run never post; record_*-raise routing) ────────────────────────

/**
 * A fake OrderLedger honoring the REAL 0082 `bot_order_by_intent` contract (lens MEDIUM-3's test
 * requirement): findByIntentKey returns the OPEN row — `status not in ('canceled','failed')` — or null;
 * recordCanceled flips the row terminal PRESERVING sizeMatched (the T3-confirmed seam semantics), which
 * frees the partial-unique so a fresh reserve/place for the same intent key can proceed.
 */
class FakeLedger implements OrderLedger {
  rows: OrderLedgerRow[] = [];
  canceledCids: string[] = [];
  private open(intentKey: string, mode: TradeMode): OrderLedgerRow | null {
    return this.rows.find((r) => r.intentKey === intentKey && r.mode === mode && r.status !== 'canceled' && r.status !== 'failed') ?? null;
  }
  async findByIntentKey(intentKey: string, mode: TradeMode): Promise<OrderLedgerRow | null> {
    return this.open(intentKey, mode);
  }
  async reserveIntent(input: ReserveIntentInput): Promise<'reserved' | 'exists'> {
    if (this.open(input.intentKey, input.mode)) return 'exists';
    this.rows.push({ mode: input.mode, intentKey: input.intentKey, clientOrderId: input.clientOrderId, status: 'intent', orderId: null, side: input.side, purpose: input.purpose, price: input.price, size: input.size, sizeMatched: 0, tokenId: input.tokenId, marketId: input.marketId, createdAt: new Date().toISOString() });
    return 'reserved';
  }
  async listDanglingIntents(): Promise<OrderLedgerRow[]> {
    return [];
  }
  async recordPlaced(clientOrderId: string, orderId: string): Promise<void> {
    const r = this.rows.find((x) => x.clientOrderId === clientOrderId);
    if (r) {
      r.status = 'placed';
      r.orderId = orderId;
    }
  }
  async recordFill(clientOrderId: string, sizeMatched: number, _avgPrice: number, status: 'filled' | 'partial'): Promise<void> {
    const r = this.rows.find((x) => x.clientOrderId === clientOrderId);
    if (r) {
      r.sizeMatched = sizeMatched;
      r.status = status;
    }
  }
  async recordCanceled(clientOrderId: string): Promise<void> {
    const r = this.rows.find((x) => x.clientOrderId === clientOrderId);
    if (r) r.status = 'canceled'; // sizeMatched PRESERVED — the seam contract
    this.canceledCids.push(clientOrderId);
  }
  async recordFailed(clientOrderId: string): Promise<void> {
    const r = this.rows.find((x) => x.clientOrderId === clientOrderId);
    if (r) r.status = 'failed';
  }
}

class FakeExecutor implements DaemonExecutor {
  readonly mode;
  calls: string[] = [];
  placeResult: OrderPlacementResult;
  placeThrows: Error | null = null;
  /** when false, cancel() reports the order was NOT (fully) canceled — the raced-a-fill venue response. */
  cancelSucceeds = true;
  /** the post-cancel cumulative matched cancel() reports (CancelResult.sizeMatched); null ⇒ omitted
   *  (the poll-unavailable case the driver must treat as an over-sell hazard → abort). */
  postCancelMatched: number | null = 0;
  /** when set, placeTaker honors the REAL executor's by_intent idempotency against this ledger. */
  ledger: FakeLedger | null = null;
  constructor(mode: DaemonExecutor['mode'], placeResult: OrderPlacementResult) {
    this.mode = mode;
    this.placeResult = placeResult;
  }
  async place(req: MakerOrderRequest): Promise<OrderPlacementResult> {
    this.calls.push(`place:${req.purpose}:${req.marketId}`);
    if (this.placeThrows) throw this.placeThrows;
    return { ...this.placeResult, side: req.side, purpose: req.purpose };
  }
  async placeTaker(req: TakerOrderRequest): Promise<OrderPlacementResult> {
    this.calls.push(`placeTaker:${req.purpose}:${req.marketId}`);
    if (this.ledger) {
      // mirror the real placeTaker's FIRST move (live.ts): an OPEN row for the intent key ⇒ 'duplicate'.
      const open = await this.ledger.findByIntentKey(orderIntentKey(req), this.mode);
      if (open) {
        return { ...this.placeResult, status: 'duplicate', side: req.side, purpose: req.purpose, reason: `open intent already ${open.status}` };
      }
      await this.ledger.reserveIntent({ mode: this.mode, intentKey: orderIntentKey(req), clientOrderId: `c-${this.calls.length}`, marketId: req.marketId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType: 'FAK', price: req.worstPrice, size: req.size, tradeDate: req.tradeDate });
    }
    return { ...this.placeResult, side: req.side, purpose: req.purpose };
  }
  async reprice(oldOrderId: string, _c: string, newReq: MakerOrderRequest): Promise<{ cancel: CancelResult; placed: OrderPlacementResult }> {
    this.calls.push(`reprice:${oldOrderId}`);
    return { cancel: { requested: [oldOrderId], canceled: [oldOrderId], notCanceled: {}, allCanceled: true }, placed: { ...this.placeResult, side: newReq.side, purpose: newReq.purpose } };
  }
  async cancel(orderId: string): Promise<CancelResult> {
    this.calls.push(`cancel:${orderId}`);
    if (!this.cancelSucceeds) {
      return { requested: [orderId], canceled: [], notCanceled: { [orderId]: 'order raced a fill' }, allCanceled: false };
    }
    return {
      requested: [orderId],
      canceled: [orderId],
      notCanceled: {},
      allCanceled: true,
      ...(this.postCancelMatched == null ? {} : { sizeMatched: this.postCancelMatched }),
    };
  }
}

const RESULT = (status: OrderPlacementResult['status']): OrderPlacementResult => ({
  mode: 'live',
  status,
  intentKey: 'k',
  clientOrderId: 'c',
  orderId: status === 'placed' ? 'v' : null,
  side: 'BUY',
  purpose: 'entry',
  orderType: 'GTC',
  postOnly: true,
  limitPrice: 0.14,
  size: 66,
  sizeMatched: 0,
});

const enterIntent: Intent = { kind: 'enter', marketRef: 'm1', req: { marketId: 'm1', tokenId: 't1', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-06', targetPrice: 0.14, size: 66, negRisk: true, orderType: 'GTC' } };
const noop = async () => {};
const log = () => {};

describe('applyPlan — the driver', () => {
  it('places an entry (live) and counts a real post', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    const r = await applyPlan({ intents: [enterIntent], skips: [] }, ex, async () => true, log);
    expect(ex.calls).toEqual(['place:entry:m1']);
    expect(r.posted).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('exit_taker cancels the resting TP BEFORE the taker sell', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    const exit: Intent = { kind: 'exit_taker', marketRef: 'm1', purpose: 'stop_loss', req: { marketId: 'm1', tokenId: 't1', side: 'SELL', purpose: 'stop_loss', tradeDate: '2026-07-06', worstPrice: 0.07, size: 66, negRisk: true }, cancelTp: { orderId: 'tp1', clientOrderId: 'ctp1', sizeMatched: 0 } };
    await applyPlan({ intents: [exit], skips: [] }, ex, async () => true, log);
    expect(ex.calls).toEqual(['cancel:tp1', 'placeTaker:stop_loss:m1']);
  });

  it('drives a reprice through executor.reprice', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    const rp: Intent = { kind: 'reprice_entry', marketRef: 'm1', oldOrderId: 'v1', oldClientOrderId: 'c1', req: enterIntent.req };
    await applyPlan({ intents: [rp], skips: [] }, ex, async () => true, log);
    expect(ex.calls).toEqual(['reprice:v1']);
  });

  it('DRY-RUN never posts (results are dry_run, not placed)', async () => {
    const ex = new FakeExecutor('dry-run', RESULT('dry_run'));
    const r = await applyPlan({ intents: [enterIntent], skips: [] }, ex, async () => true, log);
    expect(r.posted).toBe(0);
    expect(r.dryRun).toBe(1);
  });

  it('OFF plan is empty ⇒ the executor is never called', async () => {
    const ex = new FakeExecutor('off', RESULT('skipped_off'));
    const plan = decideTick(state({ mode: 'off', candidates: [cand()] }));
    await applyPlan(plan, ex, async () => true, log);
    expect(ex.calls).toEqual([]);
  });

  it('routes a record_*-raise (a thrown ExecutionError) to a CRITICAL alert and CONTINUES', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.placeThrows = new ExecutionError('ERR_LEDGER_WRITE', 'record_placed raised for row c1');
    const alerts: TradeAlert[] = [];
    const notify = async (a: TradeAlert) => {
      alerts.push(a);
      return true;
    };
    const second: Intent = { ...enterIntent, marketRef: 'm2', req: { ...enterIntent.req, marketId: 'm2' } };
    const r = await applyPlan({ intents: [enterIntent, second], skips: [] }, ex, notify, log);
    expect(r.failed).toBe(2); // both threw
    expect(alerts.every((a) => a.severity === 'CRITICAL')).toBe(true);
    expect(alerts).toHaveLength(2); // the loop CONTINUED to the second intent (never stalled)
    expect(ex.calls).toEqual(['place:entry:m1', 'place:entry:m2']);
  });

  it('never suppresses: a failed intent redacts the message in the alert', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.placeThrows = new ExecutionError('ERR_CLOB', 'POLY_API_KEY=abcdef123456 rejected');
    const alerts: TradeAlert[] = [];
    await applyPlan({ intents: [enterIntent], skips: [] }, ex, async (a) => (alerts.push(a), true), log);
    expect(alerts[0]!.body).not.toContain('abcdef123456');
    expect(alerts[0]!.body).toContain('REDACTED');
  });

  it('MEDIUM-2: drives cancel_entry through executor.cancel and counts it', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    const ce: Intent = { kind: 'cancel_entry', marketRef: 'm1', orderId: 'v1', clientOrderId: 'c1', reason: 'preflight_blocked' };
    const r = await applyPlan({ intents: [ce], skips: [] }, ex, async () => true, log);
    expect(ex.calls).toEqual(['cancel:v1']);
    expect(r.canceled).toBe(1);
    expect(r.failed).toBe(0);
  });
});

// ── RACE GUARD + FAK ADJUDICATION (lens MEDIUM-3) ───────────────────────────────────────────────────
describe('applyPlan — TP-cancel race guard + venue-dead FAK adjudication', () => {
  const exitIntent = (over: Partial<Extract<Intent, { kind: 'exit_taker' }>> = {}): Intent => ({
    kind: 'exit_taker',
    marketRef: 'm1',
    purpose: 'time_stop',
    req: { marketId: 'm1', tokenId: 't1', side: 'SELL', purpose: 'time_stop', tradeDate: '2026-07-06', worstPrice: 0.2, size: 26, negRisk: true },
    ...over,
  });

  it('ABORTS the taker when the TP cancel raced a fill (allCanceled=false) — no naked sell, WARN alerted', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.cancelSucceeds = false;
    const alerts: TradeAlert[] = [];
    const r = await applyPlan(
      { intents: [exitIntent({ cancelTp: { orderId: 'tp1', clientOrderId: 'ctp1', sizeMatched: 0 } })], skips: [] },
      ex,
      async (a) => (alerts.push(a), true),
      log,
    );
    expect(ex.calls).toEqual(['cancel:tp1']); // placeTaker NEVER invoked
    expect(r.aborted).toBe(1);
    expect(r.posted).toBe(0);
    expect(alerts.some((a) => a.kind === 'TRADE_BOT_EXIT_ABORTED' && a.severity === 'WARN')).toBe(true);
  });

  it('MEDIUM-3: a venue-dead FAK partial exit row is adjudicated terminal so the remainder RE-FIRES (never a silent duplicate)', async () => {
    const ledger = new FakeLedger();
    // the corpse: a prior time_stop FAK that partial-filled 40/66 — OPEN per the real by_intent contract.
    const key = orderIntentKey({ marketId: 'm1', side: 'SELL', purpose: 'time_stop', tradeDate: '2026-07-06' });
    ledger.rows.push({ mode: 'live', intentKey: key, clientOrderId: 'corpse1', status: 'partial', orderId: 'vdead1', side: 'SELL', purpose: 'time_stop', price: 0.2, size: 66, sizeMatched: 40, tokenId: 't1', marketId: 'm1', createdAt: '2026-07-06T05:00:00Z' });
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.ledger = ledger; // placeTaker honors the REAL idempotency: an open row ⇒ 'duplicate'
    const alerts: TradeAlert[] = [];

    // WITHOUT the ledger param the re-fire is duplicate-blocked (the false-green the lens flagged):
    const blocked = await applyPlan({ intents: [exitIntent()], skips: [] }, ex, async () => true, log);
    expect(blocked.duplicate).toBe(1);
    expect(blocked.posted).toBe(0);

    // WITH the ledger, the corpse is adjudicated (canceled, fills preserved) and the remainder posts:
    const r = await applyPlan({ intents: [exitIntent()], skips: [] }, ex, async (a) => (alerts.push(a), true), log, ledger);
    expect(ledger.canceledCids).toEqual(['corpse1']);
    const corpse = ledger.rows.find((x) => x.clientOrderId === 'corpse1')!;
    expect(corpse.status).toBe('canceled');
    expect(corpse.sizeMatched).toBe(40); // the seam preserves partial-fill accounting
    expect(r.posted).toBe(1); // the remainder RE-FIRED
    expect(r.duplicate).toBe(0);
    expect(alerts.some((a) => a.kind === 'TRADE_BOT_FAK_ADJUDICATED' && a.severity === 'WARN')).toBe(true); // never silent
  });

  it('MEDIUM-3: a 0-fill venue-dead FAK (still `placed`) is adjudicated the same way', async () => {
    const ledger = new FakeLedger();
    const key = orderIntentKey({ marketId: 'm1', side: 'SELL', purpose: 'time_stop', tradeDate: '2026-07-06' });
    ledger.rows.push({ mode: 'live', intentKey: key, clientOrderId: 'corpse2', status: 'placed', orderId: 'vdead2', side: 'SELL', purpose: 'time_stop', price: 0.2, size: 66, sizeMatched: 0, tokenId: 't1', marketId: 'm1', createdAt: '2026-07-06T05:00:00Z' });
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.ledger = ledger;
    const r = await applyPlan({ intents: [exitIntent()], skips: [] }, ex, async () => true, log, ledger);
    expect(ledger.canceledCids).toEqual(['corpse2']);
    expect(r.posted).toBe(1);
  });

  it('does NOT adjudicate a row still at `intent` (no orderId — the startup reconcile owns it)', async () => {
    const ledger = new FakeLedger();
    const key = orderIntentKey({ marketId: 'm1', side: 'SELL', purpose: 'time_stop', tradeDate: '2026-07-06' });
    ledger.rows.push({ mode: 'live', intentKey: key, clientOrderId: 'dangling1', status: 'intent', orderId: null, side: 'SELL', purpose: 'time_stop', price: 0.2, size: 66, sizeMatched: 0, tokenId: 't1', marketId: 'm1', createdAt: '2026-07-06T05:00:00Z' });
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.ledger = ledger;
    const r = await applyPlan({ intents: [exitIntent()], skips: [] }, ex, async () => true, log, ledger);
    expect(ledger.canceledCids).toEqual([]); // untouched — reconcile's job
    expect(r.duplicate).toBe(1); // duplicate-blocked this tick (safe: the key stays reserved)
    expect(r.posted).toBe(0);
  });
});

// ── TP-CANCEL RACE, allCanceled=true side — the taker is re-derived from the post-cancel poll ────────
describe('applyPlan — a PARTIAL TP fill raced into the poll→cancel window resizes the taker (never over-sell)', () => {
  const exitIntent = (size: number, tpMatchedAtDecide: number): Intent => ({
    kind: 'exit_taker',
    marketRef: 'm1',
    purpose: 'stop_loss',
    req: { marketId: 'm1', tokenId: 't1', side: 'SELL', purpose: 'stop_loss', tradeDate: '2026-07-06', worstPrice: 0.07, size, negRisk: true },
    cancelTp: { orderId: 'tp1', clientOrderId: 'ctp1', sizeMatched: tpMatchedAtDecide },
  });

  it('FALSIFIER (the race): decide sized 10 from a 0-matched TP; 4 filled during the cancel (allCanceled=true) → the FAK posts 6, not 10', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.postCancelMatched = 4; // the executor's post-cancel poll reports the raced fill
    const placedSizes: number[] = [];
    const origPlaceTaker = ex.placeTaker.bind(ex);
    ex.placeTaker = async (req) => {
      placedSizes.push(req.size);
      return origPlaceTaker(req);
    };
    const r = await applyPlan({ intents: [exitIntent(10, 0)], skips: [] }, ex, async () => true, log, undefined, 5);
    expect(placedSizes).toEqual([6]);
    expect(r.posted).toBe(1);
    expect(r.aborted).toBe(0);
  });

  it('the raced delta is measured against the DECIDE-TIME TP matched, not zero (TP already 40-matched at decide; 45 post-cancel → shrink by 5)', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.postCancelMatched = 45;
    const placedSizes: number[] = [];
    const orig = ex.placeTaker.bind(ex);
    ex.placeTaker = async (req) => (placedSizes.push(req.size), orig(req));
    await applyPlan({ intents: [exitIntent(26, 40)], skips: [] }, ex, async () => true, log, undefined, 5);
    expect(placedSizes).toEqual([21]);
  });

  it('no raced fill (post-cancel matched == decide-time matched) → the FAK posts the original size', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.postCancelMatched = 40;
    const placedSizes: number[] = [];
    const orig = ex.placeTaker.bind(ex);
    ex.placeTaker = async (req) => (placedSizes.push(req.size), orig(req));
    await applyPlan({ intents: [exitIntent(26, 40)], skips: [] }, ex, async () => true, log, undefined, 5);
    expect(placedSizes).toEqual([26]);
  });

  it('the raced fill covers the WHOLE exit → nothing posted (no over-sell, no venue rejection)', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.postCancelMatched = 10; // decide sized 10 from a 0-matched TP; all 10 raced
    const r = await applyPlan({ intents: [exitIntent(10, 0)], skips: [] }, ex, async () => true, log, undefined, 5);
    expect(ex.calls).toEqual(['cancel:tp1']); // placeTaker never invoked
    expect(r.posted).toBe(0);
    expect(r.failed).toBe(0);
  });

  it('a resized remainder below the venue min dust-parks with ONE WARN — never a CRITICAL livelock', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.postCancelMatched = 7; // 10 − 7 = 3 < min 5
    const alerts: TradeAlert[] = [];
    const r = await applyPlan({ intents: [exitIntent(10, 0)], skips: [] }, ex, async (a) => (alerts.push(a), true), log, undefined, 5);
    expect(ex.calls).toEqual(['cancel:tp1']);
    expect(r.posted).toBe(0);
    expect(r.failed).toBe(0);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'TRADE_BOT_DUST_PARKED', severity: 'WARN' })]);
  });

  it('post-cancel fill state UNKNOWN (no sizeMatched on the cancel result) → the taker ABORTS this tick (over-sell guard), WARN alerted', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    ex.postCancelMatched = null;
    const alerts: TradeAlert[] = [];
    const r = await applyPlan({ intents: [exitIntent(10, 0)], skips: [] }, ex, async (a) => (alerts.push(a), true), log, undefined, 5);
    expect(ex.calls).toEqual(['cancel:tp1']);
    expect(r.aborted).toBe(1);
    expect(r.posted).toBe(0);
    expect(alerts.some((a) => a.kind === 'TRADE_BOT_EXIT_ABORTED' && a.severity === 'WARN')).toBe(true);
  });

  it('an exit WITHOUT a resting TP (no cancelTp) posts unchanged — no cancel, no re-derive', async () => {
    const ex = new FakeExecutor('live', RESULT('placed'));
    const bare: Intent = { kind: 'exit_taker', marketRef: 'm1', purpose: 'time_stop', req: { marketId: 'm1', tokenId: 't1', side: 'SELL', purpose: 'time_stop', tradeDate: '2026-07-06', worstPrice: 0.2, size: 26, negRisk: true } };
    const r = await applyPlan({ intents: [bare], skips: [] }, ex, async () => true, log, undefined, 5);
    expect(ex.calls).toEqual(['placeTaker:time_stop:m1']);
    expect(r.posted).toBe(1);
  });
});

// ── DUST PARK — a sub-min unsold remainder plans nothing (no ERR_MIN_SIZE CRITICAL livelock) ─────────
describe('decideTick — dust park (unsold remainder below the venue min-order floor)', () => {
  const dustPos = (over: Partial<LivePosition> = {}) =>
    // held 66, sold 63 → remaining 3 < min 5; time-stop clock already tripped (resolvesAt = now + 1h).
    position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.01, filledSize: 66, soldSize: 63, ...over });

  it('FALSIFIER (the livelock): a 3-share remainder past the time-stop on a crashed mark plans NO exit and NO TP — only a dust skip', () => {
    const plan = decideTick(state({ positions: [dustPos()] }));
    expect(plan.intents).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.startsWith('dust_below_min_order'))).toBe(true);
  });

  it('a remainder AT/ABOVE the floor still exits normally (5 sh = min 5)', () => {
    const plan = decideTick(state({ positions: [dustPos({ soldSize: 61 })] })); // remaining 5
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex).toBeDefined();
    expect(ex.req.size).toBe(5);
    expect(plan.skips.some((s) => s.reason.startsWith('dust_below_min_order'))).toBe(false);
  });

  it('degraded sold-truth outranks dust (its CRITICAL hold owns the tick; dust is not classified from an untrusted soldSize)', () => {
    const plan = decideTick(state({ positions: [dustPos({ soldTruthDegraded: true })] }));
    expect(plan.intents).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.startsWith('sell_hold_degraded'))).toBe(true);
    expect(plan.skips.some((s) => s.reason.startsWith('dust_below_min_order'))).toBe(false);
  });

  it('dustRemainder: null when flattened / sellable / degraded; the remainder when parked', () => {
    expect(dustRemainder(dustPos(), CFG)).toBeCloseTo(3, 9);
    expect(dustRemainder(dustPos({ soldSize: 66 }), CFG)).toBeNull(); // flattened
    expect(dustRemainder(dustPos({ soldSize: 40 }), CFG)).toBeNull(); // 26 ≥ 5 — sellable
    expect(dustRemainder(dustPos({ soldTruthDegraded: true }), CFG)).toBeNull();
  });

  it('dustParkAlerts: ONE WARN per dust position (the daemon dedupes it to once per process)', () => {
    const alerts = dustParkAlerts([dustPos(), dustPos({ marketId: 'm2', soldSize: 40 })], CFG);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'TRADE_BOT_DUST_PARKED', severity: 'WARN', dedupeKey: 'trade-bot-dust:m1|2026-07-06' });
    expect(alerts[0]!.body).toContain('below the venue min-order size');
  });
});

void noop;
