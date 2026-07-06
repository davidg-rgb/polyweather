/**
 * apply-migration.ts — apply a repo migration to prod via a direct transactional DB connection,
 * recording the supabase_migrations.schema_migrations ledger row in the same format the
 * Supabase MCP `apply_migration` produces (timestamp version + name). Use ONLY when the MCP
 * proxy is unavailable; the normal path is MCP apply_migration.
 *
 * Atomic: the whole file + the ledger insert run inside one transaction (sql.begin) — any error
 * rolls back everything. Aborts if the migration's version/name is already recorded.
 *
 *   pnpm tsx scripts/ops/apply-migration.ts supabase/migrations/0085_city_live.sql
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import postgres from 'postgres';
import { loadEnv } from '../lib/load-env.ts';

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  const path = process.argv[2];
  if (!path) throw new Error('usage: apply-migration.ts <path-to-.sql>');

  const name = basename(path).replace(/\.sql$/, '');
  const sqlText = readFileSync(path, 'utf8');
  const version = stamp(new Date());

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const already = await sql`
      SELECT version FROM supabase_migrations.schema_migrations WHERE name = ${name} LIMIT 1`;
    if (already.length > 0) {
      console.log(`ALREADY APPLIED: ${name} @ version ${already[0]!['version']} — nothing to do.`);
      return;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      await tx`
        INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
        VALUES (${version}, ${name}, ${sql.array([sqlText])})`;
    });
    console.log(`APPLIED: ${name} @ version ${version} (transactional, ledger recorded).`);
  } finally {
    await sql.end({ timeout: 10 });
  }
}
main().catch((e) => {
  console.error('APPLY FAILED (rolled back):', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
