/**
 * buy-table-tick handler — unit tests over a scripted DbPort + a mock clob client (the execute-bet /
 * trade-bot test idiom; no PGlite — the SQL surface is covered by buy-table-live.test.ts). Pins the
 * directive's gates: the ≤15¢ price gate, the [2,12]h lead window, one-entry-per-market-EVER idempotency,
 * dry-run records-but-never-posts, live posts only behind trade_live_preflight('buy-table'), degraded
 * discovery places nothing (and alerts while live), and hold-to-close resolution-loss booking.
 */
import { describe, expect, it } from 'vitest';
import { parseConfigRows, type RawCaptureRow } from '../../packages/core/src/index.ts';
import { orderIntentKey, type MakerClobClientish, type TradeAlert } from '../../packages/trading/src/index.ts';
import type { DbPort } from '../functions/_shared/db.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import {
  buyTableTick,
  parseBuyTableConfig,
  selectBuyTableCandidates,
  resolvedAgainstEntries,
  type BuyTableEntryRow,
  type BuyTableTickDeps,
} from '../functions/buy-table-tick/handler.ts';

const NOW = new Date('2026-07-11T10:00:00Z');
const cfg = parseConfigRows([]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A capture row whose argmax-houseProb bucket (idx 1) quotes `ask`, resolving `hoursToClose` from NOW. */
function capture(over: {
  eventId: string;
  ask: number;
  hoursToClose: number;
  city?: string;
  targetDate?: string;
  execAsk?: number | null;
}): RawCaptureRow {
  const resolvesAt = new Date(NOW.getTime() + over.hoursToClose * 3_600_000).toISOString();
  const bucket = (idx: number, houseProb: number, ask: number | null) => ({
    idx,
    label: `${29 + idx}°C`,
    loF: null,
    hiF: null,
    mid: ask,
    bestAsk: ask,
    execAsk: over.execAsk === undefined ? ask : over.execAsk,
    depthUsd: 100,
    bestBid: ask == null ? null : Math.max(0.01, ask - 0.02),
    sellbackUsd: 50,
    execBid: ask == null ? null : Math.max(0.01, ask - 0.02),
    sellbackDepthUsd: 50,
    houseProb,
    tokenYes: `y-${over.eventId}-${idx}`,
    tokenNo: `n-${over.eventId}-${idx}`,
    conditionId: `c-${over.eventId}-${idx}`,
  });
  return {
    eventId: over.eventId,
    capturedAt: NOW.toISOString(),
    city: over.city ?? 'testville',
    targetDate: over.targetDate ?? '2026-07-11',
    tzName: 'Europe/Amsterdam',
    createdAtGamma: null,
    resolvesAt,
    hoursSinceListing: 0.5,
    peakMid: 0.12,
    isFlatOpen: true,
    houseSeeded: true,
    buckets: [bucket(0, 0.2, 0.05), bucket(1, 0.6, over.ask), bucket(2, 0.2, 0.05)],
    evVol24h: 5000,
    negRisk: true,
  };
}

interface MockDbState {
  mode: 'off' | 'dry-run' | 'live';
  captures?: RawCaptureRow[] | 'throw';
  resolutions?: Array<{ id: string; winnerIdx: number | null; gradingMismatch: boolean }>;
  entries?: BuyTableEntryRow[] | 'throw' | 'missing';
  preflightOk?: boolean | 'throw';
  configRows?: { key: string; value: string }[];
  /** 0111: buy_table_intraday_floor rows ({floors:[…]} envelope) — the dead-bucket gate's observed maxes. */
  floors?: Array<{ city: string; targetDate: string; maxTenthsC: number }> | 'throw';
  cityAllowlist?: string[] | null;
  /** F4: snake_case live_orders jsonb rows served by bot_order_list_dangling ({rows:[…]} envelope). */
  dangling?: Array<Record<string, unknown>> | 'throw';
}

function makeMockDb(state: MockDbState): DbPort & { calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  // F4 statefulness: a record_failed/record_canceled landing on a dangling row's client_order_id flips
  // the seeded entry rows sharing its intent_key to the terminal status — so the buy_table_entries read
  // AFTER the sweep sees post-adjudication state, exactly like the real ledger would.
  let entriesState = Array.isArray(state.entries) ? [...state.entries] : state.entries;
  const adjudicate = (clientOrderId: unknown, status: string): void => {
    if (!Array.isArray(state.dangling) || !Array.isArray(entriesState)) return;
    const hit = state.dangling.find((d) => d['client_order_id'] === clientOrderId);
    if (!hit) return;
    entriesState = entriesState.map((e) =>
      e.intentKey === hit['intent_key'] ? { ...e, status } : e,
    );
  };
  return {
    calls,
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      calls.push({ fn, args });
      switch (fn) {
        case 'trade_config_get':
          return [
            {
              trade_config_get: {
                config: {
                  mode: state.mode === 'live' ? 'live' : 'off',
                  stake_per_buy_usd: '5',
                  per_position_cap_usd: '25',
                  per_market_cap_usd: '40',
                  total_concurrent_cap_usd: '100',
                  daily_loss_kill_usd: '30',
                  daily_loss_kill_frac: '0.25',
                  city_allowlist: state.cityAllowlist === undefined ? ['testville'] : state.cityAllowlist,
                  active_until: '2026-07-30',
                },
              },
            },
          ] as unknown as T[];
        case 'buy_table_entries':
          if (entriesState === 'throw') throw new Error('rpc buy_table_entries failed: boom');
          if (entriesState === 'missing') {
            throw new Error('rpc buy_table_entries failed: function public.buy_table_entries(p_mode => text) does not exist');
          }
          return [{ buy_table_entries: { rows: entriesState ?? [] } }] as unknown as T[];
        case 'bot_order_list_dangling':
          if (state.dangling === 'throw') throw new Error('rpc bot_order_list_dangling failed: boom');
          return [{ bot_order_list_dangling: { rows: state.dangling ?? [] } }] as unknown as T[];
        case 'convergence_capture_inputs':
          if (state.captures === 'throw') throw new Error('rpc convergence_capture_inputs failed: timeout');
          return [
            { convergence_capture_inputs: { captures: state.captures ?? [], resolutions: state.resolutions ?? [] } },
          ] as unknown as T[];
        case 'buy_table_intraday_floor':
          if (state.floors === 'throw') throw new Error('rpc buy_table_intraday_floor failed: function does not exist');
          return [{ buy_table_intraday_floor: { floors: state.floors ?? [] } }] as unknown as T[];
        case 'trade_live_preflight':
          if (state.preflightOk === 'throw') throw new Error('rpc trade_live_preflight failed: boom');
          return [{ trade_live_preflight: { ok: state.preflightOk === true, reasons: [] } }] as unknown as T[];
        case 'bot_order_by_intent':
          return [{ bot_order_by_intent: null }] as unknown as T[];
        case 'bot_order_reserve_intent':
          return [{ bot_order_reserve_intent: 'reserved' }] as unknown as T[];
        case 'bot_order_record_placed':
        case 'bot_order_record_fill':
          return [] as unknown as T[];
        case 'bot_order_record_failed':
          adjudicate(args['p_client_order_id'], 'failed');
          return [] as unknown as T[];
        case 'bot_order_record_canceled':
          adjudicate(args['p_client_order_id'], 'canceled');
          return [] as unknown as T[];
        case 'bot_order_record_resolution_loss':
          return [
            { bot_order_record_resolution_loss: { booked: true, heldSize: 40, lossUsd: 4.8, reason: null } },
          ] as unknown as T[];
        default:
          throw new Error(`mock db: unexpected rpc '${fn}'`);
      }
    },
    async getConfigRows() {
      return state.configRows ?? [];
    },
  };
}

