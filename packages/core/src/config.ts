/**
 * core/config — runtime configuration schema (ARCHITECTURE.md §6.11).
 *
 * Every tunable with its default. The config TABLE is the source of operator
 * overrides (env is for secrets and wiring only — §11.2); parseConfigRows
 * merges DB rows over these defaults. The 0010 seed mirrors these values —
 * a test asserts code defaults == migration seed verbatim.
 */
import { z } from 'zod';
import { ConfigError } from './errors.ts';

export const ConfigSchema = z.object({
  bankrollUsd: z.number().positive().default(1000),
  kellyFraction: z.number().min(0).max(1).default(0.25),
  perTradeCapPct: z.number().min(0).max(1).default(0.02),
  perEventCapPct: z.number().min(0).max(1).default(0.05),
  clusterCapPct: z.number().min(0).max(1).default(0.08),
  dailyCapPct: z.number().min(0).max(1).default(0.15),
  uncertaintyMargin: z.number().min(0).default(0.05),
  spreadBufferMin: z.number().min(0).default(0.01),
  minEventVolumeUsd: z.number().min(0).default(2000),
  maxSpread: z.number().min(0).max(1).default(0.05),
  minHoursBeforeClose: z.number().min(0).default(2),
  maxLeadDays: z.number().int().min(0).max(16).default(7),
  probeStakeUsd: z.number().positive().default(20),
  minStakeUsd: z.number().min(0).default(5),
  paperSlippage: z.number().min(0).default(0.01),
  paperBookMaxAgeMin: z.number().positive().default(5),
  biasAlpha: z.number().min(0).max(1).default(0.15),
  sigmaWindowDays: z.number().int().positive().default(30),
  sigmaMinN: z.number().int().positive().default(8),
  /** Floor applied in °C, BEFORE native conversion (§6.11). */
  sigmaFloorC: z.number().min(0).default(0.45),
  /** °C prior σ ladder, lead 0..7. */
  priorSigmaByLead: z.array(z.number().positive()).length(8).default([1.6, 1.9, 2.3, 2.7, 3.1, 3.5, 3.9, 4.3]),
  breakerConsecLosses: z.number().int().positive().default(8),
  breakerDailyLossPct: z.number().min(0).max(1).default(0.05),
  breakerDrawdownPct: z.number().min(0).max(1).default(0.25),
  breakerBrier: z.number().min(0).max(2).default(0.3),
  staleForecastHaltH: z.number().positive().default(30),
  stalePriceHaltMin: z.number().positive().default(30),
  championSource: z.enum(['house_gaussian', 'house_ensemble']).default('house_gaussian'),
  /** Phase A manual-only (0); §12 Phase B raises it. */
  autoApproveMaxStakeUsd: z.number().min(0).default(0),
  /**
   * INVARIANT: ≥ the platform's max isolate lifetime incl. waitUntil — this
   * single value parameterizes the job_locks lease expiry, runJob's
   * 409-vs-takeover age test, and the health-monitor reaper; setting it below
   * a job's true runtime re-opens the C8/W16 races.
   */
  jobWallLimitSec: z.number().positive().default(150),
  tradingMode: z.enum(['paper', 'live']).default('paper'),
  /** Runtime-extracted WU frontend key cache (no default — absent until first fetch). */
  wuApiKey: z.string().optional(),
  wuKeyFetchedAt: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const STRING_KEYS = new Set(['championSource', 'tradingMode', 'wuApiKey', 'wuKeyFetchedAt']);
const ARRAY_KEYS = new Set(['priorSigmaByLead']);

/**
 * Merge DB config rows over the defaults and validate. Keys outside the
 * schema (halt:* rows, operatorEmail) belong to other subsystems and are
 * ignored here. Throws ConfigError listing EVERY invalid key — fail-fast at
 * job start, with the full damage report in one shot.
 */
export function parseConfigRows(rows: { key: string; value: string }[]): AppConfig {
  const schemaKeys = new Set(Object.keys(ConfigSchema.shape));
  const overrides: Record<string, unknown> = {};
  const invalid: { key: string; reason: string }[] = [];

  for (const { key, value } of rows) {
    if (!schemaKeys.has(key)) continue;
    if (value === null || value === undefined) {
      invalid.push({ key, reason: 'null value' });
      continue;
    }
    if (STRING_KEYS.has(key)) {
      overrides[key] = value;
    } else if (ARRAY_KEYS.has(key)) {
      try {
        overrides[key] = JSON.parse(value);
      } catch {
        invalid.push({ key, reason: `not valid JSON: ${value}` });
      }
    } else {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        invalid.push({ key, reason: `not a number: ${value}` });
      } else {
        overrides[key] = n;
      }
    }
  }

  const parsed = ConfigSchema.safeParse(overrides);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      invalid.push({ key: String(issue.path[0] ?? '?'), reason: issue.message });
    }
  }
  if (invalid.length > 0) {
    throw new ConfigError(
      `invalid config row(s): ${invalid.map((i) => `${i.key} (${i.reason})`).join('; ')}`,
      { invalidKeys: invalid.map((i) => i.key), invalid },
    );
  }
  return parsed.data!;
}
