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
  cityAllowlist?: string[] | null;
}

function makeMockDb(state: MockDbState): DbPort & { calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
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
          if (state.entries === 'throw') throw new Error('rpc buy_table_entries failed: boom');
          if (state.entries === 'missing') {
            throw new Error('rpc buy_table_entries failed: function public.buy_table_entries(p_mode => text) does not exist');
          }
          return [{ buy_table_entries: { rows: state.entries ?? [] } }] as unknown as T[];
        case 'convergence_capture_inputs':
          if (state.captures === 'throw') throw new Error('rpc convergence_capture_inputs failed: timeout');
          return [
            { convergence_capture_inputs: { captures: state.captures ?? [], resolutions: state.resolutions ?? [] } },
          ] as unknown as T[];
        case 'trade_live_preflight':
          if (state.preflightOk === 'throw') throw new Error('rpc trade_live_preflight failed: boom');
          return [{ trade_live_preflight: { ok: state.preflightOk === true, reasons: [] } }] as unknown as T[];
        case 'bot_order_by_intent':
          return [{ bot_order_by_intent: null }] as unknown as T[];
        case 'bot_order_reserve_intent':
          return [{ bot_order_reserve_intent: 'reserved' }] as unknown as T[];
        case 'bot_order_record_placed':
        case 'bot_order_record_fill':
        case 'bot_order_record_failed':
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

function harness(state: MockDbState, tradeMode: string | undefined) {
  const db = makeMockDb(state);
  const client = makeMockClient();
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
  it('falls back to the 0095 defaults and honors overrides', () => {
    expect(parseBuyTableConfig([])).toEqual({
      priceCap: 0.15, leadMaxH: 12, leadMinH: 2, tickEnabled: true, cityRanges: {},
    });
    expect(
      parseBuyTableConfig([
        { key: 'buy_table.price_cap', value: '0.10' },
        { key: 'buy_table.lead_max_h', value: '24' },
        { key: 'buy_table.tick_enabled', value: 'false' },
      ]),
    ).toEqual({ priceCap: 0.1, leadMaxH: 24, leadMinH: 2, tickEnabled: false, cityRanges: {} });
  });

  it('0097: parses buy_table.city_price_ranges into slug-keyed cityRanges (normalized lower/trim)', () => {
    const cfg = parseBuyTableConfig([
      { key: 'buy_table.city_price_ranges', value: '{" Karachi ": {"min": 0.05, "max": 0.3}, "singapore": {"min": 0, "max": 0.2}}' },
    ]);
    expect(cfg.cityRanges).toEqual({ karachi: { min: 0.05, max: 0.3 }, singapore: { min: 0, max: 0.2 } });
  });

  it('0097: drops malformed JSON, non-object payloads, and invalid entries FAIL-SAFE (back to the global cap)', () => {
    expect(parseBuyTableConfig([{ key: 'buy_table.city_price_ranges', value: 'not json' }]).cityRanges).toEqual({});
    expect(parseBuyTableConfig([{ key: 'buy_table.city_price_ranges', value: '[1,2]' }]).cityRanges).toEqual({});
    expect(
      parseBuyTableConfig([
        {
          key: 'buy_table.city_price_ranges',
          // inverted min/max, a non-numeric bound, a bare string entry — all dropped; the sane one survives.
          value: '{"bad": {"min": 0.5, "max": 0.2}, "worse": {"min": "x", "max": 0.2}, "junk": "x", "ok": {"min": 0.1, "max": 0.3}}',
        },
      ]).cityRanges,
    ).toEqual({ ok: { min: 0.1, max: 0.3 } });
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

describe('buy-table-tick — per-city price RANGES (0097) override the global cap', () => {
  it('honors an override: enters inside [min,max] even ABOVE the global cap; min excludes a too-cheap ask', async () => {
    const h = harness(
      {
        mode: 'off',
        configRows: [{ key: 'buy_table.city_price_ranges', value: '{"testville": {"min": 0.10, "max": 0.30}}' }],
        captures: [
          capture({ eventId: 'ev-mid', ask: 0.25, hoursToClose: 6 }), // > global 0.15 cap but inside the override
          capture({ eventId: 'ev-cheap', ask: 0.05, hoursToClose: 6 }), // below the override MIN — excluded
          capture({ eventId: 'ev-rich', ask: 0.35, hoursToClose: 6 }), // above the override MAX — excluded
        ],
      },
      'dry-run',
    );
    const stats = await buyTableTick(h.ctx, h.deps);
    expect(stats.candidates).toBe(1);
    expect(stats.cityOverrides).toBe(1);
    expect(reservesOf(h.db).map((r) => r.args['p_market_id'])).toEqual(['c-ev-mid-1']);
    const rangeSkips = h.logs.filter((l) => l.msg === 'buy-table.skip' && /price_range/.test(String(l.extra?.reason)));
    expect(rangeSkips.length).toBe(2);
  });

  it('falls back to the global [0, price_cap] for a city with NO override (the original gate, unchanged)', async () => {
    const h = harness(
      {
        mode: 'off',
        // an override for a DIFFERENT city must not touch testville's gate
        configRows: [{ key: 'buy_table.city_price_ranges', value: '{"otherville": {"min": 0.10, "max": 0.30}}' }],
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

describe('buy-table-tick — one entry per market EVER (no re-entry, no chase)', () => {
  it('a prior entry row — even a terminal failed one — blocks a re-entry', async () => {
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
  const baseCfg = { priceCap: 0.15, leadMaxH: 12, leadMinH: 2, tickEnabled: true, cityRanges: {} };

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
