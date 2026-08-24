/**
 * scripts/ops/pause-backup — the complete, VERIFIED local backup taken before the hosted
 * Supabase project is PAUSED (or deleted). Sibling of scripts/backup-db.ts, which is the
 * weekly rolling dump; this one is the once-off "we may have to rebuild the project from
 * scratch" artifact, so it captures everything a fresh project needs and then PROVES the
 * dump is complete rather than trusting pg_dump's exit code.
 *
 * Produces, under backups/<YYYY-MM-DD>-pause/:
 *   db-full.dump  — pg_dump -Fc (schema+data, public + supabase_migrations) — restore path A
 *   db-data.sql   — plain --data-only COPY text — tooling-independent long-term copy
 *   schema.sql    — plain --schema-only
 *   inventory/    — row counts, cron jobs (+ regenerated cron.schedule SQL), applied
 *                   migrations (+ diff vs the repo's files), extensions, vault secret
 *                   NAMES, edge function + edge secret NAMES
 *   verification.json — machine-written proof: restore-list table count, per-table
 *                   live-vs-dump row counts, file sizes
 *
 * Consistency: the three dumps and the row counts all read ONE exported snapshot
 * (pg_export_snapshot in a repeatable-read read-only transaction), so the counts are
 * exact rather than racing the 19 pg_cron writers. If the server refuses the snapshot the
 * script falls back to bracketing (pre-count <= dump count <= post-count) and says so.
 *
 * READ-ONLY against the hosted DB. Secrets: the conninfo is passed to pg_dump as a spawn
 * argument and never printed — every child's stderr is redacted before it reaches a log,
 * and only id/name/created_at is read from the vault.
 *
 * Needs Postgres 17 client binaries; see PG_BIN_HINT below (docs/ops/PAUSE-RESTORE.md).
 *   pnpm tsx scripts/ops/pause-backup.ts [outDir]
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import postgres from 'postgres';
import { loadEnv } from '../lib/load-env.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_REF = 'lenysiqxihsmxljvyybt';
const SCHEMAS = ['public', 'supabase_migrations'];
/** Tables the Directive requires an explicit live-vs-dump comparison for. */
const HEADLINE_TABLES = [
  'public.opening_captures',
  'public.market_snapshots',
  'public.forecast_snapshots',
  'public.edge_evaluations',
  'public.config',
  'public.trade_config',
  'public.cheap_early_variant_ledger',
];
const PG_BIN_HINT =
  'Postgres 17 client binaries not found. Download the EnterpriseDB "binaries only" zip and unzip it to tools/pg17/:\n' +
  '  curl -sSL -o tools/pg17-binaries.zip https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip\n' +
  '  unzip -q tools/pg17-binaries.zip -d tools/pg17   # -> tools/pg17/pgsql/bin/pg_dump.exe\n' +
  'Fallback: winget install --id PostgreSQL.PostgreSQL.17 --scope user';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested in pause-backup.test.ts — no DB, no filesystem).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite a direct Supabase conninfo (`db.<ref>.supabase.co`) into its session-pooler
 * form. The direct host is IPv6-only on newer projects, which node happens to reach but
 * pg_dump may not; the pooler is IPv4 and session-mode (so it still supports the exported
 * snapshot). Returns null when the URL is not a direct Supabase host — i.e. there is
 * nothing to derive, the caller already has the only form available.
 */
export function deriveSessionPoolerUrl(databaseUrl: string, region = 'eu-north-1'): string | null {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    return null;
  }
  const m = /^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/i.exec(u.hostname);
  if (!m) return null;
  const db = u.pathname.replace(/^\//, '') || 'postgres';
  return `postgresql://postgres.${m[1]}:${u.password}@aws-0-${region}.pooler.supabase.com:5432/${db}${u.search}`;
}

/** The project ref embedded in either conninfo form, for logging (never the credentials). */
export function projectRefFromUrl(databaseUrl: string): string | null {
  try {
    const u = new URL(databaseUrl);
    const direct = /^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/i.exec(u.hostname);
    if (direct) return direct[1]!;
    const pooled = /^postgres\.([a-z0-9]+)$/i.exec(decodeURIComponent(u.username));
    return pooled ? pooled[1]! : null;
  } catch {
    return null;
  }
}

