/**
 * Tests for depth-capture/handler — the DB-read-driven → CLOB-walk → market_depth write flow (v2).
 * Node/vitest; stubs the DbPort (market_depth_targets read + record_market_depth write) and fetchJson (CLOB /book).
 * The exec-price math + the two-sided/delta gates are owned by pure.test.ts; these assert the WIRING: bucket_id
 * carry, honest stats, best-effort skip, the delta-dedupe short-circuit, cap logging, the wall-clock budget +
 * incremental flush, and the throw-on-total-write-failure (finding B — never silently report ok).
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

type Target = {
  bucket_id: string; token_yes: string; event_id: string; city_slug: string; target_date: string;
  first_seen: string | null; last_exec_ask: number | null; last_exec_bid: number | null;
  last_captured_at: string | null; total_candidates: number;
};

/** Two fresh targets (no prior depth row → always write), same event, total_candidates == 2 (no cap). */
function freshTargets(n = 2, total = n): Target[] {
  return Array.from({ length: n }, (_, i) => ({
    bucket_id: `b${i + 1}`, token_yes: `t${i + 1}`, event_id: 'e1', city_slug: 'nyc', target_date: '2026-07-08',
    first_seen: '2026-07-08T08:00:00Z', last_exec_ask: null, last_exec_bid: null, last_captured_at: null,
    total_candidates: total,
  }));
}

/** A deep book: best ask 0.11×2000 fills a $20 (~182-share) buy → execAsk 0.11; best bid 0.10×2000 → execBid 0.10. */
const DEEP = rawBook([[0.11, 2000], [0.12, 1000]], [[0.1, 2000], [0.09, 500]]);

interface RecordedCall {
  p_rows: Array<Record<string, unknown>>;
  p_captured_at: string;
}

function makeCtx(opts: {
  targets?: Target[];
  books?: Record<string, ReturnType<typeof rawBook>>;
  throwToken?: string;
  recordThrows?: boolean;
  clock?: () => number;
} = {}): {
  ctx: JobCtx;
  deps: DepthCaptureDeps;
  recorded: () => RecordedCall[];
  logs: () => Array<{ msg: string; extra?: Record<string, unknown> }>;
} {
  const calls: RecordedCall[] = [];
  const logLines: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const db = {
    getConfigRows: async () => [] as { key: string; value: string }[],
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'market_depth_targets') return (opts.targets ?? freshTargets()) as unknown[];
      if (fn === 'record_market_depth') {
        if (opts.recordThrows) throw new Error('statement timeout');
        const rows = args.p_rows as Array<Record<string, unknown>>;
        calls.push({ p_rows: rows, p_captured_at: args.p_captured_at as string });
        return [{ record_market_depth: rows.length }] as unknown[];
      }
      return [] as unknown[];
    },
  };
  const fetchJson = vi.fn(async (url: string) => {
    const token = new URL(url).searchParams.get('token_id') ?? '';
    if (token === opts.throwToken) throw new Error('book unavailable');
    return (opts.books?.[token] ?? DEEP) as unknown;
  });
  const ctx = {
    db, config: {},
    log: (msg: string, extra?: Record<string, unknown>) => logLines.push({ msg, extra }),
    startedAt: new Date('2026-07-08T08:42:00Z'),
  } as unknown as JobCtx;
  // constant clock → elapsed 0 → the wall-clock budget never trips (deterministic; the budget test overrides it).
  const deps: DepthCaptureDeps = { now: new Date('2026-07-08T08:42:00Z'), fetchJson, clock: opts.clock ?? (() => 0) };
  return { ctx, deps, recorded: () => calls, logs: () => logLines };
}