function makeMockClient(): MakerClobClientish & { postCalls: number } {
  const client = {
    postCalls: 0,
    getTickSize: async () => 0.01,
    createOrder: async (args: { tokenID: string; price: number; size: number; side: 'BUY' | 'SELL' }) => ({ ...args }),
    postOrder: async () => {
      client.postCalls++;
      return { orderID: '0xLIVE', success: true };
    },
    getOrder: async () => ({ status: 'matched', original_size: 33, size_matched: 33, price: 0.15 }),
    cancelOrder: async () => ({}),
    getOrderBook: async () => ({
      bids: [{ price: '0.10', size: '500' }],
      asks: [{ price: '0.15', size: '500' }],
      tick_size: '0.01',
      min_order_size: '5',
    }),
    getOpenOrders: async () => [] as unknown[],
    getTrades: async () => [] as unknown[],
    cancelOrders: async () => ({}),
    cancelAll: async () => ({}),
    cancelMarketOrders: async () => ({}),
  };
  return client;
}

function harness(
  state: MockDbState,
  tradeMode: string | undefined,
  clientOverride?: Partial<ReturnType<typeof makeMockClient>>,
) {
  const db = makeMockDb(state);
  const client = Object.assign(makeMockClient(), clientOverride);
  const alerts: TradeAlert[] = [];
  const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const ctx: JobCtx = {
    db,
    config: cfg,
    log: (msg, extra) => logs.push({ msg, extra }),
    startedAt: NOW,
  };
  const deps: BuyTableTickDeps = {
    now: NOW,
    getEnvVar: (name) => (name === 'TRADE_MODE' ? tradeMode : undefined),
    notify: async (a) => {
      alerts.push(a);
      return true;
    },
    liveClient: async () => client,
  };
  return { db, client, alerts, logs, ctx, deps };
}

