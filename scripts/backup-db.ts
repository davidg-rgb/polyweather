/**
 * scripts/backup-db — weekly pg_dump of the database (§6.22, F-037, R-17).
 *
 * The bets / bankroll_ledger / config_audit evidentiary core has no PITR on
 * the free tier — this dumps the WHOLE database (plain SQL, gzipped) to
 * ./backups/{YYYY-MM-DD}.sql.gz and keeps the newest 8 files (same-day
 * re-runs overwrite). RUNBOOK schedules it weekly and documents the restore
 * drill (gunzip | psql into a scratch database).
 *
 * Run: pnpm tsx scripts/backup-db.ts [--dir backups] [--keep 8]
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

export const DEFAULT_KEEP = 8;
const DUMP_NAME_RE = /^\d{4}-\d{2}-\d{2}\.sql\.gz$/;

export interface BackupArgs {
  dir?: string;
  keep?: number;
}

export interface BackupDeps {
  /** Produce the plain-SQL dump bytes (prod: spawn pg_dump; tests inject). */
  dump: (databaseUrl: string) => Promise<Buffer>;
  databaseUrl: string;
  log: (msg: string) => void;
  now: () => Date;
}

export interface BackupResult {
  path: string;
  bytes: number;
  pruned: string[];
}

export async function backupDb(args: BackupArgs, deps: BackupDeps): Promise<BackupResult> {
  const dir = args.dir ?? 'backups';
  const keep = args.keep ?? DEFAULT_KEEP;
  mkdirSync(dir, { recursive: true });

  const sql = await deps.dump(deps.databaseUrl);
  if (sql.length === 0) throw new Error('pg_dump produced zero bytes — refusing to write an empty backup');
  const gz = gzipSync(sql);
  const name = `${deps.now().toISOString().slice(0, 10)}.sql.gz`;
  const path = join(dir, name);
  writeFileSync(path, gz);

  // newest `keep` by date-name survive (names sort chronologically)
  const dumps = readdirSync(dir).filter((f) => DUMP_NAME_RE.test(f)).sort().reverse();
  const pruned = dumps.slice(keep);
  for (const f of pruned) unlinkSync(join(dir, f));

  deps.log(`backup-db: wrote ${path} (${gz.length} bytes gz, ${sql.length} raw)` +
    (pruned.length > 0 ? ` · pruned ${pruned.join(', ')}` : '') + ` · ${Math.min(dumps.length, keep)}/${keep} retained`);
  return { path, bytes: gz.length, pruned };
}

/** Spawn pg_dump and capture stdout (plain format — restorable via psql). */
export function pgDump(databaseUrl: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--dbname', databaseUrl, '--format=plain', '--no-owner', '--no-privileges'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) =>
      reject(new Error(`pg_dump failed to start (${e.message}) — install the PostgreSQL client tools`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`pg_dump exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 400)}`));
    });
  });
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { dir: { type: 'string' }, keep: { type: 'string' } },
  });
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — backup-db needs direct Postgres access (§11.2)');
    process.exit(2);
  }
  await backupDb(
    { dir: values.dir, keep: values.keep ? Number(values.keep) : undefined },
    { dump: pgDump, databaseUrl, log: console.log, now: () => new Date() },
  );
}
