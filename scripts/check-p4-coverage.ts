/**
 * scripts/check-p4-coverage — P4 DoD verifier (§14).
 *
 * The P4 Definition-of-Done: "≥12 months × ≥40 stations backfilled at leads
 * 1–7 (5 models); model_stats non-null for ≥90% (station, model∈5, lead≤5,
 * slot) cells." This turns that prose check into one command. The "5 models"
 * are exactly the deterministic models whose horizon covers leads 0–5
 * (horizon_days ≥ 7) — derived from the DB, not hardcoded:
 *   ecmwf_ifs025, gfs_seamless, icon_seamless, jma_seamless, gem_seamless.
 *
 * A cell counts as covered when its model_stats row has a non-null
 * residual_sigma_c (the σ build-distributions actually consumes — i.e. the
 * window had enough residuals to fit). Run AFTER the backfill + a
 * run-calibration fold. Exit 0 = DoD met, 1 = not yet (CI/ops friendly).
 *
 * Run: pnpm tsx scripts/check-p4-coverage.ts
 */
import { pathToFileURL } from 'node:url';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';

const LEADS = 6; // leads 0..5
const SLOTS = 2; // '10Z', '22Z'

async function main(): Promise<boolean> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const core = await db.query<{ slug: string }>(
      `select slug from models
       where enabled and not is_ensemble and archive_start is not null and horizon_days >= 7
       order by slug`,
    );
    const coreSlugs = core.map((m) => m.slug);
    if (coreSlugs.length === 0) {
      console.error('No core models found (enabled, deterministic, horizon ≥7).');
      return false;
    }

    const [stationRow] = await db.query<{ n: string }>(
      `select count(*)::text as n from stations where lat is not null and lon is not null`,
    );
    const nStations = Number(stationRow?.n ?? 0);
    const expected = nStations * coreSlugs.length * LEADS * SLOTS;

    const coveredFilter = `ms.model = any($1) and ms.lead_days between 0 and 5
       and ms.snapshot_slot in ('10Z','22Z') and ms.residual_sigma_c is not null`;

    const [coveredRow] = await db.query<{ n: string }>(
      `select count(*)::text as n from model_stats ms
       join stations st on st.icao = ms.icao and st.lat is not null and st.lon is not null
       where ${coveredFilter}`,
      [coreSlugs],
    );
    const covered = Number(coveredRow?.n ?? 0);

    const perModel = await db.query<{ model: string; covered: string }>(
      `select ms.model, count(*)::text as covered from model_stats ms
       join stations st on st.icao = ms.icao and st.lat is not null and st.lon is not null
       where ${coveredFilter}
       group by ms.model`,
      [coreSlugs],
    );
    const perMap = new Map(perModel.map((r) => [r.model, Number(r.covered)]));

    const [stationsCovered] = await db.query<{ n: string }>(
      `select count(distinct ms.icao)::text as n from model_stats ms where ${coveredFilter}`,
      [coreSlugs],
    );
    const nStationsCovered = Number(stationsCovered?.n ?? 0);

    const [range] = await db.query<{ lo: string | null; hi: string | null }>(
      `select min(target_date)::text as lo, max(target_date)::text as hi
       from forecast_snapshots where snapshot_slot = 'backfill'`,
    );
    const monthsCovered =
      range?.lo && range?.hi
        ? (new Date(range.hi).getTime() - new Date(range.lo).getTime()) / (1000 * 60 * 60 * 24 * 30.44)
        : 0;

    const pct = expected > 0 ? (covered / expected) * 100 : 0;
    const perCellPerModel = nStations * LEADS * SLOTS;

    console.log('P4 DoD — model_stats coverage (5 core models, leads 0–5, slots 10Z+22Z)');
    console.log(`  core models      ${coreSlugs.join(', ')}`);
    console.log(`  stations (coord) ${nStations}`);
    console.log(`  backfill range   ${range?.lo ?? '—'} → ${range?.hi ?? '—'}  (~${monthsCovered.toFixed(1)} months)`);
    console.log('');
    console.log('  per-model coverage (covered/expected):');
    for (const slug of coreSlugs) {
      const c = perMap.get(slug) ?? 0;
      const p = perCellPerModel > 0 ? (c / perCellPerModel) * 100 : 0;
      console.log(`    ${slug.padEnd(22)} ${String(c).padStart(5)}/${perCellPerModel}  ${p.toFixed(1).padStart(5)}%`);
    }
    console.log('');
    console.log(`  OVERALL          ${covered}/${expected}  ${pct.toFixed(1)}%`);
    console.log(`  stations covered ${nStationsCovered}`);
    console.log('');

    const passPct = pct >= 90;
    const passStations = nStationsCovered >= 40;
    const passMonths = monthsCovered >= 12;
    console.log(`  ≥90% cells:   ${passPct ? 'PASS' : 'FAIL'}  (${pct.toFixed(1)}%)`);
    console.log(`  ≥40 stations: ${passStations ? 'PASS' : 'FAIL'}  (${nStationsCovered})`);
    console.log(`  ≥12 months:   ${passMonths ? 'PASS' : 'FAIL'}  (${monthsCovered.toFixed(1)})`);
    console.log('');
    const pass = passPct && passStations && passMonths;
    console.log(pass ? '✅ P4 DoD MET' : '⏳ P4 DoD not yet met — let the backfill + run-calibration continue');
    return pass;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((pass) => process.exit(pass ? 0 : 1))
    .catch((err) => {
      console.error('check-p4-coverage crashed:', err?.message ?? err);
      process.exit(1);
    });
}
