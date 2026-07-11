/**
 * /trading render smoke test — the LIVE-RAIL activation console is a server component composing ONE RPC loader
 * (getTrading → dash_trading, 0082). Renders the whole tree to static markup with the loader mocked to prove
 * (a) it never throws, (b) every section reaches the DOM on a populated LIVE fixture (mode + caps + interlock
 * verdict + reasons + gate/override + the daily-loss kill meter + open positions/orders + dry-run counts +
 * audit), (c) the CLEAR + KILL-TRIPPED branches render, (d) the seeded-dark APPLIED-but-empty state renders
 * without the not-applied banner, (e) the explicit "0082 NOT APPLIED" empty-state renders ONLY for the
 * loader's { kind: 'not-applied' } verdict, and (f) #22: { kind: 'error' } renders the DISTINCT
 * "console temporarily unavailable" state, never the false not-applied diagnosis. Mirrors data-page.render.test.ts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/supabase.ts', () => ({ serverDb: async () => ({}) }));
// The CITY-LIVE (lane W) forms are client components (components/trading-controls.tsx) that call useRouter — stub
// next/navigation so renderToStaticMarkup can drive the page's full tree (incl. the config editor + arms table).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

// dash_city_live (0085) fixture — 2 cities enabled (Singapore + Karachi) so the arms table renders its at-cap
// lockout, plus a 3rd unenabled city (Amsterdam) whose toggle must be disabled. Board + taker-vs-maker twin.
const CITY_LIVE = {
  arms: [
    { cityId: 'c-sing', slug: 'singapore', displayName: 'Singapore', icao: 'WSSS', unit: 'C', enabled: true, stakeUsd: '5.00', entryHourOverride: 12, promotedStatus: 'PROMOTED', enabledAt: '2026-07-06T09:00:00Z', updatedAt: '2026-07-06T09:00:00Z' },
    { cityId: 'c-kar', slug: 'karachi', displayName: 'Karachi', icao: 'OPKC', unit: 'C', enabled: true, stakeUsd: '5.00', entryHourOverride: null, promotedStatus: 'PROMOTED', enabledAt: '2026-07-06T09:00:00Z', updatedAt: '2026-07-06T09:00:00Z' },
    { cityId: 'c-ams', slug: 'amsterdam', displayName: 'Amsterdam', icao: 'EHAM', unit: 'C', enabled: false, stakeUsd: '5.00', entryHourOverride: null, promotedStatus: 'WATCH', enabledAt: null, updatedAt: '2026-07-06T09:00:00Z' },
  ],
  board: {
    asOf: '2026-07-06T09:05:00Z',
    rows: [
      { cityId: 'c-kar', slug: 'karachi', icao: 'OPKC', nBets: 42, nDays: 15, netPnlUsd: '40.41', recommendedHour: 12, watchConfidence: 'sufficient', edge: 0.061, edgeCiLo: 0.012, edgeCiHi: 0.11, status: 'PROMOTED', reasons: ['eligible'] },
      { cityId: 'c-ams', slug: 'amsterdam', icao: 'EHAM', nBets: 6, nDays: 5, netPnlUsd: '3.10', recommendedHour: null, watchConfidence: 'insufficient', edge: 0.03, edgeCiLo: null, edgeCiHi: null, status: 'WATCH', reasons: ['nDays 5 < 10'] },
    ],
  },
  twin: [
    { cityId: 'c-kar', slug: 'karachi', nPlacements: 42, twinFilledFrac: 0.71, takerPnlUsd: '40.41', makerTwinPnlUsd: '52.10' },
  ],
  // 0094: the FULL cities domain — London has NO arm and must still be an allowlist picker option.
  allCities: [
    { slug: 'amsterdam', displayName: 'Amsterdam', enrolled: true },
    { slug: 'karachi', displayName: 'Karachi', enrolled: true },
    { slug: 'london', displayName: 'London', enrolled: false },
    { slug: 'singapore', displayName: 'Singapore', enrolled: true },
  ],
  generatedAt: '2026-07-06T09:05:00Z',
};
// A single-enabled variant — proves the lockout is NOT engaged below 2 enabled cities.
const CITY_LIVE_ONE = {
  ...CITY_LIVE,
  arms: CITY_LIVE.arms.map((a) => (a.slug === 'karachi' ? { ...a, enabled: false } : a)),
};

const FIXTURE = {
  config: {
    id: 1, mode: 'live',
    stake_per_buy_usd: '10.00', per_position_cap_usd: '25.00', per_market_cap_usd: '40.00',
    total_concurrent_cap_usd: '100.00', daily_loss_kill_usd: '30.00', daily_loss_kill_frac: '0.2500',
    city_allowlist: ['singapore', 'karachi'], active_until: '2026-07-31', updated_at: '2026-07-05T09:00:00Z',
  },
  preflight: {
    ok: false,
    reasons: ['no PASS forward paper gate (bot_gate_snapshot mode=paper/source=forward) and no ACTIVE trade_gate_override row'],
    checks: {
      mode: 'live', activeUntil: '2026-07-31',
      stakePerBuyUsd: '10.00', perPositionCapUsd: '25.00', perMarketCapUsd: '40.00', totalConcurrentCapUsd: '100.00',
      gatePass: false, override: true, overrideReason: 'first-N live review window', overrideExpiresAt: '2026-07-08T09:00:00Z',
      todayLossUsd: '18.00', lossWindowStart: '2026-07-05T00:00:00Z',
      dailyLossKillUsd: '30.00', dailyLossKillFracBasisUsd: '25.00',
      openExposureUsd: '20.00', perMarketExposureUsd: { '0xmarketAAA': '12.00', '0xmarketBBB': '8.00' },
    },
  },
  openOrders: [
    {
      id: 'ord-1', intent_key: 'k1', client_order_id: 'c1', order_id: 'venue-9', market_id: '0xmarketAAA',
      token_id: 'tok-yes', side: 'BUY', purpose: 'entry', order_type: 'GTC', price: '0.120', size: '100.0000',
      size_matched: '50.0000', avg_price: '0.118', trade_date: '2026-07-05', mode: 'live', status: 'partial',
      reason: null, created_at: '2026-07-05T08:30:00Z', placed_at: '2026-07-05T08:30:05Z', updated_at: '2026-07-05T08:45:00Z',
    },
  ],
  openExposureUsd: '20.00',
  today: { buyUsd: '20.00', sellUsd: '2.00', feeUsd: '0.00', netUsd: '-18.00', lossUsd: '18.00', lossWindowStart: '2026-07-05T00:00:00Z', nFills: 3 },
  dryRun: { openOrders: 4, total: 37 },
  recentAudit: [
    {
      id: 3,
      old_value: { mode: 'dry-run', stake_per_buy_usd: '10.00', total_concurrent_cap_usd: '100.00', daily_loss_kill_usd: '30.00' },
      new_value: { mode: 'live', stake_per_buy_usd: '10.00', total_concurrent_cap_usd: '100.00', daily_loss_kill_usd: '30.00' },
      changed_at: '2026-07-05T09:00:00Z', changed_by: 'service_role',
    },
  ],
  generatedAt: '2026-07-05T09:05:00Z',
};

describe('/trading page renders', () => {
  it('renders end-to-end with the populated LIVE fixture and surfaces every section', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({
      getTrading: async () => ({ kind: 'ok', view: FIXTURE }),
      getCityLive: async () => ({ kind: 'ok', view: CITY_LIVE }),
    }));
    const { default: TradingPage } = await import('../src/app/(dash)/trading/page.tsx');
    const html = renderToStaticMarkup(await TradingPage());

    // header + framing (NOT the not-applied banner)
    expect(html).toContain('Trading activation console');
    expect(html).not.toContain('0082 NOT APPLIED');

    // verdict banner: mode + interlock + a collected blocking reason (ASCII substrings — avoid em-dash mismatch)
    expect(html).toContain('MODE LIVE');
    expect(html).toContain('no live entries');
    expect(html).toContain('no PASS forward paper gate');

    // caps (from config)
    expect(html).toContain('Stake / buy');
    expect(html).toContain('Total concurrent cap');
    expect(html).toContain('$100'); // concurrent cap
    expect(html).toContain('2 cities'); // allowlist length
    expect(html).toContain('until 2026-07-31'); // run window

    // gate / override with expiry
    expect(html).toContain('Forward-paper gate');
    expect(html).toContain('no PASS');
    expect(html).toContain('Operator override');
    expect(html).toContain('first-N live review window');

    // daily-loss kill meter + today's cashflow (ASCII substrings — avoid apostrophe/minus/dot mismatch)
    expect(html).toContain('realized loss');
    expect(html).toContain('$18.00'); // today's realized loss
    expect(html).toContain('72%'); // 18 / min(30,25)=25 = 0.72
    expect(html).toContain('net cashflow');
    expect(html).toContain('no per-fill rows in this payload');

    // open positions from the checks payload + the open-order ledger
    expect(html).toContain('Open LIVE exposure');
    expect(html).toContain('0xmarketAAA');
    expect(html).toContain('$12.00'); // per-market exposure
    expect(html).toContain('Open LIVE order ledger');
    expect(html).toContain('venue-9'); // order id
    expect(html).toContain('partial'); // status

    // dry-run counts + audit trail (ASCII substrings — avoid dot/arrow mismatch)
    expect(html).toContain('Dry-run shadow rail'); // h2
    expect(html).toContain('37'); // dry-run total
    expect(html).toContain('service_role'); // audit changed_by

    // (a) CITY-LIVE — the editable trade_config input table (section a)
    expect(html).toContain('Trade config control');
    expect(html).toContain('trade_config_set'); // the operator RPC named in the editor blurb
    expect(html).toContain('save 0 changes'); // the Save button, no pending edits at first render
    // 0094: the allowlist picker offers the FULL cities domain — London (never enrolled) is an option,
    // and enrolled cities are flagged in their label.
    expect(html).toContain('London');
    expect(html).toContain('Karachi · enrolled');

    // (b) CITY-LIVE — the winners board (section b): status badges + edge/nBets/nDays/rec-hour + the twin columns
    expect(html).toContain('Winners board'); // h2
    expect(html).toContain('front the winners');
    expect(html).toContain('karachi');
    expect(html).toContain('PROMOTED'); // status badge
    expect(html).toContain('maker twin'); // taker-vs-maker twin column header

    // (c) CITY-LIVE — the arms table (section c): the confirm-arming caption + the at-cap lockout (2 enabled)
    expect(html).toContain('City Live arms'); // h2
    expect(html).toContain('of real capital when the daemon runs live'); // the arming warning copy
    expect(html).toContain('2 cities already enabled'); // Amsterdam's toggle is disabled — the lockout title
  });

  it('renders the CLEAR verdict + KILL-TRIPPED meter branches', async () => {
    vi.resetModules();
    const HOT = {
      ...FIXTURE,
      preflight: {
        ok: true,
        reasons: [],
        checks: { ...FIXTURE.preflight.checks, gatePass: true, override: false, overrideReason: null, todayLossUsd: '26.00' },
      },
    };
    vi.doMock('../src/lib/loaders.ts', () => ({
      getTrading: async () => ({ kind: 'ok', view: HOT }),
      getCityLive: async () => ({ kind: 'ok', view: CITY_LIVE }),
    }));
    const { default: TradingPage } = await import('../src/app/(dash)/trading/page.tsx');
    const html = renderToStaticMarkup(await TradingPage());
    expect(html).toContain('interlock permits live entries'); // ok === true CLEAR verdict
    expect(html).toContain('KILL TRIPPED'); // 26 >= binding 25
    expect(html).toContain('PASS'); // gatePass true
  });

  it('renders the seeded-dark APPLIED-but-empty state without the not-applied banner', async () => {
    vi.resetModules();
    const EMPTY = {
      config: {
        id: 1, mode: 'off', stake_per_buy_usd: '10.00', per_position_cap_usd: '25.00', per_market_cap_usd: '40.00',
        total_concurrent_cap_usd: '100.00', daily_loss_kill_usd: '30.00', daily_loss_kill_frac: '0.2500',
        city_allowlist: null, active_until: null, updated_at: '2026-07-05T00:00:00Z',
      },
      preflight: {
        ok: false,
        reasons: ["mode is 'off' — not 'live'", 'active_until not set — the run window is off'],
        checks: {
          mode: 'off', activeUntil: null, stakePerBuyUsd: '10.00', perPositionCapUsd: '25.00', perMarketCapUsd: '40.00',
          totalConcurrentCapUsd: '100.00', gatePass: false, override: false, overrideReason: null, overrideExpiresAt: null,
          todayLossUsd: '0', lossWindowStart: '2026-07-05T00:00:00Z', dailyLossKillUsd: '30.00',
          dailyLossKillFracBasisUsd: '25.00', openExposureUsd: '0', perMarketExposureUsd: {},
        },
      },
      openOrders: [],
      openExposureUsd: '0',
      today: { buyUsd: '0', sellUsd: '0', feeUsd: '0', netUsd: '0', lossUsd: '0', lossWindowStart: '2026-07-05T00:00:00Z', nFills: 0 },
      dryRun: { openOrders: 0, total: 0 },
      recentAudit: [],
      generatedAt: '2026-07-05T00:00:00Z',
    };
    // 0082 applied (config off, empty) BUT 0085 not applied → the CITY-LIVE sections degrade INDEPENDENTLY.
    vi.doMock('../src/lib/loaders.ts', () => ({
      getTrading: async () => ({ kind: 'ok', view: EMPTY }),
      getCityLive: async () => ({ kind: 'not-applied' }),
    }));
    const { default: TradingPage } = await import('../src/app/(dash)/trading/page.tsx');
    const html = renderToStaticMarkup(await TradingPage());
    expect(html).toContain('MODE OFF');
    expect(html).not.toContain('0082 NOT APPLIED');
    expect(html).toContain('No open LIVE orders.');
    expect(html).toContain('No open LIVE positions.');
    expect(html).toContain('No config changes recorded.');
    // the config editor (0082) still renders; only the winners board + arms (0085) show the dark note.
    expect(html).toContain('Trade config control');
    expect(html).toContain('0085 NOT APPLIED');
    expect(html).toContain('City Live arms unlock when migration 0085 is applied');
  });

  it("renders the explicit \"0082 NOT APPLIED\" empty-state ONLY for { kind: 'not-applied' } (day-one state)", async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({
      getTrading: async () => ({ kind: 'not-applied' }),
      getCityLive: async () => ({ kind: 'not-applied' }),
    }));
    const { default: TradingPage } = await import('../src/app/(dash)/trading/page.tsx');
    const html = renderToStaticMarkup(await TradingPage());
    expect(html).toContain('Trading activation console');
    expect(html).toContain('0082 NOT APPLIED');
    expect(html).toContain('merged-dark, not applied');
    expect(html).toContain('dash_trading()');
  });

  it("#22: renders the DISTINCT RPC-error state for { kind: 'error' } — never the not-applied diagnosis", async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({
      getTrading: async () => ({ kind: 'error', message: 'rpc dash_trading failed: upstream request timeout' }),
      getCityLive: async () => ({ kind: 'error', message: 'unused — page early-returns on the 0082 error' }),
    }));
    const { default: TradingPage } = await import('../src/app/(dash)/trading/page.tsx');
    const html = renderToStaticMarkup(await TradingPage());
    expect(html).toContain('Trading activation console');
    expect(html).toContain('Console temporarily unavailable');
    expect(html).toContain('upstream request timeout'); // the error text is surfaced for the operator
    expect(html).not.toContain('0082 NOT APPLIED'); // the false diagnosis must be gone
    expect(html).not.toContain('merged-dark, not applied');
  });

  it('does NOT engage the arms lockout when fewer than 2 cities are enabled', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/loaders.ts', () => ({
      getTrading: async () => ({ kind: 'ok', view: FIXTURE }),
      getCityLive: async () => ({ kind: 'ok', view: CITY_LIVE_ONE }),
    }));
    const { default: TradingPage } = await import('../src/app/(dash)/trading/page.tsx');
    const html = renderToStaticMarkup(await TradingPage());
    expect(html).toContain('City Live arms'); // the section still renders
    expect(html).not.toContain('2 cities already enabled'); // only 1 enabled → toggles NOT locked
  });
});
