/**
 * google-paper-panel handler — unit tests over a scripted DbPort (the buy-table-tick test idiom; the SQL
 * surface is 0086/0103). Pins the 0103 INCREMENTAL replay: cached-resolved units are reused (no series
 * fetch), only open/uncached events are fetched (event-filtered v2) and replayed, newly-frozen units are
 * written back, gm events are excluded even when cached — and ANY index/cache failure falls back to the
 * LEGACY full-window path (v1 per city + buildGoogleView), because the panel must never die of cache.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGoogleReplayUnits,
  googleCfg,
  parseConfigRows,
  type GoogleEventReplay,
  type RawCaptureRow,
  type RawGooglePrediction,
} from '../../packages/core/src/index.ts';
import type { DbPort } from '../functions/_shared/db.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { googlePaperPanel, type GooglePaperPanelDeps } from '../functions/google-paper-panel/handler.ts';

const NOW = new Date('2026-07-17T10:00:00Z');
const TZ = 'Europe/Amsterdam';
const DATE = '2026-07-17';

// ─── fixtures (the core google-bucket-view test idiom, trimmed) ──────────────────────────────────────
const bucket = (idx: number, label: string, over: Record<string, unknown> = {}) => ({
  idx, label, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
  bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: 0.1,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});
const ladder = (center: Record<string, unknown> = {}) => [
  bucket(0, '14°C or below'), bucket(1, '15°C'), bucket(2, '16°C', center), bucket(3, '17°C'), bucket(4, '18°C or higher'),
];
const capRow = (eventId: string, city: string, capturedAt: string, age: number, center: Record<string, unknown> = {}): RawCaptureRow =>
  ({
    eventId, capturedAt, city, targetDate: DATE, tzName: TZ, createdAtGamma: null, resolvesAt: null,
    hoursSinceListing: age, peakMid: 0.1, isFlatOpen: true, houseSeeded: true, buckets: ladder(center),
    evVol24h: 5000, negRisk: true,
  }) as RawCaptureRow;
const gp = (eventId: string): RawGooglePrediction => ({ eventId, tmaxC: 16.4, unit: 'C', tz: TZ });

/** a take-profit event's series (enter execAsk 0.11 < the production askMax 0.12 → execBid 0.35 fires the TP). */
const seriesFor = (eventId: string, city: string): RawCaptureRow[] => [
  capRow(eventId, city, '2026-07-17T08:00:00.000Z', 0.2, { execAsk: 0.11, execBid: 0.1 }),
  capRow(eventId, city, '2026-07-17T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.35 }),
];

const CFG = googleCfg(['amsterdam']);
/** the gold cached unit for E1 — produced by the same engine, then jsonb-thawed like a cache read. */
const cachedUnitE1: GoogleEventReplay = JSON.parse(
  JSON.stringify(buildGoogleReplayUnits(seriesFor('E1', 'amsterdam'), [{ id: 'E1', winnerIdx: 2, gradingMismatch: false }], [gp('E1')], CFG)[0]!),
);

interface MockState {
  index?: Array<{ eventId: string; city: string; targetDate: string; resolved: boolean; gm: boolean }> | 'throw';
  cached?: GoogleEventReplay[] | 'throw';
  /** per-event series served by the v2 (event-filtered) inputs RPC. */
  seriesByEvent?: Record<string, { captures: RawCaptureRow[]; resolutions: unknown[]; google: unknown[] }>;
  /** the LEGACY full-city inputs (v1). */
  legacyInputs?: { captures: RawCaptureRow[]; resolutions: unknown[]; google: unknown[] };
  v2Throws?: boolean;
}

function makeMockDb(state: MockState) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const cacheWrites: unknown[] = [];
  const recorded: unknown[] = [];
  const db: DbPort & { calls: typeof calls; cacheWrites: typeof cacheWrites; recorded: typeof recorded } = {
    calls,
    cacheWrites,
    recorded,
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      calls.push({ fn, args });
      switch (fn) {
        case 'google_paper_event_index':
          if (state.index === 'throw') throw new Error('function public.google_paper_event_index does not exist');
          return [{ google_paper_event_index: { rows: state.index ?? [] } }] as unknown as T[];
        case 'google_replay_cache_read':
          if (state.cached === 'throw') throw new Error('function public.google_replay_cache_read does not exist');
          return [{ google_replay_cache_read: { rows: state.cached ?? [] } }] as unknown as T[];
        case 'google_paper_inputs_v2': {
          if (state.v2Throws) throw new Error('boom v2');
          const ids = (args['p_event_ids'] as string[]) ?? [];
          const merged = { captures: [] as RawCaptureRow[], resolutions: [] as unknown[], google: [] as unknown[] };
          for (const id of ids) {
            const s = state.seriesByEvent?.[id];
            if (!s) continue;
            merged.captures.push(...s.captures);
            merged.resolutions.push(...s.resolutions);
            merged.google.push(...s.google);
          }
          return [{ google_paper_inputs_v2: merged }] as unknown as T[];
        }
        case 'google_paper_inputs':
          return [{ google_paper_inputs: state.legacyInputs ?? { captures: [], resolutions: [], google: [] } }] as unknown as T[];
        case 'google_replay_cache_write':
          cacheWrites.push(args['p_rows']);
          return [{ google_replay_cache_write: (args['p_rows'] as unknown[]).length }] as unknown as T[];
        case 'record_google_paper':
          recorded.push(args['p_view']);
          return [{ record_google_paper: 7 }] as unknown as T[];
        default:
          throw new Error(`mock db: unexpected rpc '${fn}'`);
      }
    },
    async getConfigRows() {
      return [{ key: 'bot.cities', value: 'amsterdam' }];
    },
  };
  return db;
}