const reservesOf = (db: { calls: Array<{ fn: string; args: Record<string, unknown> }> }) =>
  db.calls.filter((c) => c.fn === 'bot_order_reserve_intent');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// parseBuyTableConfig
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('parseBuyTableConfig', () => {
  it('falls back to the 0095/0102 defaults and honors overrides', () => {
    expect(parseBuyTableConfig([])).toEqual({
      priceCap: 0.15, leadMaxH: 12, leadMinH: 2, tickEnabled: true, cityCaps: {},
      maxEntryAttempts: 1, stopAfterFirstSuccess: false,
    });
    expect(
      parseBuyTableConfig([
        { key: 'buy_table.price_cap', value: '0.10' },
        { key: 'buy_table.lead_max_h', value: '24' },
        { key: 'buy_table.tick_enabled', value: 'false' },
        { key: 'buy_table.max_entry_attempts', value: '3' },
        { key: 'buy_table.stop_after_first_success', value: 'true' },
      ]),
    ).toEqual({
      priceCap: 0.1, leadMaxH: 24, leadMinH: 2, tickEnabled: false, cityCaps: {},
      maxEntryAttempts: 3, stopAfterFirstSuccess: true,
    });
  });

  it('0102: a zero/negative/fractional max_entry_attempts hand-edit falls back FAIL-SAFE to 1', () => {
    for (const bad of ['0', '-2', '1.5', 'x']) {
      expect(parseBuyTableConfig([{ key: 'buy_table.max_entry_attempts', value: bad }]).maxEntryAttempts).toBe(1);
    }
  });

  it('0109: parses buy_table.city_price_caps into a slug-keyed flat max map (normalized lower/trim)', () => {
    const cfg = parseBuyTableConfig([
      { key: 'buy_table.city_price_caps', value: '{" Karachi ": 0.3, "singapore": 0.2}' },
    ]);
    expect(cfg.cityCaps).toEqual({ karachi: 0.3, singapore: 0.2 });
  });

  it('0109: drops malformed JSON, non-object payloads, and invalid entries FAIL-SAFE (back to the global cap)', () => {
    expect(parseBuyTableConfig([{ key: 'buy_table.city_price_caps', value: 'not json' }]).cityCaps).toEqual({});
    expect(parseBuyTableConfig([{ key: 'buy_table.city_price_caps', value: '[1,2]' }]).cityCaps).toEqual({});
    expect(
      parseBuyTableConfig([
        {
          key: 'buy_table.city_price_caps',
          // a non-numeric value, zero, a negative, an above-1 price, a legacy 0097 {min,max} object — all
          // dropped; the sane flat entry survives.
          value: '{"bad": "x", "zero": 0, "neg": -0.1, "wild": 1.5, "legacy": {"min": 0.1, "max": 0.3}, "ok": 0.3}',
        },
      ]).cityCaps,
    ).toEqual({ ok: 0.3 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The gates (through the full tick, dry-run)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('buy-table-tick — the price gate (executable ask ≤ price_cap)', () => {
  it('enters at ask 0.15 and skips at ask 0.16', async () => {
    const h = harness(
      {
        mode: 'off',
        captures: [
          capture({ eventId: 'ev-cheap', ask: 0.15, hoursToClose: 6 }),
          capture({ eventId: 'ev-rich', ask: 0.16, hoursToClose: 6 }),
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    expect(stats.dryRun).toBe(1);
    const reserves = reservesOf(h.db);
    expect(reserves.length).toBe(1);
    expect(reserves[0]!.args['p_market_id']).toBe('c-ev-cheap-1');
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /price_cap/.test(String(l.extra?.reason)))).toBe(true);
  });
});

describe('buy-table-tick — per-city price CAPS (0109, max-only) override the global cap', () => {
  it('honors an override: enters at or below the city max even ABOVE the global cap; a cheap ask is ALWAYS in (no min)', async () => {
    const h = harness(
      {
        mode: 'off',
        configRows: [{ key: 'buy_table.city_price_caps', value: '{"testville": 0.30}' }],
        captures: [
          capture({ eventId: 'ev-mid', ask: 0.25, hoursToClose: 6 }), // > global 0.15 cap but ≤ the city max
          capture({ eventId: 'ev-cheap', ask: 0.05, hoursToClose: 6 }), // cheap — IN (there is no minimum bound)
          capture({ eventId: 'ev-rich', ask: 0.35, hoursToClose: 6 }), // above the city max — excluded
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(2);
    expect(stats.cityOverrides).toBe(1);
    expect(reservesOf(h.db).map((r) => r.args['p_market_id']).sort()).toEqual(['c-ev-cheap-1', 'c-ev-mid-1']);
    const capSkips = h.logs.filter(
      (l) => l.msg === 'buy-table.skip' && /price_cap .*city cap 0\.3/.test(String(l.extra?.reason)),
    );
    expect(capSkips.length).toBe(1);
  });

  it('falls back to the global price_cap for a city with NO override (the original ≤cap gate, unchanged)', async () => {
    const h = harness(
      {
        mode: 'off',
        // an override for a DIFFERENT city must not touch testville's gate
        configRows: [{ key: 'buy_table.city_price_caps', value: '{"otherville": 0.30}' }],
        captures: [
          capture({ eventId: 'ev-ok', ask: 0.15, hoursToClose: 6 }),
          capture({ eventId: 'ev-no', ask: 0.16, hoursToClose: 6 }),
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    expect(reservesOf(h.db).map((r) => r.args['p_market_id'])).toEqual(['c-ev-ok-1']);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /price_cap/.test(String(l.extra?.reason)))).toBe(true);
  });
});

describe('buy-table-tick — the HARD $0.01 minimum ask (non-configurable)', () => {
  it('skips a sub-cent ask however far under the cap; 1¢ exactly is allowed', async () => {
    const h = harness(
      {
        mode: 'off',
        captures: [
          capture({ eventId: 'ev-dead', ask: 0.005, hoursToClose: 6 }),
          capture({ eventId: 'ev-cent', ask: 0.01, hoursToClose: 7 }),
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    expect(reservesOf(h.db).map((r) => r.args['p_market_id'])).toEqual(['c-ev-cent-1']);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /below_min_price .*hard \$0\.01 floor/.test(String(l.extra?.reason)))).toBe(true);
  });

  it('the floor is a CONSTANT — no buy_table.* config key can change it', async () => {
    const h = harness(
      {
        mode: 'off',
        // an operator/hand-edit attempt at a lower floor must have NO effect (the key does not exist)
        configRows: [{ key: 'buy_table.min_price', value: '0' }],
        captures: [capture({ eventId: 'ev-dead', ask: 0.005, hoursToClose: 6 })],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(0);
  });
});

describe('buy-table-tick — the DEAD-BUCKET floor gate (0111): never buy a bucket the running max has killed', () => {
  // fixture: predicted bucket = idx 1, label '30°C' → dead iff wuRound(observed) > 30, i.e. observed ≥ 30.5.
  const floorsFor = (maxTenthsC: number) => [{ city: 'testville', targetDate: '2026-07-11', maxTenthsC }];

  it('°C: skips the predicted bucket when the observed running max has passed its top (the helsinki case)', async () => {
    const h = harness(
      { mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.001, hoursToClose: 6 })], floors: floorsFor(31.0) },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(0);
    expect(stats.dryRun).toBe(0);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /dead_bucket .*cannot win/.test(String(l.extra?.reason)))).toBe(true);
  });

  it('°C boundary: 30.5 observed rounds to 31 (wuRound half-up) → dead; 30.4 → 30 → still alive', async () => {
    const dead = harness(
      { mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], floors: floorsFor(30.5) },
      'dry-run',
    );
    expect((await buyTableTick(dead.ctx, dead.deps)).candidates).toBe(0);
    const alive = harness(
      { mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], floors: floorsFor(30.4) },
      'dry-run',
    );
    const stats = await buyTableTick(alive.ctx, alive.deps);
    expect(stats.candidates).toBe(1);
    expect(stats.dryRun).toBe(1);
  });

  it('°F: the native conversion decides — 32.0°C → 90°F kills an 88-89°F bucket; 31.5°C → 89°F does not', async () => {
    const fCap = () => {
      const cap = capture({ eventId: 'ev-f', ask: 0.12, hoursToClose: 6 });
      cap.buckets = cap.buckets!.map((b, i) => ({ ...b, label: ['86-87°F', '88-89°F', '90-91°F'][i]! }));
      return cap;
    };
    const dead = harness({ mode: 'off', captures: [fCap()], floors: floorsFor(32.0) }, 'dry-run');
    expect((await buyTableTick(dead.ctx, dead.deps)).candidates).toBe(0);
    const alive = harness({ mode: 'off', captures: [fCap()], floors: floorsFor(31.5) }, 'dry-run');
    expect((await buyTableTick(alive.ctx, alive.deps)).candidates).toBe(1);
  });

  it('a TOP-TAIL bucket ("or higher") is never floor-dead', async () => {
    const cap = capture({ eventId: 'ev-t', ask: 0.12, hoursToClose: 6 });
    cap.buckets = cap.buckets!.map((b, i) => (i === 1 ? { ...b, label: '30°C or higher' } : b));
    const h = harness({ mode: 'off', captures: [cap], floors: floorsFor(45.0) }, 'dry-run');
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
  });

  it('FAIL-OPEN: a missing floor row buys as before; a failing RPC (pre-0111) logs + buys as before', async () => {
    const noRow = harness(
      { mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], floors: [] },
      'dry-run',
    );
    expect((await buyTableTick(noRow.ctx, noRow.deps)).candidates).toBe(1);
    const rpcGone = harness(
      { mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], floors: 'throw' },
      'dry-run',
    );
    const stats = await buyTableTick(rpcGone.ctx, rpcGone.deps);
    expect(stats.candidates).toBe(1);
    expect(rpcGone.logs.some((l) => l.msg === 'buy-table.floor_read_unavailable')).toBe(true);
  });
});

describe('buy-table-tick — the lead window (C25 sweet-spot, [lead_min_h, lead_max_h])', () => {
  it('skips 13h-out and 1.5h-out; enters 6h-out', async () => {
    const h = harness(
      {
        mode: 'off',
        captures: [
          capture({ eventId: 'ev-early', ask: 0.12, hoursToClose: 13 }),
          capture({ eventId: 'ev-late', ask: 0.12, hoursToClose: 1.5 }),
          capture({ eventId: 'ev-in', ask: 0.12, hoursToClose: 6 }),
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    const reserves = reservesOf(h.db);
    expect(reserves.map((r) => r.args['p_market_id'])).toEqual(['c-ev-in-1']);
    const leadSkips = h.logs.filter((l) => l.msg === 'buy-table.skip' && /lead_window/.test(String(l.extra?.reason)));
    expect(leadSkips.length).toBe(2);
  });
});

describe('buy-table-tick — one entry per market EVER (the DEFAULT gate, 0102 rules off)', () => {
  it('a prior entry row — even a terminal failed one — blocks a re-entry at the default max_entry_attempts=1', async () => {
    const marketId = 'c-ev-1-1';
    const intentKey = orderIntentKey({ marketId, side: 'BUY', purpose: 'entry', tradeDate: '2026-07-11' });
    const h = harness(
      {
        mode: 'off',
        captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })],
        entries: [
          { marketId, tokenId: 'y-ev-1-1', tradeDate: '2026-07-11', intentKey, status: 'failed', sizeMatched: 0 },
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(0);
    expect(reservesOf(h.db).length).toBe(0);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /already_entered/.test(String(l.extra?.reason)))).toBe(true);
  });
});

describe('buy-table-tick — the 0102 entry rules (verification semantics)', () => {
  const marketId = 'c-ev-1-1';
  const intentKey = orderIntentKey({ marketId, side: 'BUY', purpose: 'entry', tradeDate: '2026-07-11' });
  const row = (status: string, sizeMatched = 0): BuyTableEntryRow => ({
    marketId, tokenId: 'y-ev-1-1', tradeDate: '2026-07-11', intentKey, status, sizeMatched,
  });
  const RETRY3 = [{ key: 'buy_table.max_entry_attempts', value: '3' }];

  it('rule 1: a PROVABLY-dead attempt (clean-rejection failed row) is RETRIED under max_entry_attempts=3', async () => {
    const h = harness(
      { mode: 'off', configRows: RETRY3, captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], entries: [row('failed')] },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    expect(reservesOf(h.db).length).toBe(1);
  });

  it('rule 1: a zero-fill canceled row is also retryable; the attempt CAP still ends it (3 rows ≥ 3)', async () => {
    const one = harness(
      { mode: 'off', configRows: RETRY3, captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], entries: [row('canceled')] },
      'dry-run',
    );
    expect((await buyTableTick(one.ctx, one.deps)).candidates).toBe(1);

    const capped = harness(
      {
        mode: 'off', configRows: RETRY3,
        captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })],
        entries: [row('failed'), row('failed'), row('failed')],
      },
      'dry-run',
    );
    const stats = await buyTableTick(capped.ctx, capped.deps);
    expect(stats.candidates).toBe(0);
    expect(capped.logs.some((l) => l.msg === 'buy-table.skip' && /already_entered/.test(String(l.extra?.reason)))).toBe(true);
  });

  it('rule 1 boundary: UNKNOWN-state rows (stuck intent / unfilled placed) ALWAYS block, retries or not', async () => {
    for (const unknown of [row('intent'), row('placed', 0)]) {
      const h = harness(
        { mode: 'off', configRows: RETRY3, captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], entries: [unknown] },
        'dry-run',
      );
      const stats = await buyTableTick(h.ctx, h.deps);
      expect(stats.candidates).toBe(0);
      expect(reservesOf(h.db).length).toBe(0);
    }
  });

  it('rule 1 boundary: a market with a REAL fill (position) is never re-entered, retries or not', async () => {
    const h = harness(
      { mode: 'off', configRows: RETRY3, captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], entries: [row('filled', 33)] },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(0);
  });

  it('rule 2: a fill ANYWHERE in the mode + stop_after_first_success halts ALL new entries (fresh market skipped)', async () => {
    const otherKey = orderIntentKey({ marketId: 'c-other-1', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-10' });
    const h = harness(
      {
        mode: 'off',
        configRows: [{ key: 'buy_table.stop_after_first_success', value: 'true' }],
        captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })],
        entries: [
          { marketId: 'c-other-1', tokenId: 'y-other', tradeDate: '2026-07-10', intentKey: otherKey, status: 'filled', sizeMatched: 41 },
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.laneHalted).toBe(true);
    expect(stats.candidates).toBe(0);
    expect(stats.dryRun).toBe(0);
    expect(reservesOf(h.db).length).toBe(0);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /lane_halted/.test(String(l.extra?.reason)))).toBe(true);
  });

  it('rule 2 in-tick: the FIRST live fill stops the same tick\'s remaining candidates (one buy, then quiet)', async () => {
    const h = harness(
      {
        mode: 'live',
        preflightOk: true,
        configRows: [{ key: 'buy_table.stop_after_first_success', value: 'true' }],
        captures: [
          capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 }),
          capture({ eventId: 'ev-2', ask: 0.12, hoursToClose: 7 }),
        ],
      },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    // the mock venue fills the first FAK (getOrder → matched) → the second candidate is never posted
    expect(stats.placed).toBe(1);
    expect(stats.laneHalted).toBe(true);
    expect(h.client.postCalls).toBe(1);
    expect(reservesOf(h.db).length).toBe(1);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /lane_halted — first successful buy/.test(String(l.extra?.reason)))).toBe(true);
  });

  it('0110: a LIVE fill pushes BUY_TABLE_FILLED — what was bought and at what price (the poll avg, not the ask)', async () => {
    const h = harness(
      { mode: 'live', preflightOk: true, captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })] },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.placed).toBe(1);
    const fill = h.alerts.find((a) => a.kind === 'BUY_TABLE_FILLED');
    expect(fill).toBeDefined();
    expect(fill!.severity).toBe('INFO');
    expect(fill!.title).toContain('testville');
    expect(fill!.title).toContain('30°C'); // the predicted bucket's label — what was bought
    expect(fill!.body).toContain('33 sh @ 0.15'); // the venue poll's avg fill price (mock getOrder), NOT the 0.12 ask
    expect(fill!.body).toContain('$4.95'); // 33 × 0.15
    expect(fill!.dedupeKey).toMatch(/^buy-table-fill:/); // per-order key — every distinct buy pushes once
  });

  it('0110: a SUB-CENT fill price renders exactly — never "@ 0.00" (a 2¢ ask can still FILL below 1¢)', async () => {
    const h = harness(
      { mode: 'live', preflightOk: true, captures: [capture({ eventId: 'ev-1', ask: 0.02, hoursToClose: 6 })] },
      'live',
      { getOrder: async () => ({ status: 'matched', original_size: 250, size_matched: 250, price: 0.001 }) },
    );
    await buyTableTick(h.ctx, h.deps);
    const fill = h.alerts.find((a) => a.kind === 'BUY_TABLE_FILLED');
    expect(fill).toBeDefined();
    expect(fill!.body).toContain('250 sh @ 0.001 = $0.25');
    expect(fill!.body).not.toContain('@ 0.00 ');
  });

  it('0110: dry-run records the intent but pushes NO fill alert (no fill exists off-venue)', async () => {
    const h = harness(
      { mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })] },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.dryRun).toBe(1);
    expect(h.alerts.filter((a) => a.kind === 'BUY_TABLE_FILLED')).toEqual([]);
  });

  it('F1: a poll-verified ZERO-FILL FAK is adjudicated canceled in-tick (retryable) and does NOT halt the lane', async () => {
    const h = harness(
      {
        mode: 'live', preflightOk: true,
        configRows: [{ key: 'buy_table.stop_after_first_success', value: 'true' }, ...RETRY3],
        captures: [
          capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 }),
          capture({ eventId: 'ev-2', ask: 0.12, hoursToClose: 7 }),
        ],
      },
      'live',
      // the venue accepts the FAK but matches NOTHING (ask moved) — Fill-And-Kill dies at post
      { getOrder: async () => ({ status: 'canceled', original_size: 41, size_matched: 0 }) },
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.zeroFillAdjudicated).toBe(2); // both zero-fills adjudicated → both markets retryable next tick
    expect(stats.laneHalted).toBe(false); // no fill happened — rule 2 must NOT trigger
    expect(stats.haltedOnAmbiguous).toBe(false);
    expect(h.db.calls.filter((c) => c.fn === 'bot_order_record_canceled').length).toBe(2);
    expect(reservesOf(h.db).length).toBe(2); // no halt — the lane moved to the next candidate
  });

  it('F2: an AMBIGUOUS post failure (shapeless venue response — possible hidden fill) HALTS the tick', async () => {
    const h = harness(
      {
        mode: 'live', preflightOk: true,
        configRows: [{ key: 'buy_table.stop_after_first_success', value: 'true' }],
        captures: [
          capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 }),
          capture({ eventId: 'ev-2', ask: 0.12, hoursToClose: 7 }),
        ],
      },
      'live',
      { postOrder: async () => ({}) }, // no orderID, no explicit rejection → ERR_CLOB_POST (state unknown)
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.failed).toBe(1);
    expect(stats.haltedOnAmbiguous).toBe(true);
    expect(reservesOf(h.db).length).toBe(1); // the second candidate was never attempted
    expect(h.alerts.some((a) => a.kind === 'BUY_TABLE_POST_FAILED')).toBe(true);
    expect(h.alerts.some((a) => a.kind === 'ORDER_NEEDS_RECONCILE')).toBe(true);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /ambiguous post failure/.test(String(l.extra?.reason)))).toBe(true);
  });

  it('F2 boundary: a CLEAN venue rejection does NOT halt — the lane moves to the next candidate (rule 1)', async () => {
    const h = harness(
      {
        mode: 'live', preflightOk: true,
        configRows: [{ key: 'buy_table.stop_after_first_success', value: 'true' }],
        captures: [
          capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 }),
          capture({ eventId: 'ev-2', ask: 0.12, hoursToClose: 7 }),
        ],
      },
      'live',
      { postOrder: async () => ({ success: false, errorMsg: 'rejected: insufficient balance' }) },
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.failed).toBe(2); // both attempted, both cleanly rejected
    expect(stats.haltedOnAmbiguous).toBe(false);
    expect(reservesOf(h.db).length).toBe(2);
  });

  it('rule 2 does NOT halt on fill-less attempts (a failed row is not a success)', async () => {
    const h = harness(
      {
        mode: 'off',
        configRows: [{ key: 'buy_table.stop_after_first_success', value: 'true' }, ...RETRY3],
        captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })],
        entries: [row('failed')],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.laneHalted).toBe(false);
    expect(stats.candidates).toBe(1);
  });
});

