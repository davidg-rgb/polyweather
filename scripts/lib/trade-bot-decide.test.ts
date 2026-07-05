/**
 * Tests for the live maker-exit daemon's PURE decision spine (tick → intents) + its driver. NO network:
 * every executor / ledger / preflight / book is a fixture. Covers the T2 test contract — entry gating
 * (maxEntry / depth / allowlist / caps / preflight-block), TP/SL/time-stop arming + firing, the reprice
 * window, restart resume (ledger rows → resumed state), off/dry-run never posting, and record_*-raise
 * routing.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionError } from '../../packages/core/src/index.ts';
import { makerExitCfg } from '../../packages/core/src/index.ts';
import type {
  CancelResult,
  MakerOrderRequest,
  OrderLedgerRow,
  OrderPlacementResult,
  TakerOrderRequest,
  TradeAlert,
  TradeConfig,
  TradePreflight,
} from '../../packages/trading/src/index.ts';
import {
  applyPlan,
  assemblePosition,
  decideTick,
  discoverCandidates,
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
    expect(sl.cancelTp).toEqual({ orderId: 'tp1', clientOrderId: 'ctp1' });
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
    expect(ex.cancelTp).toEqual({ orderId: 'tp1', clientOrderId: 'ctp1' });
  });

  it('the time-stop takes priority over the take-profit rest', () => {
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, tp: null });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents.some((i) => i.kind === 'exit_taker' && i.purpose === 'time_stop')).toBe(true);
    expect(plan.intents.some((i) => i.kind === 'rest_tp')).toBe(false);
  });

  it('re-fires only the UNSOLD remainder after a partial taker flatten', () => {
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, filledSize: 66, exit: handle({ purpose: 'time_stop', status: 'partial', sizeMatched: 40 }) });
    const plan = decideTick(state({ positions: [pos] }));
    const ex = plan.intents.find((i) => i.kind === 'exit_taker') as Extract<Intent, { kind: 'exit_taker' }>;
    expect(ex.req.size).toBe(26);
  });

  it('no intent once fully flattened', () => {
    const pos = position({ resolvesAtMs: NOW.getTime() + 3_600_000, mark: 0.25, filledSize: 66, exit: handle({ purpose: 'time_stop', status: 'filled', sizeMatched: 66 }) });
    const plan = decideTick(state({ positions: [pos] }));
    expect(plan.intents).toHaveLength(0);
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
class FakeExecutor implements DaemonExecutor {
  readonly mode;
  calls: string[] = [];
  placeResult: OrderPlacementResult;
  placeThrows: Error | null = null;
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
    return { ...this.placeResult, side: req.side, purpose: req.purpose };
  }
  async reprice(oldOrderId: string, _c: string, newReq: MakerOrderRequest): Promise<{ cancel: CancelResult; placed: OrderPlacementResult }> {
    this.calls.push(`reprice:${oldOrderId}`);
    return { cancel: { requested: [oldOrderId], canceled: [oldOrderId], notCanceled: {}, allCanceled: true }, placed: { ...this.placeResult, side: newReq.side, purpose: newReq.purpose } };
  }
  async cancel(orderId: string): Promise<CancelResult> {
    this.calls.push(`cancel:${orderId}`);
    return { requested: [orderId], canceled: [orderId], notCanceled: {}, allCanceled: true };
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
    const exit: Intent = { kind: 'exit_taker', marketRef: 'm1', purpose: 'stop_loss', req: { marketId: 'm1', tokenId: 't1', side: 'SELL', purpose: 'stop_loss', tradeDate: '2026-07-06', worstPrice: 0.07, size: 66, negRisk: true }, cancelTp: { orderId: 'tp1', clientOrderId: 'ctp1' } };
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
});

void noop;
