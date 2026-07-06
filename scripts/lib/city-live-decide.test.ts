/**
 * Tests for the CITY-LIVE taker lane (CITY-LIVE.md §3) — the PURE decision spine (`decideCityTick`), its
 * driver (`applyCityPlan`), the sim-mirroring placement pick, and the daemon's staged-dark degradation
 * (`runCityLane` / `readCityRunnerInputs`). NO network: every executor / db / RPC is a fixture. Mirrors the
 * maker-exit decide tests (scripts/lib/trade-bot-decide.test.ts). Covers the §3 contract:
 *   • in-hour gating (city-local, tz-aware) + once/day idempotency
 *   • the $5/day stake envelope + the ≤2-enabled-city cap (defensive re-checks)
 *   • dry-run vs live intent SHAPES (strategy='city-taker', FAK BUY, hold-to-resolution — no exits)
 *   • the live preflight interlock blocks EVERY city post; dry-run ignores it
 *   • pre-0085 STAGED-DARK degradation: absent RPCs / an un-tagged reserve → a logged skip, NEVER a throw
 */
import { describe, expect, it } from 'vitest';
import { orderIntentKey } from '../../packages/trading/src/index.ts';
import type {
  OrderPlacementResult,
  TakerOrderRequest,
  TradeAlert,
  TradeMode,
} from '../../packages/trading/src/index.ts';
import type { PlaceInputs } from '../../packages/core/src/index.ts';
import {
  applyCityPlan,
  assembleCityPlaceInput,
  CITY_MAX_ENABLED_CITIES,
  CITY_STAKE_CEILING_USD,
  CITY_STRATEGY,
  decideCityTick,
  isMissingObjectError,
  pickCityPlacement,
  type CityArm,
  type CityIntent,
  type CityLaneExecutor,
  type CityPlaceInput,
  type CityTickState,
} from './city-live-decide.ts';
import type { CityBucketIdentity, OpenEntryRow } from './trading-db.ts';
import { readCityRunnerInputs, runCityLane, type Daemon } from '../trade-bot.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
// 2026-07-06T06:00:00Z → 14:00 in Asia/Singapore (+8) and 11:00 in Asia/Karachi (+5): the two tz probes.
const NOW = new Date('2026-07-06T06:00:00Z');
const SG_HOUR = 14; // Asia/Singapore local hour at NOW
const KHI_HOUR = 11; // Asia/Karachi local hour at NOW

function arm(over: Partial<CityArm> = {}): CityArm {
  return {
    cityId: 'c-sg',
    slug: 'singapore',
    icao: 'WSSS',
    tz: 'Asia/Singapore',
    unit: 'C',
    enabled: true,
    stakeUsd: 5,
    entryHour: SG_HOUR,
    ...over,
  };
}

function pin(over: Partial<CityPlaceInput> = {}): CityPlaceInput {
  return {
    cityId: 'c-sg',
    marketId: 'mkt-sg',
    tokenId: 'tok-sg',
    targetDate: '2026-07-06',
    bucketIdx: 7,
    label: '31-32C',
    ask: 0.2,
    feeRate: 0.05,
    ...over,
  };
}

function cstate(over: Partial<CityTickState> = {}): CityTickState {
  return {
    now: NOW,
    mode: 'live',
    arms: [arm()],
    placeInputs: [pin()],
    openIntentKeys: new Set(),
    preflightOk: true,
    minOrderSizeShares: 5,
    ...over,
  };
}

const enters = (p: CityIntent[] | { intents: CityIntent[] }): CityIntent[] =>
  (Array.isArray(p) ? p : p.intents).filter((i) => i.kind === 'city_enter');

