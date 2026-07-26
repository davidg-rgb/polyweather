/**
 * packages/core/sim/resolution-risk — AUTO-GENERATED. Do not edit by hand.
 *
 * Per-city RESOLUTION-RISK snapshot (CITY-ORACLE-BUILDOUT Build 2): how often the stored WU grading
 * truth (observations.tmax_wu_native — ADR-04: never re-derived in grading) disagrees with a faithful
 * METAR/SPECI replica of the resolution oracle (IEM archive, the validated §resolution-oracle
 * rendering), over the trailing ~90-day window. resolutionRisk = 1 − matchRate. A nonzero number means
 * the market's resolution source and the disseminated METAR stream can diverge for that city
 * (station identity quirks / WU revision timing) — an analytics trust signal, NOT a grading input.
 *
 * REGENERATE:
 *   pnpm tsx scripts/research/truth-replica-crosscheck.ts --emit packages/core/src/sim/resolution-risk.ts
 */

export interface CityResolutionRisk {
  slug: string;
  icao: string;
  /** Truth days compared. */
  n: number;
  /** Share of days the METAR replica max equals the stored WU value (4 dp). */
  matchRate: number;
  /** 1 − matchRate — the headline per-city resolution-risk. */
  resolutionRisk: number;
  /** Mean signed replica − WU over mismatched days (+ = replica reads higher), null when no mismatch. */
  meanSignedDiff: number | null;
}

export interface ResolutionRiskAsset {
  source: string;
  /** [from, to] date_local window of the underlying truth pull. */
  window: [string, string];
  cities: CityResolutionRisk[];
}

export const RESOLUTION_RISK: ResolutionRiskAsset = {
  source: 'wu-vs-iem-metar-90d',
  window: ["2026-04-21","2026-07-25"],
  cities: [
    {"slug":"amsterdam","icao":"EHAM","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"ankara","icao":"LTAC","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"atlanta","icao":"KATL","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"austin","icao":"KAUS","n":95,"matchRate":0.9579,"resolutionRisk":0.0421,"meanSignedDiff":1},
    {"slug":"beijing","icao":"ZBAA","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"buenos-aires","icao":"SAEZ","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"busan","icao":"RKPK","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"cape-town","icao":"FACT","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"chengdu","icao":"ZUUU","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"chicago","icao":"KORD","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"chongqing","icao":"ZUCK","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"dallas","icao":"KDAL","n":95,"matchRate":0.9579,"resolutionRisk":0.0421,"meanSignedDiff":1},
    {"slug":"denver","icao":"KBKF","n":95,"matchRate":0.9368,"resolutionRisk":0.0632,"meanSignedDiff":1},
    {"slug":"guangzhou","icao":"ZGGG","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"helsinki","icao":"EFHK","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"houston","icao":"KHOU","n":95,"matchRate":0.9368,"resolutionRisk":0.0632,"meanSignedDiff":1.3333},
    {"slug":"jeddah","icao":"OEJN","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"karachi","icao":"OPKC","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"kuala-lumpur","icao":"WMKK","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"london","icao":"EGLC","n":95,"matchRate":0.9789,"resolutionRisk":0.0211,"meanSignedDiff":1},
    {"slug":"los-angeles","icao":"KLAX","n":95,"matchRate":0.9789,"resolutionRisk":0.0211,"meanSignedDiff":1},
    {"slug":"lucknow","icao":"VILK","n":91,"matchRate":0.989,"resolutionRisk":0.011,"meanSignedDiff":1},
    {"slug":"madrid","icao":"LEMD","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"manila","icao":"RPLL","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"mexico-city","icao":"MMMX","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"miami","icao":"KMIA","n":95,"matchRate":0.9368,"resolutionRisk":0.0632,"meanSignedDiff":1.1667},
    {"slug":"milan","icao":"LIMC","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"munich","icao":"EDDM","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"nyc","icao":"KLGA","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"panama-city","icao":"MPMG","n":95,"matchRate":0.9895,"resolutionRisk":0.0105,"meanSignedDiff":1},
    {"slug":"paris","icao":"LFPB","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"qingdao","icao":"ZSQD","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"san-francisco","icao":"KSFO","n":95,"matchRate":0.9684,"resolutionRisk":0.0316,"meanSignedDiff":1.3333},
    {"slug":"sao-paulo","icao":"SBGR","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"seattle","icao":"KSEA","n":95,"matchRate":0.9684,"resolutionRisk":0.0316,"meanSignedDiff":1.3333},
    {"slug":"seoul","icao":"RKSI","n":96,"matchRate":0.9583,"resolutionRisk":0.0417,"meanSignedDiff":0.5},
    {"slug":"shanghai","icao":"ZSPD","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"shenzhen","icao":"ZGSZ","n":96,"matchRate":0.2292,"resolutionRisk":0.7708,"meanSignedDiff":-0.5405},
    {"slug":"singapore","icao":"WSSS","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"taipei","icao":"RCSS","n":96,"matchRate":0.9896,"resolutionRisk":0.0104,"meanSignedDiff":1},
    {"slug":"tokyo","icao":"RJTT","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"toronto","icao":"CYYZ","n":95,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"warsaw","icao":"EPWA","n":95,"matchRate":0.9895,"resolutionRisk":0.0105,"meanSignedDiff":1},
    {"slug":"wellington","icao":"NZWN","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
    {"slug":"wuhan","icao":"ZHHH","n":96,"matchRate":1,"resolutionRisk":0,"meanSignedDiff":null},
  ],
};

const BY_SLUG = new Map(RESOLUTION_RISK.cities.map((c) => [c.slug, c]));

/** The city's resolution-risk row, or null when the slug is unknown. */
export function getResolutionRisk(slug: string): CityResolutionRisk | null {
  return BY_SLUG.get(slug) ?? null;
}