describe('buy-table-tick — the TRADE MODE ladder', () => {
  it("TRADE_MODE=off is inert (no DB reads beyond the mode resolve)", async () => {
    const h = harness({ mode: 'off' }, 'off');
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.skipped).toBe('trade_mode_off');
    expect(h.db.calls.length).toBe(0);
  });

  it('an absent/typo TRADE_MODE resolves to dry-run — records the intent but NEVER posts', async () => {
    const h = harness({ mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })] }, undefined);
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.mode).toBe('dry-run');
    expect(stats.dryRun).toBe(1);
    expect(h.client.postCalls).toBe(0); // the venue is NEVER touched in dry-run
    const reserves = reservesOf(h.db);
    expect(reserves.length).toBe(1);
    expect(reserves[0]!.args['p_mode']).toBe('dry-run');
    expect(reserves[0]!.args['p_strategy']).toBe('buy-table');
    // the dry-run row gets the synthetic placed marker (the shadow-harness contract)
    const placed = h.db.calls.filter((c) => c.fn === 'bot_order_record_placed');
    expect(placed.length).toBe(1);
    expect(String(placed[0]!.args['p_order_id'])).toMatch(/^dry-run:/);
    // no preflight read in dry-run (the interlock gates LIVE posts only)
    expect(h.db.calls.some((c) => c.fn === 'trade_live_preflight')).toBe(false);
  });

  it('tick_enabled=false skips the whole tick before any trade read', async () => {
    const h = harness(
      { mode: 'off', configRows: [{ key: 'buy_table.tick_enabled', value: 'false' }] },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.skipped).toBe('tick_disabled');
    expect(h.db.calls.length).toBe(0);
  });
});

