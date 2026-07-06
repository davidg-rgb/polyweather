/**
 * gate-read.ts — read-only local fallback for the gate watch when the MCP proxy is down.
 *
 * Reads the latest maker-exit-panel job_runs rows directly via DATABASE_URL (postgres-js),
 * so the gate can be adjudicated even during an Anthropic MCP-proxy outage. No writes, ever.
 * Run: pnpm tsx scripts/ops/gate-read.ts [nRows]
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';

async function main(): Promise<void> {
  loadEnv();
  const n = Math.max(1, Math.min(10, Number(process.argv[2] ?? 3)));
  const db = makeScriptDb();
  try {
    const rows = await db.query<{
      started_at: string;
      duration_ms: number | null;
      label: string | null;
      cerr: string | null;
      nmkts: string | null;
      budgetskip: string | null;
      fillrate: string | null;
      gateskip: string | null;
    }>(
      `SELECT started_at, duration_ms,
              stats->>'label' AS label,
              stats->>'cityErrors' AS cerr,
              stats->>'nMarkets' AS nmkts,
              stats->>'budgetSkipped' AS budgetskip,
              stats->>'makerFillRate' AS fillrate,
              stats->>'gateWriteSkipped' AS gateskip
         FROM job_runs
        WHERE job = 'maker-exit-panel'
        ORDER BY started_at DESC
        LIMIT $1`,
      [n],
    );
    for (const r of rows) {
      const clean = (r.cerr === null ? '?' : Number(r.cerr) <= 2) && r.gateskip === null;
      console.log(
        `${r.started_at} | ${r.label} | cErr=${r.cerr} nMkts=${r.nmkts} budgetSkip=${r.budgetskip} ` +
          `fill=${r.fillrate} gateSkip=${r.gateskip ?? 'none'} dur=${r.duration_ms}ms | ${clean ? 'CLEAN' : 'degraded'}`,
      );
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
