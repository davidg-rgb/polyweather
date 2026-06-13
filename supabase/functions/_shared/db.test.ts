import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../../packages/core/src/index.ts';
import { supabasePort } from './db.ts';

/** Minimal supabase-js-shaped client returning a canned PostgREST payload. */
const clientReturning = (data: unknown, error: { message: string } | null = null) => ({
  rpc: (_fn: string, _args: Record<string, unknown>) => Promise.resolve({ data, error }),
  from: (_table: string) => ({
    select: (_cols: string) => Promise.resolve({ data, error }),
  }),
});

describe('supabasePort rpc normalization (PostgREST → PGlite-twin row shape)', () => {
  it('wraps a bare scalar as [{ [fn]: value }] — boolean false survives', async () => {
    const port = supabasePort(clientReturning(false));
    expect(await port.rpc('claim_event_winner', {})).toEqual([{ claim_event_winner: false }]);
  });

  it('wraps a bare jsonb object as [{ [fn]: object }]', async () => {
    const ctx = { event: { id: 'e1' }, buckets: [1, 2, 3] };
    const port = supabasePort(clientReturning(ctx));
    const [row] = await port.rpc<{ get_grading_context: typeof ctx }>('get_grading_context', {});
    expect(row?.get_grading_context).toEqual(ctx);
  });

  it('passes a RETURNS TABLE row set through unchanged', async () => {
    const rows = [
      { icao: 'KORD', tz: 'America/Chicago' },
      { icao: 'RKSI', tz: 'Asia/Seoul' },
    ];
    const port = supabasePort(clientReturning(rows));
    expect(await port.rpc('list_truth_stations', {})).toEqual(rows);
  });

  it('maps a null result (scalar fn returning NULL / void) to zero rows', async () => {
    const port = supabasePort(clientReturning(null));
    const [row] = await port.rpc<{ bet_for_execution: unknown }>('bet_for_execution', {});
    expect(row?.bet_for_execution).toBeUndefined();
  });

  it('throws ConfigError naming the fn on a PostgREST error', async () => {
    const port = supabasePort(clientReturning(null, { message: 'permission denied' }));
    await expect(port.rpc('digest_data', {})).rejects.toThrow(ConfigError);
    await expect(port.rpc('digest_data', {})).rejects.toThrow(/digest_data.*permission denied/);
  });

  it('getConfigRows returns the row array and [] for null', async () => {
    const rows = [{ key: 'tradingMode', value: 'paper' }];
    expect(await supabasePort(clientReturning(rows)).getConfigRows()).toEqual(rows);
    expect(await supabasePort(clientReturning(null)).getConfigRows()).toEqual([]);
  });
});

// C2 (ADR-19) — on the fabricated-empty branch the wrapper records WHETHER
// PostgREST sent null (no rows over the wire) vs [] (an empty SETOF), so one
// hosted fire of the #2 capture defect pins the mechanism. The null→[]
// normalization itself is unchanged (covered above); this is purely the new line.
describe('supabasePort rpc — C2 empty-result diagnostic (ADR-19)', () => {
  let logs: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => {
      logs.push(String(s));
    });
  });
  afterEach(() => spy.mockRestore());
  const diag = () => logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => o['empty'] === true);

  it('null (no rows over the wire) logs dataWasNull:true', async () => {
    await supabasePort(clientReturning(null)).rpc('list_active_stations', {});
    expect(diag()).toMatchObject({ rpc: 'list_active_stations', empty: true, dataWasNull: true });
  });

  it('[] (empty SETOF) logs dataWasNull:false', async () => {
    await supabasePort(clientReturning([])).rpc('list_active_stations', {});
    expect(diag()).toMatchObject({ rpc: 'list_active_stations', empty: true, dataWasNull: false });
  });

  it('a non-empty SETOF and a bare scalar emit NO diagnostic line', async () => {
    await supabasePort(clientReturning([{ icao: 'RKSI' }])).rpc('list_active_stations', {});
    await supabasePort(clientReturning(7)).rpc('some_scalar_fn', {});
    expect(diag()).toBeUndefined();
  });
});