/** Strip any conninfo that leaked into a child process's output before it is logged. */
export function redactConninfo(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgresql://…REDACTED');
}

const COPY_HEADER_RE = /^COPY\s+([^\s(]+)\s+\(.*\)\s+FROM\s+stdin;$/;

export interface CopyRowCounter {
  /** Feed one line of a plain pg_dump, in order. */
  feed(line: string): void;
  /** schema.table -> data rows found between the COPY header and its `\.` terminator. */
  counts: Record<string, number>;
  /** True while inside a COPY block — set at EOF it means the dump is truncated. */
  open: boolean;
}

/**
 * Count COPY payload rows in a plain pg_dump, as a line-fed state machine so a
 * multi-hundred-MB file can be streamed. Safe against data that looks like SQL: a
 * header is only recognised outside a block, and COPY text format escapes a literal
 * backslash as `\\`, so a payload line is never exactly `\.`.
 */
export function makeCopyRowCounter(): CopyRowCounter {
  const counts: Record<string, number> = {};
  let current: string | null = null;
  return {
    counts,
    get open() {
      return current !== null;
    },
    feed(line: string): void {
      if (current === null) {
        const m = COPY_HEADER_RE.exec(line);
        if (m) {
          current = m[1]!.replace(/"/g, '');
          counts[current] ??= 0;
        }
        return;
      }
      if (line === '\\.') {
        current = null;
        return;
      }
      counts[current]! += 1;
    },
  };
}

/** Wrap `body` in a dollar-quote whose tag is guaranteed absent from it. */
export function dollarQuote(body: string, base = 'cron'): string {
  let tag = base;
  for (let i = 0; body.includes(`$${tag}$`); i++) tag = `${base}${i}`;
  return `$${tag}$${body}$${tag}$`;
}

const sq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export interface CronJobRow {
  jobid: number | string;
  jobname: string | null;
  schedule: string;
  command: string;
  active: boolean;
  database?: string | null;
  username?: string | null;
}

/**
 * Regenerate executable `cron.schedule(...)` statements from cron.job rows. Idempotent by
 * construction: each job is unscheduled first, because migrations recreate some of these
 * jobs on a fresh project and cron.schedule would otherwise silently redefine or duplicate.
 * Unnamed jobs cannot be addressed by name, so they are emitted commented-out for review.
 */
export function cronRecreateSql(jobs: CronJobRow[], generatedAt = new Date()): string {
  const out: string[] = [
    '-- cron_jobs_recreate.sql — regenerated from cron.job by scripts/ops/pause-backup.ts',
    `-- source project ${PROJECT_REF} · captured ${generatedAt.toISOString()}`,
    '-- Run as the postgres role AFTER the schema + edge functions exist. Idempotent: each',
    '-- job is unscheduled before being (re)created, so migrations that already scheduled a',
    '-- same-named job are superseded rather than duplicated.',
    '',
  ];
  for (const j of jobs) {
    out.push(`-- jobid ${j.jobid} · ${j.schedule}${j.active ? '' : ' · INACTIVE at capture time'}`);
    if (!j.jobname) {
      out.push(`-- UNNAMED JOB — cannot be recreated by name, review by hand:`);
      out.push(`-- select cron.schedule(${sq(j.schedule)}, ${dollarQuote(j.command)});`);
      out.push('');
      continue;
    }
    const name = sq(j.jobname);
    out.push(`select cron.unschedule(${name}) where exists (select 1 from cron.job where jobname = ${name});`);
    out.push(`select cron.schedule(${name}, ${sq(j.schedule)}, ${dollarQuote(j.command)});`);
    if (!j.active) out.push(`update cron.job set active = false where jobname = ${name};`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Names (never values) out of `supabase secrets list`. The CLI emits JSON whose `value`
 * is a SHA-256 DIGEST rather than the plaintext — it is still dropped here, because a
 * digest is a fingerprint of a live secret and has no restore use. A leading npm/CLI
 * banner is tolerated by seeking to the first brace.
 */
export function parseEdgeSecretNames(stdout: string): Array<{ name: string; updated_at?: string }> {
  const start = stdout.indexOf('{');
  if (start === -1) return [];
  let parsed: { secrets?: Array<{ name?: string; updated_at?: string }> };
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  return (parsed.secrets ?? [])
    .filter((s): s is { name: string; updated_at?: string } => typeof s.name === 'string')
    .map((s) => ({ name: s.name, updated_at: s.updated_at }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Deployed functions out of `supabase functions list --output json` (banner-tolerant). */
export function parseFunctionsList(stdout: string): Array<Record<string, unknown>> {
  const start = stdout.indexOf('[');
  if (start === -1) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/**
 * Which repo migration files have no supabase_migrations row. Matched on the file's
 * `name` (basename minus .sql), the same key apply-migration.ts records — the `version`
 * timestamps differ between the MCP path and the CLI path and cannot be compared.
 */
export function unrecordedMigrations(repoFiles: string[], appliedNames: string[]): string[] {
  const applied = new Set(appliedNames);
  return repoFiles
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .filter((n) => !applied.has(n))
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Child processes
// ─────────────────────────────────────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a child, capture stdout/stderr as text (stderr redacted). Never inherits stdio. */
function run(cmd: string, args: string[], opts: { shell?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell ?? false,
      timeout: opts.timeoutMs ?? 45 * 60_000,
      cwd: REPO_ROOT,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => rej(new Error(`${cmd} failed to start: ${redactConninfo(e.message)}`)));
    child.on('close', (code) =>
      res({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: redactConninfo(Buffer.concat(err).toString('utf8')),
      }),
    );
  });
}

/** Spawn pg_dump streaming straight to `outPath` — the plain data dump does not fit in RAM. */
function dumpToFile(bin: string, args: string[], outPath: string): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn(bin, [...args, '--file', outPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 45 * 60_000,
      cwd: REPO_ROOT,
    });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => rej(new Error(`pg_dump failed to start: ${redactConninfo(e.message)}`)));
    child.on('close', (code) =>
      res({ code: code ?? 1, stdout: '', stderr: redactConninfo(Buffer.concat(err).toString('utf8')) }),
    );
  });
}

/** First directory holding a major-17 pg_dump.exe/pg_dump. */
async function resolvePgBinDir(): Promise<{ dir: string; version: string }> {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    join(REPO_ROOT, 'tools', 'pg17', 'pgsql', 'bin'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'PostgreSQL', '17', 'bin'),
    'C:\\Program Files\\PostgreSQL\\17\\bin',
  ];
  for (const dir of candidates) {
    const bin = join(dir, `pg_dump${exe}`);
    if (!existsSync(bin)) continue;
    const r = await run(bin, ['--version'], { timeoutMs: 60_000 });
    const version = r.stdout.trim();
    if (/\b17\./.test(version)) return { dir, version };
  }
  throw new Error(PG_BIN_HINT);
}

/**
 * Run the repo's supabase CLI wrapper and capture its output. sb.ts uses stdio:'inherit',
 * which inherits OUR pipes, so wrapping it still yields capturable text while keeping the
 * single hook-safe env-loading path.
 */
async function sbCapture(args: string[]): Promise<RunResult> {
  return run('pnpm', ['tsx', 'scripts/ops/sb.ts', ...args], { shell: true, timeoutMs: 5 * 60_000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface Sql {
  unsafe<T = Record<string, unknown>>(text: string): Promise<T[]>;
}

async function tableList(db: Sql, schemas: string[]): Promise<string[]> {
  const list = schemas.map((s) => `'${s}'`).join(',');
  const rows = await db.unsafe<{ qualified: string }>(`
    select format('%I.%I', schemaname, tablename) as qualified
      from pg_tables where schemaname in (${list}) order by schemaname, tablename`);
  return rows.map((r) => r.qualified);
}

async function rowCounts(db: Sql, tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const [row] = await db.unsafe<{ n: string }>(`select count(*)::text as n from ${t}`);
    counts[t.replace(/"/g, '')] = Number(row!.n);
  }
  return counts;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Stream a plain dump and count its COPY payload rows. */
async function countCopyRowsInFile(path: string): Promise<CopyRowCounter> {
  const counter = makeCopyRowCounter();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) counter.feed(line);
  return counter;
}

/**
 * The Supabase-CLI half of the inventory — deployed edge functions (+ parity against the
 * repo's function dirs) and edge secret NAMES. Independent of the DB connection, so
 * `--cli-inventory-only` can refresh it without re-taking the multi-GB dumps.
 */
async function writeCliInventory(invDir: string): Promise<string[]> {
  const notes: string[] = [];
  const fnDirs = readdirSync(join(REPO_ROOT, 'supabase', 'functions'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
  const fnList = await sbCapture(['functions', 'list', '--project-ref', PROJECT_REF, '--output', 'json']);
  const deployed = parseFunctionsList(fnList.stdout);
  if (deployed.length === 0) notes.push('supabase functions list returned no parseable JSON — raw output stored instead.');
  const deployedNames = deployed.map((f) => String(f['slug'] ?? f['name'] ?? '')).filter(Boolean).sort();
  writeJson(join(invDir, 'edge_functions.json'), {
    deployedCount: deployedNames.length,
    repoDirCount: fnDirs.length,
    deployed: deployed
      .map((f) => ({ name: f['slug'] ?? f['name'], version: f['version'], status: f['status'], updated_at: f['updated_at'] }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    repoDirs: fnDirs,
    inRepoNotDeployed: fnDirs.filter((n) => !deployedNames.includes(n)),
    deployedNotInRepo: deployedNames.filter((n) => !fnDirs.includes(n)),
    ...(deployed.length === 0 ? { rawOutput: fnList.stdout.slice(0, 4000), stderr: fnList.stderr.slice(0, 1000) } : {}),
  });

  const secList = await sbCapture(['secrets', 'list', '--project-ref', PROJECT_REF]);
  const secrets = parseEdgeSecretNames(secList.stdout);
  if (secrets.length === 0) notes.push('supabase secrets list returned no parseable names.');
  writeJson(join(invDir, 'edge_secret_names.json'), {
    count: secrets.length,
    secrets,
    note: "NAMES ONLY — values live in the operator's .env.local / password manager and must be re-set by hand.",
  });
  return notes;
}

async function main(): Promise<void> {
  loadEnv();
  const direct = process.env['DATABASE_URL'];
  if (!direct) throw new Error('DATABASE_URL is not set — pause-backup needs direct Postgres access (§11.2)');

  const argv = process.argv.slice(2);
  const cliInventoryOnly = argv.includes('--cli-inventory-only');
  const today = new Date().toISOString().slice(0, 10);
  const outDir = resolve(REPO_ROOT, argv.find((a) => !a.startsWith('--')) ?? join('backups', `${today}-pause`));
  const invDir = join(outDir, 'inventory');
  mkdirSync(invDir, { recursive: true });

  // Repair/refresh path: the edge-function + edge-secret listings only, no dumps.
  if (cliInventoryOnly) {
    const n = await writeCliInventory(invDir);
    console.log(`pause-backup: CLI inventory refreshed in ${invDir}${n.length ? ` · ${n.join(' · ')}` : ''}`);
    return;
  }

  const { dir: binDir, version: pgDumpVersion } = await resolvePgBinDir();
  const exe = process.platform === 'win32' ? '.exe' : '';
  const pgDump = join(binDir, `pg_dump${exe}`);
  const pgRestore = join(binDir, `pg_restore${exe}`);
  console.log(`pause-backup: ${pgDumpVersion} · project ${projectRefFromUrl(direct) ?? 'unknown'} · out ${outDir}`);

  const notes: string[] = [];
  const schemaArgs = SCHEMAS.flatMap((s) => ['--schema', s]);
  const files = {
    full: join(outDir, 'db-full.dump'),
    data: join(outDir, 'db-data.sql'),
    schema: join(outDir, 'schema.sql'),
  };

  const sql = postgres(direct, { max: 1, prepare: false });
  let live: Record<string, number> = {};
  let livePost: Record<string, number> | null = null;
  let connMode: 'direct' | 'session-pooler' = 'direct';
  let consistency: 'snapshot' | 'bracketed' = 'snapshot';
  let dumpedTables: string[] = [];
  let keepalive: NodeJS.Timeout | undefined;

  try {
    await sql.unsafe('select 1');

    // One repeatable-read read-only snapshot shared by all three dumps and the row counts.
    await sql.begin('isolation level repeatable read read only', async (tx) => {
      await tx.unsafe(`set local idle_in_transaction_session_timeout = 0`);
      const [snap] = await tx.unsafe<{ s: string }>(`select pg_export_snapshot() as s`);
      let snapshotArgs = ['--snapshot', snap!.s];
      let conninfo = direct;

      // A long dump leaves this connection idle-in-transaction; keep it warm so the
      // exported snapshot survives to the last pg_dump.
      keepalive = setInterval(() => {
        void tx.unsafe('select 1').catch(() => {});
      }, 60_000);

      // schema.sql doubles as the cheap probe for connectivity + snapshot support.
      const probe = async (): Promise<RunResult> =>
        dumpToFile(pgDump, ['--dbname', conninfo, ...schemaArgs, '--schema-only', '--no-owner', '--no-privileges', ...snapshotArgs], files.schema);
      let r = await probe();
      if (r.code !== 0 && /could not (connect|translate)|Connection refused|no route|Network is unreachable|timeout expired/i.test(r.stderr)) {
        const pooled = deriveSessionPoolerUrl(direct);
        if (!pooled) throw new Error(`pg_dump cannot connect and no pooler form derivable: ${r.stderr.slice(0, 300)}`);
        conninfo = pooled;
        connMode = 'session-pooler';
        notes.push('pg_dump could not use the direct host; fell back to the session pooler.');
        r = await probe();
      }
      if (r.code !== 0 && /snapshot/i.test(r.stderr)) {
        snapshotArgs = [];
        consistency = 'bracketed';
        notes.push(`server refused the exported snapshot — dumps are not snapshot-consistent: ${r.stderr.slice(0, 200)}`);
        r = await probe();
      }
      if (r.code !== 0) throw new Error(`pg_dump --schema-only exited ${r.code}: ${r.stderr.slice(0, 600)}`);
      console.log(`pause-backup: schema.sql ok (${connMode}, ${consistency})`);

      dumpedTables = await tableList(tx as unknown as Sql, SCHEMAS);
      const tables = dumpedTables.filter((t) => t.startsWith('public.'));
      if (consistency === 'bracketed') live = await rowCounts(tx as unknown as Sql, tables);

      for (const [label, args, path] of [
        ['db-full.dump', ['--format=custom', '--compress=9'], files.full],
        ['db-data.sql', ['--format=plain', '--data-only', '--no-owner', '--no-privileges'], files.data],
      ] as const) {
        const started = Date.now();
        const d = await dumpToFile(pgDump, ['--dbname', conninfo, ...schemaArgs, ...args, ...snapshotArgs], path);
        if (d.code !== 0) throw new Error(`pg_dump ${label} exited ${d.code}: ${d.stderr.slice(0, 600)}`);
        console.log(`pause-backup: ${label} ok (${(statSync(path).size / 2 ** 20).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
      }

      if (consistency === 'snapshot') live = await rowCounts(tx as unknown as Sql, tables);
      else livePost = await rowCounts(tx as unknown as Sql, tables);

      // ── inventory, all inside the same read-only transaction ──────────────
      writeJson(join(invDir, 'row_counts.json'), {
        capturedAt: new Date().toISOString(),
        consistency,
        tableCount: tables.length,
        counts: live,
        ...(livePost ? { countsAfterDump: livePost } : {}),
      });

      const cronJobs = await tx.unsafe<CronJobRow>(`
        select jobid, jobname, schedule, command, active, database, username, nodename, nodeport
          from cron.job order by jobid`);
      writeJson(join(invDir, 'cron_jobs.json'), cronJobs);
      writeFileSync(join(invDir, 'cron_jobs_recreate.sql'), cronRecreateSql(cronJobs));

      const applied = await tx.unsafe<{ version: string; name: string | null }>(`
        select version, name from supabase_migrations.schema_migrations order by version`);
      const repoFiles = readdirSync(join(REPO_ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));
      const unrecorded = unrecordedMigrations(repoFiles, applied.map((a) => a.name ?? ''));
      writeJson(join(invDir, 'migrations_applied.json'), {
        appliedCount: applied.length,
        repoFileCount: repoFiles.length,
        applied,
        unrecordedInHistory: unrecorded,
      });

      writeJson(join(invDir, 'extensions.json'), await tx.unsafe(`
        select e.extname, e.extversion, n.nspname as schema
          from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by e.extname`));

      // NAMES ONLY — vault.secrets never exposes plaintext (decrypted_secrets would).
      writeJson(join(invDir, 'vault_secret_names.json'), await tx.unsafe(`
        select id, name, created_at from vault.secrets order by name`));

      console.log(`pause-backup: inventory captured · ${cronJobs.length} cron jobs · ${unrecorded.length}/${repoFiles.length} migrations unrecorded`);
    });
    clearInterval(keepalive);

    notes.push(...(await writeCliInventory(invDir)));

    // ── Verification ────────────────────────────────────────────────────────
    const listing = await run(pgRestore, ['--list', files.full], { timeoutMs: 10 * 60_000 });
    if (listing.code !== 0) throw new Error(`pg_restore --list exited ${listing.code}: ${listing.stderr.slice(0, 400)}`);
    const tableDataEntries = listing.stdout.split(/\r?\n/).filter((l) => /\bTABLE DATA\b/.test(l)).length;

    const counter = await countCopyRowsInFile(files.data);
    const dumpCounts = counter.counts;
    const publicTables = Object.keys(live).filter((t) => t.startsWith('public.'));
    const check = (t: string) => {
      const dump = dumpCounts[t] ?? 0;
      const liveN = live[t] ?? null;
      const post = livePost?.[t] ?? null;
      const ok = consistency === 'snapshot' ? dump === liveN : liveN !== null && post !== null && dump >= liveN && dump <= post;
      return { table: t, live: liveN, ...(post !== null ? { liveAfterDump: post } : {}), dump, match: ok };
    };
    const headline = HEADLINE_TABLES.map(check);
    const allTables = publicTables.map(check);
    const sizes = Object.entries(files).map(([k, p]) => ({ file: k, path: p.slice(outDir.length + 1), bytes: statSync(p).size }));

    const verification = {
      generatedAt: new Date().toISOString(),
      projectRef: PROJECT_REF,
      pgDumpVersion,
      connectionMode: connMode,
      consistency,
      copyBlockLeftOpen: counter.open,
      publicTableCount: publicTables.length,
      dumpedTableCount: dumpedTables.length, // public + supabase_migrations
      tableDataEntries,
      tableDataEntriesMatchDumpedTables: tableDataEntries === dumpedTables.length,
      files: sizes,
      headlineTableChecks: headline,
      allTableChecks: allTables,
      mismatches: allTables.filter((c) => !c.match).map((c) => c.table),
      notes,
      pass:
        !counter.open &&
        sizes.every((s) => s.bytes > 0) &&
        headline.every((c) => c.match) &&
        allTables.every((c) => c.match) &&
        tableDataEntries === dumpedTables.length,
    };
    writeJson(join(outDir, 'verification.json'), verification);

    console.log(
      `pause-backup: ${verification.pass ? 'VERIFIED' : 'FAILED VERIFICATION'} · ` +
        `${tableDataEntries} TABLE DATA entries · ${publicTables.length} public tables · ` +
        `${verification.mismatches.length} mismatches · ` +
        `${(sizes.reduce((a, s) => a + s.bytes, 0) / 2 ** 30).toFixed(2)} GB of dumps`,
    );
    if (!verification.pass) process.exitCode = 1;
  } finally {
    clearInterval(keepalive);
    await sql.end({ timeout: 10 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('pause-backup FAILED:', redactConninfo(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
