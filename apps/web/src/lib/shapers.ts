/**
 * Pure data shapers for the calibration views (§6.21; §15 "reliability
 * diagram + heatmap match calibration_scores fixtures"). No IO, no React —
 * unit-tested against the same rows the dash_* RPCs return.
 */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// --- Reliability diagram -----------------------------------------------------

export interface ReliabilityPoint {
  /** Predicted-probability bin center. */
  x: number;
  /** Observed hit rate (n-weighted across contributing score rows). */
  y: number;
  /** Total events behind the point. */
  n: number;
}

/**
 * Merge the stored `reliability` jsonb payloads ([{bin, hit, n}] per
 * calibration_scores row, §6.6 reliabilityBins) across rows — n-weighted
 * mean hit rate per bin. Rows without payloads and empty/zero-n bins are
 * skipped.
 */
export function shapeReliability(rows: { reliability: unknown }[]): ReliabilityPoint[] {
  const acc = new Map<number, { hitWeighted: number; n: number }>();
  for (const row of rows) {
    if (!Array.isArray(row.reliability)) continue;
    for (const raw of row.reliability as { bin?: unknown; hit?: unknown; n?: unknown }[]) {
      const bin = num(raw.bin);
      const hit = num(raw.hit);
      const count = num(raw.n) ?? 0;
      if (bin === null || hit === null || count <= 0) continue;
      const cur = acc.get(bin) ?? { hitWeighted: 0, n: 0 };
      cur.hitWeighted += hit * count;
      cur.n += count;
      acc.set(bin, cur);
    }
  }
  return [...acc.entries()]
    .map(([x, v]) => ({ x, y: v.hitWeighted / v.n, n: v.n }))
    .sort((a, b) => a.x - b.x);
}

// --- Calibration heatmap (city × model × lead) --------------------------------

export interface HeatmapRow {
  model: string;
  lead: number;
  slot: string;
  bias: unknown;
  sigma: unknown;
  n: unknown;
  weight: unknown;
}

export interface HeatmapCell {
  bias: number | null;
  sigma: number | null;
  n: number;
  weight: number | null;
}

export interface HeatmapGrid {
  slot: string;
  models: string[];
  leads: number[];
  /** Lookup key `${model}|${lead}` — serializable across the RSC boundary. */
  cells: Record<string, HeatmapCell>;
}

export const heatmapKey = (model: string, lead: number): string => `${model}|${lead}`;

/** model_stats rows (dash_city_detail.calibrationHeatmap) → one slot's grid. */
export function shapeHeatmap(rows: HeatmapRow[], slot: '10Z' | '22Z'): HeatmapGrid {
  const models = new Set<string>();
  const leads = new Set<number>();
  const cells: Record<string, HeatmapCell> = {};
  for (const r of rows) {
    if (r.slot !== slot) continue;
    const lead = Number(r.lead);
    models.add(r.model);
    leads.add(lead);
    cells[heatmapKey(r.model, lead)] = {
      bias: num(r.bias),
      sigma: num(r.sigma),
      n: num(r.n) ?? 0,
      weight: num(r.weight),
    };
  }
  return {
    slot,
    models: [...models].sort(),
    leads: [...leads].sort((a, b) => a - b),
    cells,
  };
}