describe('buy-table-tick — live posts only behind trade_live_preflight(buy-table)', () => {
  it('preflight not ok → NO live posts (every candidate held)', async () => {
    const h = harness(
      { mode: 'live', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], preflightOk: false },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    expect(stats.placed).toBe(0);
    expect(h.client.postCalls).toBe(0);
    expect(reservesOf(h.db).length).toBe(0);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /preflight_blocked/.test(String(l.extra?.reason)))).toBe(true);
  });

  it('a preflight READ failure fails closed (no live posts)', async () => {
    const h = harness(
      { mode: 'live', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], preflightOk: 'throw' },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.placed).toBe(0);
    expect(h.client.postCalls).toBe(0);
    expect(h.logs.some((l) => l.msg === 'buy-table.preflight_unavailable')).toBe(true);
  });

  it('preflight ok → posts the taker FAK entry (strategy buy-table, fee booked)', async () => {
    const h = harness(
      { mode: 'live', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], preflightOk: true },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    expect(stats.placed).toBe(1);
    expect(h.client.postCalls).toBe(1);
    const reserves = reservesOf(h.db);
    expect(reserves.length).toBe(1);
    expect(reserves[0]!.args['p_mode']).toBe('live');
    expect(reserves[0]!.args['p_strategy']).toBe('buy-table');
    expect(reserves[0]!.args['p_side']).toBe('BUY');
    expect(reserves[0]!.args['p_purpose']).toBe('entry');
    expect(reserves[0]!.args['p_order_type']).toBe('FAK');
    // stake $5 at ask 0.12 → floor(41.67) = 41 shares
    expect(Number(reserves[0]!.args['p_size'])).toBe(41);
    // the matched fill books the taker fee (bot.takerFeeRate default 0.05 → 500 bps)
    const fills = h.db.calls.filter((c) => c.fn === 'bot_order_record_fill');
    expect(fills.length).toBe(1);
    expect(Number(fills[0]!.args['p_fee_usd'])).toBeGreaterThan(0);
  });
});

