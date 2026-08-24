/**
 * psql.ts — run the portable psql (tools/pg17, fetched by pause-backup.ts) against
 * DATABASE_URL with .env.local loaded in-process, so the conninfo never appears in
 * argv you type or in chat. All argv pass through to psql.
 *   pnpm tsx scripts/ops/psql.ts -At -c "select 1"
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/load-env.ts';

loadEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing from env (.env.local)');
  process.exit(1);
}
const psql = join(process.cwd(), 'tools', 'pg17', 'pgsql', 'bin', 'psql.exe');
if (!existsSync(psql)) {
  console.error(`portable psql not found at ${psql} — run pause-backup.ts once to fetch tools/pg17`);
  process.exit(1);
}
const r = spawnSync(psql, ['--dbname', url, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
