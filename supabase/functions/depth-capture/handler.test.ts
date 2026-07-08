/**
 * Tests for depth-capture/handler — the DB-read-driven → CLOB-walk → market_snapshots.depth flow.
 * Node/vitest; stubs the DbPort (depth_capture_targets read + record_depth_captures write) and fetchJson (CLOB
 * /book). The exec-price math itself is owned by core/edge.test.ts (executableAsk/executableBid); these assert the
 * WIRING: correct bucket_id carry, computed depth shape, best-effort skip of an unfetchable book, empty-tick safety.
 */
import { describe, expect, it, vi } from 'vitest';
import { depthCapture, type DepthCaptureDeps } from './handler.ts';
import type { JobCtx } from '../_shared/runJob.ts';

/** Build a raw CLOB book from best-first levels (normalizeBook reverses raw → best-first, so we un-reverse here). */
function rawBook(
  asks: Array<[number, number]>,
  bids: Array<[number, number]>,
): { asks: { price: string; size: string }[]; bids: { price: string; size: string }[] } {
  return {
    asks: [...asks].reverse().map(([price, size]) => ({ price: String(price), size: String(size) })),
    bids: [...bids].reverse().map(([price, size]) => ({ price: String(price), size: String(size) })),
  };
}

const TARGETS = [
  { bucket_id: 'b1', token_yes: 't1', event_id: 'e1', city_slug: 'nyc', target_date: '2026-07-08', first_seen: '2026-07-08T08:00:00Z' },
  { bucket_id: 'b2', token_yes: 't2', event_id: 'e1', city_slug: 'nyc', target_date: '2026-07-08', first_seen: '2026-07-08T08:00:00Z' },
];

/** A deep book: best ask 0.11×2000 fills a $20 (~182-share) buy entirely → execAsk 0.11; best bid 0.10×2000 → execBid 0.10. */
const DEEP = rawBook([[0.11, 2000], [0.12, 1000]], [[0.1, 2000], [0.09, 500]]);

function makeCtx(opts: {
  targets?: typeof TARGETS;
  books?: Record<string, ReturnType<typeof rawBook>>;
  throwToken?: string;
}): { ctx: JobCtx; deps: DepthCaptureDeps; recorded: () => Record<string, unknown> | null } {
  let recordedArgs: Record<string, unknown> | null = null;
  const db = {
    getConfigRows: async () => [] as { key: string; value: string }[],
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'depth_capture_targets') return (opts.targets ?? TARGETS) as unknown[];
      if (fn === 'record_depth_captures') {
        recordedArgs = args;
        return [{ record_depth_captures: (args.p_rows as unknown[]).length }] as unknown[];
      }
      return [] as unknown[];
    },
  };
  const fetchJson = vi.fn(async (url: string) => {
    const token = new URL(url).searchParams.get('token_id') ?? '';
    if (token === opts.throwToken) throw new Error('book unavailable');
    return (opts.books?.[token] ?? DEEP) as unknown;
  });
  const ctx = { db, config: {}, log: () => {}, startedAt: new Date('2026-07-08T08:42:00Z') } as unknown as JobCtx;
  const deps: DepthCaptureDeps = { now: new Date('2026-07-08T08:42:00Z'), fetchJson };
  return { ctx, deps, recorded: () => recordedArgs };
}

describe('depthCapture', () => {
  it('walks every target book and writes rows carrying bucket_id + computed depth', async () => {
    const { ctx, deps, recorded } = makeCtx({});
    const stats = await depthCapture(ctx, deps);

    expect(stats.targets).toBe(2);
    expect(stats.walked).toBe(2);
    expect(stats.inserted).toBe(2);

    const args = recorded()!;
    expect(args.p_captured_at).toBe('2026-07-08T08:42:00.000Z');
    const rows = args.p_rows as Array<{
      bucket_id: string; best_bid: number; best_ask: number; mid: number; spread: number;
      depth: { execAsk: number | null; execBid: number | null; depthUsd: number };
    }>;
    expect(rows.map((r) => r.bucket_id).sort()).toEqual(['b1', 'b2']);
    const r = rows[0]!;
    expect(r.best_ask).toBeCloseTo(0.11, 6);
    expect(r.best_bid).toBeCloseTo(0.1, 6);
    expect(r.mid).toBeCloseTo(0.105, 6);
    expect(r.spread).toBeCloseTo(0.01, 6);
    // a $20 buy (~182 shares) fills entirely at the 2000-share best level → execAsk == best ask.
    expect(r.depth.execAsk).toBeCloseTo(0.11, 6);
    expect(r.depth.execBid).toBeCloseTo(0.1, 6);
    expect(r.depth.depthUsd).toBeGreaterThan(0);
  });

  it('skips an unfetchable book (best-effort) without failing the tick', async () => {
    const { ctx, deps, recorded } = makeCtx({ throwToken: 't2' });
    const stats = await depthCapture(ctx, deps);
    expect(stats.targets).toBe(2);
    expect(stats.walked).toBe(1);
    const rows = recorded()!.p_rows as Array<{ bucket_id: string }>;
    expect(rows.map((r) => r.bucket_id)).toEqual(['b1']);
  });

  it('does not write when there are no targets', async () => {
    const { ctx, deps, recorded } = makeCtx({ targets: [] });
    const stats = await depthCapture(ctx, deps);
    expect(stats.targets).toBe(0);
    expect(stats.walked).toBe(0);
    expect(recorded()).toBeNull();
  });
});