describe('buy-table-tick — degraded reads place NOTHING (never "no candidates")', () => {
  it('a failed discovery read marks the tick degraded and skips all placement', async () => {
    const h = harness({ mode: 'off', captures: 'throw' }, 'dry-run');
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.degraded).toBe(true);
    expect(stats.discoveryDegraded).toBe(true);
    expect(stats.candidates).toBe(0);
    expect(reservesOf(h.db).length).toBe(0);
    expect(h.alerts.length).toBe(0); // dry-run: structured logs only, no page
  });

  it('a failed discovery read while LIVE pages BUY_TABLE_DEGRADED (day-bucketed)', async () => {
    const h = harness({ mode: 'live', captures: 'throw' }, 'live');
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.degraded).toBe(true);
    expect(h.alerts.map((a) => a.kind)).toEqual(['BUY_TABLE_DEGRADED']);
    expect(h.alerts[0]!.dedupeKey).toBe('buy-table-degraded:2026-07-11');
  });

  it('a failed lane-ledger read (the ever-gate input) also fails closed', async () => {
    const h = harness(
      { mode: 'off', captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })], entries: 'throw' },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.degraded).toBe(true);
    expect(stats.entriesDegraded).toBe(true);
    expect(reservesOf(h.db).length).toBe(0);
  });

  it('an ABSENT buy_table_entries (0095 not applied) is a staged-dark skip, not a failure', async () => {
    const h = harness({ mode: 'off', entries: 'missing' }, 'dry-run');
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.stagedDark).toBe(true);
    // the lane went inert BEFORE discovery — nothing else was read
    expect(h.db.calls.some((c) => c.fn === 'convergence_capture_inputs')).toBe(false);
  });
});