// ── ENTRY (happy path) + intent shape ───────────────────────────────────────────────────────────────
describe('decideCityTick — a clean in-hour arm enters as a faithful taker', () => {
  it('emits ONE city_enter with the taker BUY shape (strategy=city-taker, worstPrice=ask, size=stake/ask)', () => {
    const plan = decideCityTick(cstate());
    const e = enters(plan);
    expect(e).toHaveLength(1);
    expect(e[0]!.cityId).toBe('c-sg');
    expect(e[0]!.marketRef).toBe('mkt-sg');
    expect(e[0]!.req).toMatchObject({
      marketId: 'mkt-sg',
      tokenId: 'tok-sg',
      side: 'BUY',
      purpose: 'entry',
      tradeDate: '2026-07-06',
      worstPrice: 0.2,
      negRisk: true,
      strategy: CITY_STRATEGY,
      feeRateBps: 500, // 0.05 × 10 000 — the entry taker fee is booked
    });
    expect(e[0]!.req.size).toBeCloseTo(5 / 0.2, 6); // 25 shares
  });

  it('there is NO exit intent — the lane holds to resolution (only city_enter exists)', () => {
    const plan = decideCityTick(cstate());
    expect(plan.intents.every((i) => i.kind === 'city_enter')).toBe(true);
  });

  it('omits feeRateBps when the market fee rate is unknown', () => {
    const plan = decideCityTick(cstate({ placeInputs: [pin({ feeRate: null })] }));
    expect(enters(plan)[0]!.req.feeRateBps).toBeUndefined();
  });
});

