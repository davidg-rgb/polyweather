/**
 * sb.ts — run the Supabase CLI with .env.local loaded in-process (SUPABASE_ACCESS_TOKEN,
 * DATABASE_URL, etc.) so secrets reach the CLI without being surfaced. A hook-safe wrapper
 * for CLI ops (functions deploy, etc.) when the MCP path is unavailable. Passes all argv through.
 *   pnpm tsx scripts/ops/sb.ts functions deploy city-paper-trade --project-ref <ref> --use-api
 */
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../lib/load-env.ts';

loadEnv();
const r = spawnSync('npx', ['--no-install', 'supabase', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