describe('buy-table-tick — hold-to-close resolution-loss booking', () => {
  it('books the loss for a held entry whose market resolved AGAINST it (and never re-enters it)', async () => {
    const cap = capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 });
    const marketId = 'c-ev-1-1'; // our held bucket idx 1…
    const intentKey = orderIntentKey({ marketId, side: 'BUY', purpose: 'entry', tradeDate: '2026-07-11' });
    const h = harness(
      {
        mode: 'live',
        captures: [cap],
        resolutions: [{ id: 'ev-1', winnerIdx: 2, gradingMismatch: false }], // …but idx 2 won
        entries: [
          { marketId, tokenId: 'y-ev-1-1', tradeDate: '2026-07-11', intentKey, status: 'filled', sizeMatched: 41 },
        ],
        preflightOk: true,
      },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    const booked = h.db.calls.filter((c) => c.fn === 'bot_order_record_resolution_loss');
    expect(booked.length).toBe(1);
    expect(booked[0]!.args['p_market_id']).toBe(marketId);
    expect(booked[0]!.args['p_token_id']).toBe('y-ev-1-1');
    expect(booked[0]!.args['p_mode']).toBe('live');
    expect(stats.lossesBooked).toBe(1);
    // the resolved market is not a candidate (resolved skip) and never re-entered
    expect(stats.candidates).toBe(0);
    expect(reservesOf(h.db).length).toBe(0);
  });

  it('does NOT book when the market resolved FOR the held bucket', async () => {
    const cap = capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 });
    const marketId = 'c-ev-1-1';
    const intentKey = orderIntentKey({ marketId, side: 'BUY', purpose: 'entry', tradeDate: '2026-07-11' });
    const h = harness(
      {
        mode: 'dry-run',
        captures: [cap],
        resolutions: [{ id: 'ev-1', winnerIdx: 1, gradingMismatch: false }], // our bucket WON
        entries: [
          { marketId, tokenId: 'y-ev-1-1', tradeDate: '2026-07-11', intentKey, status: 'filled', sizeMatched: 41 },
        ],
      },
      'dry-run',
    );
    await buyTableTick(h.ctx, h.deps);
    expect(h.db.calls.filter((c) => c.fn === 'bot_order_record_resolution_loss').length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The pure helpers directly (edge shapes)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('selectBuyTableCandidates — pure edge shapes', () => {
  const baseCfg = {
    priceCap: 0.15, leadMaxH: 12, leadMinH: 2, tickEnabled: true, cityCaps: {},
    maxEntryAttempts: 1, stopAfterFirstSuccess: false,
  };

  it('skips unseeded captures (no houseProb → no forecast center to buy)', () => {
    const cap = capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 });
    cap.buckets = cap.buckets!.map((b) => ({ ...b, houseProb: null }));
    const { candidates, skips } = selectBuyTableCandidates({
      captures: [cap],
      resolutions: [],
      existingIntentKeys: new Set(),
      cfg: baseCfg,
      stakeUsd: 5,
      minOrderSizeShares: 5,
      now: NOW,
    });
    expect(candidates).toEqual([]);
    expect(skips.some((s) => /no_house_prob/.test(s.reason))).toBe(true);
  });

  it('prefers the walked execAsk over bestAsk, and falls back to bestAsk when execAsk is null', () => {
    const withExec = capture({ eventId: 'ev-1', ask: 0.2, hoursToClose: 6, execAsk: 0.14 });
    const noExec = capture({ eventId: 'ev-2', ask: 0.14, hoursToClose: 6, execAsk: null });
    const { candidates } = selectBuyTableCandidates({
      captures: [withExec, noExec],
      resolutions: [],
      existingIntentKeys: new Set(),
      cfg: baseCfg,
      stakeUsd: 5,
      minOrderSizeShares: 5,
      now: NOW,
    });
    expect(candidates.map((c) => [c.marketId, c.ask])).toEqual([
      ['c-ev-1-1', 0.14],
      ['c-ev-2-1', 0.14],
    ]);
  });

  it('uses only the LATEST capture per event (an older cheap tick cannot enter)', () => {
    const old = capture({ eventId: 'ev-1', ask: 0.1, hoursToClose: 6 });
    old.capturedAt = new Date(NOW.getTime() - 3_600_000).toISOString();
    const fresh = capture({ eventId: 'ev-1', ask: 0.4, hoursToClose: 6 }); // converged above the cap by now
    const { candidates, skips } = selectBuyTableCandidates({
      captures: [old, fresh],
      resolutions: [],
      existingIntentKeys: new Set(),
      cfg: baseCfg,
      stakeUsd: 5,
      minOrderSizeShares: 5,
      now: NOW,
    });
    expect(candidates).toEqual([]);
    expect(skips.some((s) => /price_cap/.test(s.reason))).toBe(true);
  });

  it('enforces the venue min-order floor via floor(stake/ask) shares', () => {
    const cap = capture({ eventId: 'ev-1', ask: 0.14, hoursToClose: 6 });
    const { candidates, skips } = selectBuyTableCandidates({
      captures: [cap],
      resolutions: [],
      existingIntentKeys: new Set(),
      cfg: baseCfg,
      stakeUsd: 0.5, // floor(0.5/0.14)=3 < 5 min shares
      minOrderSizeShares: 5,
      now: NOW,
    });
    expect(candidates).toEqual([]);
    expect(skips.some((s) => /below_min_size/.test(s.reason))).toBe(true);
  });
});

