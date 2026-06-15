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

// --- Forecast-skill summary (analytics landing, the house-vs-market headline) -----

export interface SkillScoreRow {
  source: string;
  /** null = the pooled gate row; excluded from the across-stations aggregate to avoid double-counting. */
  city: string | null;
  brier: unknown;
  brierMarket: unknown;
  ece: unknown;
  sharpness: unknown;
  n: unknown;
}

export interface ForecastSkillSummary {
  champion: string;
  /** comparable per-city cells with both our brier and the market brier present */
  nCells: number;
  /** scored station-days behind those cells (Σ n) */
  totalN: number;
  meanBrier: number | null;
  meanBrierMarket: number | null;
  /** (market − ours)/market, n-weighted; >0 ⇒ we beat the market, <0 ⇒ the market beats us */
  skillVsMarket: number | null;
  /** share of comparable cells where our brier < the market's (0..1) */
  beatRate: number | null;
  meanEce: number | null;
  meanSharpness: number | null;
}

/**
 * Aggregate the champion source's calibration scores into the one headline the analytics product leads
 * with: are we more accurate than the market? n-weighted over per-city cells (pooled rows excluded so they
 * don't double-count). `skillVsMarket ≤ 0` is the measured-efficiency finding — we do NOT beat the market.
 */
export function summarizeForecastSkill(rows: SkillScoreRow[], champion: string): ForecastSkillSummary {
  let wBrier = 0;
  let wMarket = 0;
  let wEce = 0;
  let wSharp = 0;
  let nEce = 0;
  let nSharp = 0;
  let totalN = 0;
  let nCells = 0;
  let beats = 0;
  for (const r of rows) {
    if (r.source !== champion || r.city === null) continue;
    const b = num(r.brier);
    const m = num(r.brierMarket);
    const cnt = num(r.n) ?? 0;
    if (b === null || m === null || cnt <= 0) continue;
    nCells++;
    totalN += cnt;
    wBrier += b * cnt;
    wMarket += m * cnt;
    if (b < m) beats++;
    const e = num(r.ece);
    if (e !== null) {
      wEce += e * cnt;
      nEce += cnt;
    }
    const s = num(r.sharpness);
    if (s !== null) {
      wSharp += s * cnt;
      nSharp += cnt;
    }
  }
  const meanBrier = totalN > 0 ? wBrier / totalN : null;
  const meanBrierMarket = totalN > 0 ? wMarket / totalN : null;
  return {
    champion,
    nCells,
    totalN,
    meanBrier,
    meanBrierMarket,
    skillVsMarket:
      meanBrier !== null && meanBrierMarket !== null && meanBrierMarket !== 0
        ? (meanBrierMarket - meanBrier) / meanBrierMarket
        : null,
    beatRate: nCells > 0 ? beats / nCells : null,
    meanEce: nEce > 0 ? wEce / nEce : null,
    meanSharpness: nSharp > 0 ? wSharp / nSharp : null,
  };
}

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
