/**
 * Pure UI data-layer units (§6.21): the reliability/heatmap shapers (§15
 * "match calibration_scores fixtures" — the PGlite twin in ui-data.test.ts
 * drives the same shapers through the real RPCs), the latest-hour selector
 * for stored edge evaluations, and the format helpers.
 */
import { describe, expect, it } from 'vitest';
import { latestEdgeEvalRows, type StoredEdgeEval } from '../src/lib/edge-display.ts';
import { fmtAgo, fmtDate, fmtDateTime, fmtPct, fmtProb, fmtUsd, num } from '../src/lib/format.ts';
import { heatmapKey, shapeHeatmap, shapeReliability } from '../src/lib/shapers.ts';

describe('shapeReliability (§6.6 reliability payloads)', () => {
  it('n-weighted merge across rows; bins sorted; junk skipped', () => {
    const points = shapeReliability([
      { reliability: [{ bin: 0.3, hit: 0.2, n: 10 }, { bin: 0.5, hit: 0.5, n: 30 }] },
      { reliability: [{ bin: 0.5, hit: 0.6, n: 10 }] },
      { reliability: null },                                  // pooled rows carry no payload
      { reliability: [{ bin: 0.7, hit: 0.8, n: 0 }] },        // zero-n bin contributes nothing
      { reliability: [{ bin: 'x', hit: 0.5, n: 5 }] },        // malformed bin skipped
    ]);
    expect(points).toEqual([
      { x: 0.3, y: 0.2, n: 10 },
      { x: 0.5, y: (0.5 * 30 + 0.6 * 10) / 40, n: 40 },
    ]);
  });

  it('numeric-string payload values (PostgREST jsonb) coerce', () => {
    expect(shapeReliability([{ reliability: [{ bin: '0.5', hit: '0.52', n: '40' }] }])).toEqual([
      { x: 0.5, y: 0.52, n: 40 },
    ]);
  });

  it('empty input → empty diagram', () => {
    expect(shapeReliability([])).toEqual([]);
  });
});

describe('shapeHeatmap (model_stats grid)', () => {
  const rows = [
    { model: 'gfs_seamless', lead: 1, slot: '10Z', bias: '0.50', sigma: '1.20', n: '40', weight: '0.60000' },
    { model: 'gfs_seamless', lead: 3, slot: '10Z', bias: '-0.20', sigma: '1.80', n: '35', weight: '0.40000' },
    { model: 'ecmwf_ifs025', lead: 1, slot: '10Z', bias: null, sigma: null, n: null, weight: null },
    { model: 'gfs_seamless', lead: 1, slot: '22Z', bias: '0.10', sigma: '1.00', n: '12', weight: '1.00000' },
  ];

  it('filters by slot, sorts axes, coerces numerics', () => {
    const grid = shapeHeatmap(rows, '10Z');
    expect(grid.models).toEqual(['ecmwf_ifs025', 'gfs_seamless']);
    expect(grid.leads).toEqual([1, 3]);
    expect(grid.cells[heatmapKey('gfs_seamless', 1)]).toEqual({ bias: 0.5, sigma: 1.2, n: 40, weight: 0.6 });
    expect(grid.cells[heatmapKey('gfs_seamless', 3)]).toEqual({ bias: -0.2, sigma: 1.8, n: 35, weight: 0.4 });
    expect(grid.cells[heatmapKey('ecmwf_ifs025', 1)]).toEqual({ bias: null, sigma: null, n: 0, weight: null });
    expect(grid.cells[heatmapKey('ecmwf_ifs025', 3)]).toBeUndefined(); // missing cell
  });

  it('the other slot is a separate grid (W3)', () => {
    const grid = shapeHeatmap(rows, '22Z');
    expect(grid.models).toEqual(['gfs_seamless']);
    expect(grid.leads).toEqual([1]);
    expect(grid.cells[heatmapKey('gfs_seamless', 1)]!.sigma).toBe(1.0);
  });
});

describe('latestEdgeEvalRows (F-038 stored hours)', () => {
  const row = (bucketIdx: number, hour: string, q: number): StoredEdgeEval => ({
    bucketIdx, hour, q, execAsk: 0.3, edge: 0.1, minEdge: 0.05, pass: true, reasons: [],
  });

  it('keeps only the newest captured hour, keyed by bucket', () => {
    const m = latestEdgeEvalRows([
      row(5, '2026-06-11T11:00:00Z', 0.5),
      row(5, '2026-06-11T12:00:00Z', 0.55),
      row(6, '2026-06-11T12:00:00Z', 0.2),
      row(6, '2026-06-11T11:00:00Z', 0.19),
    ]);
    expect(m.size).toBe(2);
    expect(m.get(5)!.q).toBe(0.55);
    expect(m.get(6)!.q).toBe(0.2);
  });

  it('empty/null input → empty map', () => {
    expect(latestEdgeEvalRows(null).size).toBe(0);
    expect(latestEdgeEvalRows([]).size).toBe(0);
  });
});

describe('format helpers', () => {
  it('num coerces strings and rejects junk', () => {
    expect(num('0.27')).toBe(0.27);
    expect(num(3)).toBe(3);
    expect(num(null)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
  });

  it('money/percent/probability', () => {
    expect(fmtUsd(1043.214)).toBe('$1,043.21');
    expect(fmtUsd(-5)).toBe('-$5.00');
    expect(fmtUsd(null)).toBe('—');
    expect(fmtPct(0.02)).toBe('2.00%');
    expect(fmtProb('0.55')).toBe('0.550');
  });

  it('dates and ages', () => {
    expect(fmtDate('2026-06-11T12:00:00Z')).toBe('2026-06-11');
    expect(fmtDateTime('2026-06-11T12:03:00Z')).toBe('06-11 12:03Z');
    const now = new Date('2026-06-11T12:00:00Z');
    expect(fmtAgo('2026-06-11T11:48:00Z', now)).toBe('12m ago');
    expect(fmtAgo('2026-06-11T07:48:00Z', now)).toBe('4h 12m ago');
    expect(fmtAgo('2026-06-08T12:00:00Z', now)).toBe('3d ago');
    expect(fmtAgo(null, now)).toBe('—');
  });
});