describe('depthCapture (v2)', () => {
  it('walks every target book and writes rows carrying bucket_id + flat depth columns', async () => {
    const { ctx, deps, recorded } = makeCtx();
    const stats = await depthCapture(ctx, deps);

    expect(stats.targets).toBe(2);
    expect(stats.fetched).toBe(2);
    expect(stats.written).toBe(2);
    expect(stats.inserted).toBe(2);
    expect(stats.oneSided).toBe(0);
    expect(stats.deduped).toBe(0);
    expect(stats.capped).toBe(false);
    // finding H: the walk size is the panel's replay stake (GOOGLE_DEFAULTS.perPositionUsd = 20), not the bot's.
    expect(stats.perPositionUsd).toBe(20);

    const calls = recorded();
    expect(calls.length).toBe(1);
    expect(calls[0]!.p_captured_at).toBe('2026-07-08T08:42:00.000Z');
    const rows = calls[0]!.p_rows as Array<{
      bucket_id: string; best_bid: number; best_ask: number; mid: number; spread: number;
      exec_ask: number | null; exec_bid: number | null; depth_usd: number;
      sellback_depth_usd: number; sellback_usd: number;
    }>;
    expect(rows.map((r) => r.bucket_id).sort()).toEqual(['b1', 'b2']);
    const r = rows[0]!;
    // the row's keys are the flat snake_case market_depth columns (the record_market_depth recordset contract).
    expect(Object.keys(r).sort()).toEqual([
      'best_ask', 'best_bid', 'bucket_id', 'depth_usd', 'exec_ask', 'exec_bid', 'mid', 'sellback_depth_usd',
      'sellback_usd', 'spread',
    ]);
    expect(r.best_ask).toBeCloseTo(0.11, 6);
    expect(r.exec_ask!).toBeCloseTo(0.11, 6);
    expect(r.exec_bid!).toBeCloseTo(0.1, 6);
  });

  it('skips an unfetchable book (best-effort) without failing the tick', async () => {
    const { ctx, deps, recorded } = makeCtx({ throwToken: 't2' });
    const stats = await depthCapture(ctx, deps);
    expect(stats.targets).toBe(2);
    expect(stats.fetched).toBe(1); // t2 fetch threw → not counted as fetched
    expect(stats.written).toBe(1);
    const rows = recorded()[0]!.p_rows as Array<{ bucket_id: string }>;
    expect(rows.map((r) => r.bucket_id)).toEqual(['b1']);
  });

  it('does not write an asks-only (one-sided) book — no exit-less entry (finding E)', async () => {
    const { ctx, deps, recorded } = makeCtx({ books: { t2: rawBook([[0.11, 100]], []) } });
    const stats = await depthCapture(ctx, deps);
    expect(stats.fetched).toBe(2);
    expect(stats.oneSided).toBe(1);
    expect(stats.written).toBe(1);
    expect(recorded()[0]!.p_rows.map((r) => r.bucket_id)).toEqual(['b1']); // t1 (DEEP) only
  });

  it('delta-dedupes an unchanged bucket within the heartbeat (finding C)', async () => {
    // b1: last depth equals the DEEP walk (execAsk 0.11 / execBid 0.10) captured 1 min ago → deduped.
    // b2: fresh (no prior row) → written.
    const targets = freshTargets(2);
    targets[0] = {
      ...targets[0]!, last_exec_ask: 0.11, last_exec_bid: 0.1,
      last_captured_at: new Date(new Date('2026-07-08T08:42:00Z').getTime() - 60_000).toISOString(),
    };
    const { ctx, deps, recorded } = makeCtx({ targets });
    const stats = await depthCapture(ctx, deps);
    expect(stats.fetched).toBe(2);
    expect(stats.deduped).toBe(1);
    expect(stats.written).toBe(1);
    expect(recorded()[0]!.p_rows.map((r) => r.bucket_id)).toEqual(['b2']);
  });

  it('does not write when there are no targets', async () => {
    const { ctx, deps, recorded } = makeCtx({ targets: [] });
    const stats = await depthCapture(ctx, deps);
    expect(stats.targets).toBe(0);
    expect(stats.fetched).toBe(0);
    expect(recorded().length).toBe(0);
  });

  it('flags + logs a target-cap truncation (finding C)', async () => {
    // total_candidates 900 but only 2 rows returned → capped.
    const { ctx, deps, logs } = makeCtx({ targets: freshTargets(2, 900) });
    const stats = await depthCapture(ctx, deps);
    expect(stats.capped).toBe(true);
    expect(stats.totalCandidates).toBe(900);
    expect(logs().some((l) => l.msg.includes('CAPPED'))).toBe(true);
  });

  it('flushes incrementally across walk chunks (many targets → multiple write calls)', async () => {
    const { ctx, deps, recorded } = makeCtx({ targets: freshTargets(130) }); // > WALK_CHUNK (60) → 3 chunks
    const stats = await depthCapture(ctx, deps);
    expect(stats.written).toBe(130);
    expect(stats.inserted).toBe(130);
    expect(recorded().length).toBeGreaterThan(1); // incremental flush, not one terminal write
  });

  it('honors the wall-clock budget and persists the partial walk (findings B/D)', async () => {
    // clock: startMs + chunk-1 check both under budget; chunk-2 check over budget → break after 1 chunk.
    let n = 0;
    const clock = () => { const seq = [0, 0, 999_999_999]; return seq[Math.min(n++, seq.length - 1)]!; };
    const { ctx, deps, recorded } = makeCtx({ targets: freshTargets(130), clock });
    const stats = await depthCapture(ctx, deps);
    expect(stats.budgetHit).toBe(true);
    expect(stats.written).toBe(60);   // only the first walk chunk
    expect(recorded().length).toBe(1); // its flush persisted (partial depth, not a lost tick)
    expect(stats.inserted).toBe(60);
  });

  it('THROWS on a total write failure — never silently reports ok (finding B)', async () => {
    const { ctx, deps } = makeCtx({ recordThrows: true });
    await expect(depthCapture(ctx, deps)).rejects.toThrow(/wrote 0 of/);
  });
});