describe('resolvedAgainstEntries — pure edge shapes', () => {
  it('ignores unresolved markets, terminal rows, and zero-held entries', () => {
    const cap = capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 });
    const entries: BuyTableEntryRow[] = [
      { marketId: 'c-ev-1-1', tokenId: 'y-ev-1-1', tradeDate: '2026-07-11', intentKey: 'a', status: 'filled', sizeMatched: 0 },
      { marketId: 'c-ev-1-1', tokenId: 'y-ev-1-1', tradeDate: '2026-07-11', intentKey: 'b', status: 'failed', sizeMatched: 10 },
    ];
    expect(
      resolvedAgainstEntries({ entries, captures: [cap], resolutions: [{ id: 'ev-1', winnerIdx: null, gradingMismatch: false }] }),
    ).toEqual([]);
    expect(
      resolvedAgainstEntries({ entries, captures: [cap], resolutions: [{ id: 'ev-1', winnerIdx: 2, gradingMismatch: false }] }),
    ).toEqual([]); // sizeMatched 0 + terminal failed — nothing bookable
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F4 (C18d) — the lane-scoped reconcile sweep: the cloud twin of the daemon's startup sweep, run
// every LIVE tick BEFORE the entries read. A stuck 'intent' row (the 07-12 class) is adjudicated
// against venue evidence; a freed market becomes retryable the SAME tick.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('buy-table-tick — the F4 lane-scoped reconcile sweep', () => {
  const marketId = 'c-ev-1-1';
  const intentKey = orderIntentKey({ marketId, side: 'BUY', purpose: 'entry', tradeDate: '2026-07-11' });
  const entryRow = (status: string, sizeMatched = 0): BuyTableEntryRow => ({
    marketId, tokenId: 'y-ev-1-1', tradeDate: '2026-07-11', intentKey, status, sizeMatched,
  });
  const danglingRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    mode: 'live', intent_key: intentKey, client_order_id: 'cid-stuck', status: 'intent', order_id: null,
    side: 'BUY', purpose: 'entry', price: 0.15, size: 33, size_matched: 0,
    token_id: 'y-ev-1-1', market_id: marketId, created_at: '2026-07-11T09:00:00Z',
    strategy: 'buy-table', ...over,
  });

  it('END-TO-END: a stuck intent is FREED by the sweep and the market is re-bought the SAME tick', async () => {
    const h = harness(
      {
        mode: 'live',
        preflightOk: true,
        configRows: [{ key: 'buy_table.max_entry_attempts', value: '2' }],
        captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })],
        entries: [entryRow('intent')], // pre-sweep: unknown-state → would block forever
        dangling: [danglingRow()],
      },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);

    expect(stats.reconcileFreed).toBe(1);
    expect(stats.reconcileFailed).toBe(false);
    // ordering is the mechanism: sweep (list + adjudicate) strictly BEFORE the entries read
    const idx = (fn: string): number => h.db.calls.findIndex((c) => c.fn === fn);
    expect(idx('bot_order_list_dangling')).toBeGreaterThanOrEqual(0);
    expect(idx('bot_order_list_dangling')).toBeLessThan(idx('bot_order_record_failed'));
    expect(idx('bot_order_record_failed')).toBeLessThan(idx('buy_table_entries'));
    // the payoff: the freed row reads 'failed' (retryable under attempts=2) → the market was bought
    expect(stats.candidates).toBe(1);
    expect(h.client.postCalls).toBe(1);
  });

  it('scope: foreign-strategy and untagged rows are left untouched — venue evidence is never read', async () => {
    let openOrdersReads = 0;
    const h = harness(
      {
        mode: 'live',
        dangling: [
          danglingRow({ strategy: 'maker-exit', client_order_id: 'cid-daemon' }),
          danglingRow({ strategy: null, client_order_id: 'cid-pre0085', intent_key: 'other|BUY|entry|2026-07-11' }),
        ],
      },
      'live',
      { getOpenOrders: async () => { openOrdersReads++; return []; } },
    );
    const stats = await buyTableTick(h.ctx, h.deps);

    expect(stats.reconcileAdopted).toBe(0);
    expect(stats.reconcileFreed).toBe(0);
    expect(stats.reconcileHeld).toBe(0);
    expect(openOrdersReads).toBe(0);
    expect(h.db.calls.some((c) => c.fn === 'bot_order_record_failed' || c.fn === 'bot_order_record_placed')).toBe(false);
  });

  it('dry-run: the sweep never runs (bot_order_list_dangling is not called)', async () => {
    const h = harness({ mode: 'off', dangling: [danglingRow()] }, 'dry-run');
    await buyTableTick(h.ctx, h.deps);
    expect(h.db.calls.some((c) => c.fn === 'bot_order_list_dangling')).toBe(false);
  });

  it('a sweep failure is ISOLATED: reconcileFailed=true, tick not degraded, placement still runs', async () => {
    const h = harness(
      {
        mode: 'live',
        preflightOk: true,
        captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })],
        dangling: 'throw',
      },
      'live',
    );
    const stats = await buyTableTick(h.ctx, h.deps);

    expect(stats.reconcileFailed).toBe(true);
    expect(stats.degraded).toBe(false);
    expect(stats.candidates).toBe(1);
    expect(h.client.postCalls).toBe(1);
    expect(h.logs.some((l) => l.msg === 'buy-table.reconcile_failed')).toBe(true);
  });

  it('held on ambiguity: the row stays blocking (no re-entry), a RECONCILE_AMBIGUOUS WARN fires', async () => {
    const venueOrder = (id: string) => ({
      id, status: 'live', side: 'BUY', asset_id: 'y-ev-1-1',
      original_size: '33', size_matched: '0', price: '0.15', order_type: 'FAK',
    });
    const h = harness(
      {
        mode: 'live',
        preflightOk: true,
        configRows: [{ key: 'buy_table.max_entry_attempts', value: '2' }],
        captures: [capture({ eventId: 'ev-1', ask: 0.12, hoursToClose: 6 })],
        entries: [entryRow('intent')],
        dangling: [danglingRow()],
      },
      'live',
      { getOpenOrders: async () => [venueOrder('0xV1'), venueOrder('0xV2')] },
    );
    const stats = await buyTableTick(h.ctx, h.deps);

    expect(stats.reconcileHeld).toBe(1);
    expect(h.alerts.some((a) => a.kind === 'RECONCILE_AMBIGUOUS' && a.severity === 'WARN')).toBe(true);
    // the intent row was NOT adjudicated → unknown-state still blocks the market
    expect(stats.candidates).toBe(0);
    expect(h.client.postCalls).toBe(0);
    expect(h.logs.some((l) => l.msg === 'buy-table.skip' && /already_entered/.test(String(l.extra?.reason)))).toBe(true);
  });
});
