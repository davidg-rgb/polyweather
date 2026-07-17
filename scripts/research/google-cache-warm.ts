/**
 * google-cache-warm — LOCAL bootstrap of google_replay_cache (0103/0104; loop C37, 2026-07-17).
 *
 * The Edge tick's cache-warming pass (replay EVERYTHING once) exceeds the ~400s isolate wall at the
 * current window size, and although the C37 per-city-write handler converges across reaped runs, this
 * script finishes the bootstrap in ONE local run with no wall: per city, pull the full fresh series
 * (google_paper_inputs_v2), build the replay units (the same core engine the Edge tick runs), and write
 * the RESOLVED, non-gm units to the cache under the live cache key. Re-runnable anytime (idempotent
 * upserts) — e.g. after a GOOGLE_REPLAY_ENGINE_VERSION/cfg bump invalidates the key.
 *
 * Read-only on every table except google_replay_cache. No trading surface.
 *
 *   pnpm tsx scripts/research/google-cache-warm.ts
 */
import {
  BOT_DEFAULTS,
  buildGoogleReplayUnits,
  googleCfg,
  googleReplayCacheKey,
  type RawCaptureRow,
  type RawGooglePrediction,
  type RawResolution,
} from '../../packages/core/src/index.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

const PANEL_DAYS = 21;

interface Inputs {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
  google: RawGooglePrediction[];
}

loadEnv();
const db = makeScriptDb();
try {
  const cfgRows = await db.query<{ value: string }>(`select value from config where key = 'bot.cities'`);
  const cities =
    cfgRows[0]?.value != null && cfgRows[0].value.trim() !== ''
      ? cfgRows[0].value.split(',').map((s) => s.trim()).filter(Boolean)
      : BOT_DEFAULTS.cities;
  const cfg = googleCfg(cities);
  const cacheKey = googleReplayCacheKey(cfg);
  console.log(`google-cache-warm: ${cities.length} cities · key ${cacheKey}`);

  const idxRows = await db.query<{ idx: { rows?: Array<{ eventId: string; resolved: boolean; gm: boolean }> } }>(
    `select public.google_paper_event_index($1, $2) as idx`,
    [PANEL_DAYS, cities],
  );
  const index = idxRows[0]?.idx?.rows ?? [];
  const freezeIds = new Set(index.filter((r) => r.resolved && !r.gm).map((r) => r.eventId));
  console.log(`index: ${index.length} fresh events · ${freezeIds.size} frozen (resolved, non-gm)`);

  let written = 0;
  for (const city of cities) {
    const r = await db.query<{ inp: Inputs }>(
      `select public.google_paper_inputs_v2($1, $2, null) as inp`,
      [PANEL_DAYS, [city]],
    );
    const inp = r[0]?.inp ?? { captures: [], resolutions: [], google: [] };
    const units = buildGoogleReplayUnits(inp.captures ?? [], inp.resolutions ?? [], inp.google ?? [], cfg);
    const toWrite = units.filter((u) => freezeIds.has(u.eventId));
    if (toWrite.length > 0) {
      const w = await db.query<{ n: number }>(
        `select public.google_replay_cache_write($1, $2::jsonb) as n`,
        [cacheKey, JSON.stringify(toWrite)],
      );
      written += Number(w[0]?.n ?? 0);
    }
    console.log(`  ${city}: ${units.length} units · ${toWrite.length} frozen`);
  }
  console.log(`google-cache-warm: DONE — ${written} cache rows written`);
} finally {
  await db.end();
}