function harness(state: MockState) {
  const db = makeMockDb(state);
  const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const ctx: JobCtx = { db, config: parseConfigRows([]), log: (msg, extra) => logs.push({ msg, extra }), startedAt: NOW };
  const deps: GooglePaperPanelDeps = { now: NOW, retrySleep: async () => {} };
  return { db, logs, ctx, deps };
}

const callsOf = (db: { calls: Array<{ fn: string; args: Record<string, unknown> }> }, fn: string) =>
  db.calls.filter((c) => c.fn === fn);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('google-paper-panel — the 0103 incremental replay', () => {
  it('cached-resolved units are reused; only open/uncached events are fetched (event-filtered) + replayed; newly-frozen units are written back', async () => {
    // E1 resolved+cached · E2 resolved+UNcached (replays + freezes) · E3 open (replays every run).
    const h = harness({
      index: [
        { eventId: 'E1', city: 'amsterdam', targetDate: DATE, resolved: true, gm: false },
        { eventId: 'E2', city: 'amsterdam', targetDate: DATE, resolved: true, gm: false },
        { eventId: 'E3', city: 'amsterdam', targetDate: DATE, resolved: false, gm: false },
      ],
      cached: [cachedUnitE1],
      seriesByEvent: {
        E2: { captures: seriesFor('E2', 'amsterdam'), resolutions: [{ id: 'E2', winnerIdx: 2, gradingMismatch: false }], google: [gp('E2')] },
        E3: { captures: seriesFor('E3', 'amsterdam'), resolutions: [], google: [gp('E3')] },
      },
    });
    const stats = await googlePaperPanel(h.ctx, h.deps);

    expect(stats.incremental).toBe(true);
    expect(stats.cacheUnitsUsed).toBe(1);
    expect(stats.replayedEvents).toBe(2);
    // the legacy full-city RPC is never touched; v2 asked for exactly the two needy events
    expect(callsOf(h.db, 'google_paper_inputs')).toHaveLength(0);
    const v2 = callsOf(h.db, 'google_paper_inputs_v2');
    expect(v2).toHaveLength(1);
    expect((v2[0]!.args['p_event_ids'] as string[]).sort()).toEqual(['E2', 'E3']);
    // only E2 (resolved this run, non-gm) is frozen back
    expect(h.db.cacheWrites).toHaveLength(1);
    const written = h.db.cacheWrites[0] as GoogleEventReplay[];
    expect(written.map((u) => u.eventId)).toEqual(['E2']);
    // the recorded view folds all three events
    const view = h.db.recorded[0] as { nFreshEvents: number; entries: unknown[] };
    expect(view.nFreshEvents).toBe(3);
    expect(view.entries).toHaveLength(3);
    expect(stats.snapshotId).toBe(7);
  });

  it('a gm event is excluded from the fold even when a cached unit exists for it', async () => {
    const h = harness({
      index: [{ eventId: 'E1', city: 'amsterdam', targetDate: DATE, resolved: true, gm: true }],
      cached: [cachedUnitE1],
      seriesByEvent: {},
    });
    const stats = await googlePaperPanel(h.ctx, h.deps);
    expect(stats.incremental).toBe(true);
    expect(stats.cacheUnitsUsed).toBe(0);
    const view = h.db.recorded[0] as { nFreshEvents: number; entries: unknown[] };
    expect(view.nFreshEvents).toBe(0);
    expect(view.entries).toHaveLength(0);
    expect(h.db.cacheWrites).toHaveLength(0);
  });

  it('index RPC absent (pre-0103) → the LEGACY full path: v1 per city, buildGoogleView, still records', async () => {
    const h = harness({
      index: 'throw',
      legacyInputs: { captures: seriesFor('E9', 'amsterdam'), resolutions: [{ id: 'E9', winnerIdx: 2, gradingMismatch: false }], google: [gp('E9')] },
    });
    const stats = await googlePaperPanel(h.ctx, h.deps);
    expect(stats.incremental).toBe(false);
    expect(callsOf(h.db, 'google_paper_inputs')).toHaveLength(1); // one city in scope
    expect(callsOf(h.db, 'google_paper_inputs_v2')).toHaveLength(0);
    expect(callsOf(h.db, 'google_replay_cache_write')).toHaveLength(0);
    const view = h.db.recorded[0] as { nFreshEvents: number };
    expect(view.nFreshEvents).toBe(1);
    expect(stats.snapshotId).toBe(7);
  });

  it('cache read failing → legacy full path (the panel never dies of cache)', async () => {
    const h = harness({
      index: [{ eventId: 'E1', city: 'amsterdam', targetDate: DATE, resolved: true, gm: false }],
      cached: 'throw',
      legacyInputs: { captures: seriesFor('E1', 'amsterdam'), resolutions: [{ id: 'E1', winnerIdx: 2, gradingMismatch: false }], google: [gp('E1')] },
    });
    const stats = await googlePaperPanel(h.ctx, h.deps);
    expect(stats.incremental).toBe(false);
    expect(callsOf(h.db, 'google_paper_inputs')).toHaveLength(1);
    expect(stats.snapshotId).toBe(7);
  });

  it('a failed v2 city fetch degrades to a partial view (cityErrors), cached units still fold', async () => {
    const h = harness({
      index: [
        { eventId: 'E1', city: 'amsterdam', targetDate: DATE, resolved: true, gm: false },
        { eventId: 'E3', city: 'amsterdam', targetDate: DATE, resolved: false, gm: false },
      ],
      cached: [cachedUnitE1],
      v2Throws: true,
    });
    const stats = await googlePaperPanel(h.ctx, h.deps);
    expect(stats.incremental).toBe(true);
    expect(stats.cityErrors).toBe(1);
    expect(stats.cacheUnitsUsed).toBe(1);
    expect(stats.replayedEvents).toBe(0);
    const view = h.db.recorded[0] as { nFreshEvents: number; cityErrors: number };
    expect(view.nFreshEvents).toBe(1); // the cached unit alone
    expect(view.cityErrors).toBe(1);
  });
});