// ── IN-HOUR GATING (tz-aware) ─────────────────────────────────────────────────────────────────────
describe('decideCityTick — in-hour gating is city-local (tz-aware)', () => {
  it('skips off-hour (local hour ≠ the arm hour)', () => {
    const plan = decideCityTick(cstate({ arms: [arm({ entryHour: 13 })] })); // local is 14, not 13
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('off_hour'))).toBe(true);
  });

  it('the SAME UTC instant enters Karachi at 11 local but not at 14 local (tz-awareness)', () => {
    const khiArm = (h: number): CityArm => arm({ cityId: 'c-khi', slug: 'karachi', icao: 'OPKC', tz: 'Asia/Karachi', entryHour: h });
    const khiPin = pin({ cityId: 'c-khi', marketId: 'mkt-khi', tokenId: 'tok-khi' });
    const inHour = decideCityTick(cstate({ arms: [khiArm(KHI_HOUR)], placeInputs: [khiPin] }));
    expect(enters(inHour)).toHaveLength(1);
    const offHour = decideCityTick(cstate({ arms: [khiArm(SG_HOUR)], placeInputs: [khiPin] }));
    expect(enters(offHour)).toHaveLength(0);
  });

  it('fails closed on a non-DST-aware tz (Etc/*) — never placed', () => {
    const plan = decideCityTick(cstate({ arms: [arm({ tz: 'Etc/GMT-8' })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('bad_tz'))).toBe(true);
  });

  it('fails closed on a junk tz (never throws)', () => {
    const plan = decideCityTick(cstate({ arms: [arm({ tz: 'Not/AZone' })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('bad_tz'))).toBe(true);
  });
});

// ── ONCE / DAY ──────────────────────────────────────────────────────────────────────────────────────
describe('decideCityTick — once per city/day', () => {
  it('skips when the entry intent key is already open (the ledger pre-check)', () => {
    const key = orderIntentKey({ marketId: 'mkt-sg', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-06' });
    const plan = decideCityTick(cstate({ openIntentKeys: new Set([key]) }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('already_placed_today'))).toBe(true);
  });

  it('a DIFFERENT day/market key does not block today', () => {
    const key = orderIntentKey({ marketId: 'mkt-sg', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-05' });
    const plan = decideCityTick(cstate({ openIntentKeys: new Set([key]) }));
    expect(enters(plan)).toHaveLength(1);
  });
});

// ── STAKE ENVELOPE + CITY-COUNT CAP ───────────────────────────────────────────────────────────────
describe('decideCityTick — the $5/day + ≤2-city caps (defensive re-checks)', () => {
  it('skips a stake over the $5/day envelope', () => {
    const plan = decideCityTick(cstate({ arms: [arm({ stakeUsd: CITY_STAKE_CEILING_USD + 0.01 })] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('stake_over_envelope'))).toBe(true);
  });

  it(`acts on at most ${CITY_MAX_ENABLED_CITIES} enabled cities (deterministic by slug), skipping the rest`, () => {
    // three in-hour enabled cities (all Asia/Singapore tz so all are in-hour at NOW).
    const mk = (id: string, slug: string): CityArm => arm({ cityId: id, slug });
    const mkPin = (id: string): CityPlaceInput => pin({ cityId: id, marketId: `mkt-${id}` });
    const arms = [mk('c-c', 'charlie'), mk('c-a', 'alpha'), mk('c-b', 'bravo')];
    const placeInputs = [mkPin('c-a'), mkPin('c-b'), mkPin('c-c')];
    const plan = decideCityTick(cstate({ arms, placeInputs }));
    const e = enters(plan);
    expect(e).toHaveLength(CITY_MAX_ENABLED_CITIES);
    // alpha + bravo act (slug asc); charlie is capped out.
    expect(e.map((i) => i.cityId).sort()).toEqual(['c-a', 'c-b']);
    expect(plan.skips.some((s) => s.ref === 'c-c' && s.reason.includes('city_count_cap'))).toBe(true);
  });

  it('below_min_size when stake/ask is under the venue floor', () => {
    // stake 5 @ ask 0.2 = 25 shares; a floor of 30 rejects it.
    const plan = decideCityTick(cstate({ minOrderSizeShares: 30 }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('below_min_size'))).toBe(true);
  });

  it('an unusable ask (≤0 or >1) is skipped', () => {
    expect(enters(decideCityTick(cstate({ placeInputs: [pin({ ask: 0 })] })))).toHaveLength(0);
    expect(enters(decideCityTick(cstate({ placeInputs: [pin({ ask: 1.2 })] })))).toHaveLength(0);
  });

  it('no place input for an in-hour arm → no_place_input skip', () => {
    const plan = decideCityTick(cstate({ placeInputs: [] }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('no_place_input'))).toBe(true);
  });

  it('ignores a disabled arm entirely', () => {
    const plan = decideCityTick(cstate({ arms: [arm({ enabled: false })] }));
    expect(enters(plan)).toHaveLength(0);
  });
});

// ── PREFLIGHT (live) vs DRY-RUN ─────────────────────────────────────────────────────────────────────
describe('decideCityTick — the live interlock blocks posts; dry-run ignores it', () => {
  it('LIVE + preflightOk=false blocks EVERY city post', () => {
    const plan = decideCityTick(cstate({ preflightOk: false }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('preflight_blocked'))).toBe(true);
  });

  it('LIVE + preflightOk=null (unread / pre-0085) also blocks', () => {
    const plan = decideCityTick(cstate({ preflightOk: null }));
    expect(enters(plan)).toHaveLength(0);
    expect(plan.skips.some((s) => s.reason.includes('preflight_blocked'))).toBe(true);
  });

  it('DRY-RUN enters WITHOUT any preflight (preflightOk=null), identical intent shape', () => {
    const plan = decideCityTick(cstate({ mode: 'dry-run', preflightOk: null }));
    const e = enters(plan);
    expect(e).toHaveLength(1);
    expect(e[0]!.req.strategy).toBe(CITY_STRATEGY);
    expect(e[0]!.req.side).toBe('BUY');
  });

  it('off mode → no intents, a single mode_off skip', () => {
    const plan = decideCityTick(cstate({ mode: 'off' }));
    expect(plan.intents).toHaveLength(0);
    expect(plan.skips).toEqual([{ ref: 'ALL', reason: expect.stringContaining('mode_off') }]);
  });
});

// ── pickCityPlacement + assembleCityPlaceInput (the sim-mirroring derivation) ───────────────────────
describe('pickCityPlacement / assembleCityPlaceInput — mirrors the sim placement', () => {
  const place: PlaceInputs = {
    targetDate: '2026-07-06',
    eventId: 'ev1',
    feeRate: 0.05,
    ladder: [{ bucketIdx: 0, low: null, high: 21 }, { bucketIdx: 1, low: 22, high: 23 }, { bucketIdx: 2, low: 24, high: null }],
    arms: [],
  };
  // a stub planPlacements — returns a row for hour 14 only.
  const planStub = (_: PlaceInputs, __: { stakeUsd?: number }) => [
    { armHour: 14, bucketIdx: 1, label: '22-23C', ask: 0.2 },
    { armHour: 13, bucketIdx: 0, label: null, ask: 0.5 },
  ];

  it('picks the entry-hour arm row + carries fee/target', () => {
    const pick = pickCityPlacement(arm({ entryHour: 14 }), place, planStub);
    expect(pick).toEqual({ bucketIdx: 1, label: '22-23C', ask: 0.2, targetDate: '2026-07-06', feeRate: 0.05 });
  });

  it('returns null when the entry hour is not among the planned arms', () => {
    expect(pickCityPlacement(arm({ entryHour: 9 }), place, planStub)).toBeNull();
  });

  it('returns null for an unusable ask', () => {
    const bad = (_: PlaceInputs, __: { stakeUsd?: number }) => [{ armHour: 14, bucketIdx: 1, label: null, ask: 0 }];
    expect(pickCityPlacement(arm({ entryHour: 14 }), place, bad)).toBeNull();
  });

  it('assembleCityPlaceInput builds the CityPlaceInput from a pick + identity', () => {
    const pick = pickCityPlacement(arm({ entryHour: 14 }), place, planStub)!;
    const out = assembleCityPlaceInput('c-sg', pick, { marketId: 'm', tokenId: 't' });
    expect(out).toMatchObject({ cityId: 'c-sg', marketId: 'm', tokenId: 't', bucketIdx: 1, ask: 0.2, feeRate: 0.05 });
  });

  it('assembleCityPlaceInput returns null on a missing/empty identity', () => {
    const pick = pickCityPlacement(arm({ entryHour: 14 }), place, planStub)!;
    expect(assembleCityPlaceInput('c-sg', pick, null)).toBeNull();
    expect(assembleCityPlaceInput('c-sg', pick, { marketId: '', tokenId: 't' })).toBeNull();
  });
});

// ── isMissingObjectError (the staged-dark classifier) ──────────────────────────────────────────────
describe('isMissingObjectError', () => {
  it('matches undefined-function/column codes + prose', () => {
    expect(isMissingObjectError('42883')).toBe(true);
    expect(isMissingObjectError('42703')).toBe(true);
    expect(isMissingObjectError('PGRST202')).toBe(true);
    expect(isMissingObjectError('function public.city_live_runner_inputs() does not exist')).toBe(true);
    expect(isMissingObjectError('Could not find the function public.trade_live_preflight in the schema cache')).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isMissingObjectError('upstream request timeout')).toBe(false);
    expect(isMissingObjectError('ERR_MIN_SIZE')).toBe(false);
  });
});

// ── applyCityPlan — the driver ─────────────────────────────────────────────────────────────────────
class FakeCityExecutor implements CityLaneExecutor {
  readonly mode: TradeMode;
  calls: TakerOrderRequest[] = [];
  result: OrderPlacementResult;
  throwErr: Error | null = null;
  constructor(mode: TradeMode, result: OrderPlacementResult) {
    this.mode = mode;
    this.result = result;
  }
  async placeTaker(req: TakerOrderRequest): Promise<OrderPlacementResult> {
    this.calls.push(req);
    if (this.throwErr) throw this.throwErr;
    return { ...this.result, side: req.side, purpose: req.purpose };
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
  orderType: 'FAK',
  postOnly: false,
  limitPrice: 0.2,
  size: 25,
  sizeMatched: 0,
});

const cityPlan = (): { intents: CityIntent[]; skips: [] } => ({
  intents: [{ kind: 'city_enter', marketRef: 'mkt-sg', cityId: 'c-sg', req: { marketId: 'mkt-sg', tokenId: 'tok-sg', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-06', worstPrice: 0.2, size: 25, negRisk: true, strategy: CITY_STRATEGY } }],
  skips: [],
});
const noLog = () => {};

describe('applyCityPlan — the driver', () => {
  it('posts a city entry (live) via placeTaker and counts a real post', async () => {
    const ex = new FakeCityExecutor('live', RESULT('placed'));
    const r = await applyCityPlan(cityPlan(), ex, async () => true, noLog);
    expect(ex.calls).toHaveLength(1);
    expect(ex.calls[0]!.strategy).toBe(CITY_STRATEGY);
    expect(r.posted).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.stagedDark).toBe(0);
  });

  it('a dry_run result counts dryRun, not posted', async () => {
    const ex = new FakeCityExecutor('dry-run', RESULT('dry_run'));
    const r = await applyCityPlan(cityPlan(), ex, async () => true, noLog);
    expect(r.dryRun).toBe(1);
    expect(r.posted).toBe(0);
  });

  it('a duplicate result counts duplicate (once/day idempotency at the ledger)', async () => {
    const ex = new FakeCityExecutor('live', RESULT('duplicate'));
    const r = await applyCityPlan(cityPlan(), ex, async () => true, noLog);
    expect(r.duplicate).toBe(1);
  });

  it('STAGED-DARK: an undefined-function/column throw is tolerated (skip, no throw, NO CRITICAL alert)', async () => {
    const ex = new FakeCityExecutor('live', RESULT('placed'));
    ex.throwErr = new Error('function public.bot_order_reserve_intent(...) does not exist');
    const alerts: TradeAlert[] = [];
    const r = await applyCityPlan(cityPlan(), ex, async (a) => (alerts.push(a), true), noLog);
    expect(r.stagedDark).toBe(1);
    expect(r.failed).toBe(0);
    expect(alerts).toHaveLength(0); // staged-dark never pages
  });

  it('a GENUINE failure counts failed + fires a CRITICAL alert, and the loop continues', async () => {
    const ex = new FakeCityExecutor('live', RESULT('placed'));
    ex.throwErr = new Error('CLOB 503 upstream');
    const alerts: TradeAlert[] = [];
    const r = await applyCityPlan(cityPlan(), ex, async (a) => (alerts.push(a), true), noLog);
    expect(r.failed).toBe(1);
    expect(alerts.some((a) => a.severity === 'CRITICAL' && a.kind === 'CITY_LANE_INTENT_FAILED')).toBe(true);
  });
});

// ── runCityLane (daemon) — staged-dark degradation + a happy dry-run/live path ─────────────────────
type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<unknown[]>;

function cityDaemon(opts: {
  mode?: TradeMode;
  rpc: RpcFn;
  openEntries?: OpenEntryRow[];
  bucketIdentity?: (eventId: string, bucketIdx: number) => Promise<CityBucketIdentity | null>;
  placeResult?: OrderPlacementResult;
}): { d: Daemon; alerts: TradeAlert[]; placed: TakerOrderRequest[] } {
  const alerts: TradeAlert[] = [];
  const placed: TakerOrderRequest[] = [];
  const notify = async (a: TradeAlert): Promise<boolean> => (alerts.push(a), true);
  const mode = opts.mode ?? 'dry-run';
  const executor = {
    mode,
    placeTaker: async (req: TakerOrderRequest): Promise<OrderPlacementResult> => {
      placed.push(req);
      return { ...(opts.placeResult ?? RESULT('dry_run')), side: req.side, purpose: req.purpose };
    },
  };
  const db = {
    rpc: opts.rpc,
    getConfigRows: async () => [],
    listOpenEntryRows: async () => opts.openEntries ?? [],
    cityBucketIdentity: opts.bucketIdentity ?? (async () => ({ marketId: 'mkt-sg', tokenId: 'tok-sg' })),
  };
  const d = { mode, db, ledger: {}, executor, client: {}, notify, address: null, warnedDust: new Set() } as unknown as Daemon;
  return { d, alerts, placed };
}

const runnerEnvelope = (rows: unknown[]) => [{ city_live_runner_inputs: { rows } }];
const runnerRow = (over: Record<string, unknown> = {}) => ({
  cityId: 'c-sg',
  slug: 'singapore',
  icao: 'WSSS',
  tz: 'Asia/Singapore',
  unit: 'C',
  enabled: true,
  stakeUsd: 5,
  entryHour: SG_HOUR,
  ...over,
});
const placePayload = (over: Partial<PlaceInputs> = {}) => ({
  city_sim_place_inputs: {
    targetDate: '2026-07-06',
    eventId: 'ev1',
    feeRate: 0.05,
    ladder: [{ bucketIdx: 0, low: null, high: 21 }, { bucketIdx: 1, low: 22, high: 23 }, { bucketIdx: 2, low: 24, high: null }],
    labels: { 1: '22-23C' },
    forecastC: null,
    forecastMaxHour: 12,
    arms: [{ hour: SG_HOUR, runMaxC: 22.4, asks: [{ bucketIdx: 1, ask: 0.2 }] }],
    ...over,
  },
});

describe('readCityRunnerInputs — staged-dark + shape tolerance', () => {
  it("returns 'absent' when the RPC is undefined (pre-0085)", async () => {
    const { d } = cityDaemon({ rpc: async () => { throw new Error('function public.city_live_runner_inputs() does not exist'); } });
    expect(await readCityRunnerInputs(d)).toBe('absent');
  });

  it('returns [] on a shapeless/NULL envelope (config table empty)', async () => {
    const { d } = cityDaemon({ rpc: async () => [{ city_live_runner_inputs: null }] });
    expect(await readCityRunnerInputs(d)).toEqual([]);
  });

  it('maps the {rows:[…]} envelope to CityArm[]', async () => {
    const { d } = cityDaemon({ rpc: async () => runnerEnvelope([runnerRow()]) });
    const arms = await readCityRunnerInputs(d);
    expect(arms).not.toBe('absent');
    expect((arms as CityArm[])[0]).toMatchObject({ cityId: 'c-sg', slug: 'singapore', enabled: true, stakeUsd: 5, entryHour: SG_HOUR });
  });
});

describe('runCityLane — pre-0085 degradation (missing RPCs → skip, never throw)', () => {
  it('city_live_runner_inputs absent → no throw, no placeTaker', async () => {
    const { d, placed } = cityDaemon({ rpc: async (fn) => { if (fn === 'city_live_runner_inputs') throw new Error('42883 does not exist'); return []; } });
    await expect(runCityLane(d, 5, NOW)).resolves.toBeUndefined();
    expect(placed).toHaveLength(0);
  });

  it('city_sim_place_inputs absent → no throw, no placeTaker', async () => {
    const rpc: RpcFn = async (fn) => {
      if (fn === 'city_live_runner_inputs') return runnerEnvelope([runnerRow()]);
      if (fn === 'city_sim_place_inputs') throw new Error('function public.city_sim_place_inputs(...) does not exist');
      return [];
    };
    const { d, placed } = cityDaemon({ rpc });
    await expect(runCityLane(d, 5, NOW)).resolves.toBeUndefined();
    expect(placed).toHaveLength(0);
  });

  it('LIVE: an absent city-taker preflight holds all posts (no throw, no placeTaker)', async () => {
    const rpc: RpcFn = async (fn) => {
      if (fn === 'city_live_runner_inputs') return runnerEnvelope([runnerRow()]);
      if (fn === 'city_sim_place_inputs') return [placePayload()];
      if (fn === 'trade_live_preflight') throw new Error("function public.trade_live_preflight(p_strategy => text) does not exist");
      return [];
    };
    const { d, placed } = cityDaemon({ mode: 'live', rpc });
    await runCityLane(d, 5, NOW);
    expect(placed).toHaveLength(0);
  });
});

describe('runCityLane — happy path (reconstructs the sim placement, posts a taker)', () => {
  const baseRpc = (over: { preflightOk?: boolean } = {}): RpcFn => async (fn) => {
    if (fn === 'city_live_runner_inputs') return runnerEnvelope([runnerRow()]);
    if (fn === 'city_sim_place_inputs') return [placePayload()];
    if (fn === 'trade_live_preflight') return [{ trade_live_preflight: { ok: over.preflightOk ?? true } }];
    return [];
  };

  it('DRY-RUN posts a taker BUY on the sim-locked bucket, strategy=city-taker', async () => {
    const { d, placed } = cityDaemon({ mode: 'dry-run', rpc: baseRpc(), placeResult: RESULT('dry_run') });
    await runCityLane(d, 5, NOW);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ marketId: 'mkt-sg', tokenId: 'tok-sg', side: 'BUY', purpose: 'entry', worstPrice: 0.2, strategy: CITY_STRATEGY });
    expect(placed[0]!.size).toBeCloseTo(25, 6);
  });

  it('LIVE + preflight PASS posts for real', async () => {
    const { d, placed } = cityDaemon({ mode: 'live', rpc: baseRpc({ preflightOk: true }), placeResult: RESULT('placed') });
    await runCityLane(d, 5, NOW);
    expect(placed).toHaveLength(1);
  });

  it('LIVE + preflight FAIL posts nothing', async () => {
    const { d, placed } = cityDaemon({ mode: 'live', rpc: baseRpc({ preflightOk: false }), placeResult: RESULT('placed') });
    await runCityLane(d, 5, NOW);
    expect(placed).toHaveLength(0);
  });

  it('once/day: an existing open entry key suppresses the post', async () => {
    const openEntries: OpenEntryRow[] = [{ marketId: 'mkt-sg', tokenId: 'tok-sg', tradeDate: '2026-07-06' }];
    const { d, placed } = cityDaemon({ mode: 'dry-run', rpc: baseRpc(), openEntries, placeResult: RESULT('dry_run') });
    await runCityLane(d, 5, NOW);
    expect(placed).toHaveLength(0);
  });
});
