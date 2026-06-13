/**
 * scripts/check-db — DATABASE_URL connectivity probe (§11.2, ops aid).
 *
 * Loads `.env.local`, parses the connection's NON-SECRET wiring (host, port,
 * user, database, sslmode — never the password), then opens a real connection
 * and runs one diagnostic query. On failure it classifies the error and prints
 * the exact fix (auth / encoding / IPv6-direct-vs-pooler / pooler-username).
 *
 * The password is NEVER printed — not in facts, not in error text (every error
 * string is scrubbed of the raw URL and password before output). This is the
 * app reading its own config to CONNECT, the same as the backfill scripts.
 *
 * Run: pnpm tsx scripts/check-db.ts
 */
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { loadEnv } from './lib/load-env.ts';

interface ProbeResult {
  ok: boolean;
  lines: string[];
}

/** Scrub any occurrence of the raw URL or decoded password out of a string. */
function scrub(text: string, url: string, password: string): string {
  let out = text;
  if (url) out = out.split(url).join('‹url›');
  if (password) out = out.split(password).join('‹password›');
  return out;
}

export async function probeDatabaseUrl(databaseUrl: string | undefined): Promise<ProbeResult> {
  const lines: string[] = [];
  if (!databaseUrl) {
    return {
      ok: false,
      lines: [
        '❌ DATABASE_URL is not set.',
        '   Add it to .env.local (the scripts load that file automatically), e.g.:',
        '   DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"',
      ],
    };
  }

  // --- Non-secret wiring facts (parse without printing the password) ---
  let parsed: URL | null = null;
  let password = '';
  try {
    parsed = new URL(databaseUrl);
    password = decodeURIComponent(parsed.password);
  } catch {
    return {
      ok: false,
      lines: [
        '❌ DATABASE_URL is not a parseable URL.',
        '   Almost always an un-encoded special character in the password.',
        '   Percent-encode it: @ → %40, : → %3A, / → %2F, ? → %3F, # → %23,',
        '   & → %26, space → %20. Or reset the DB password to alphanumeric-only',
        '   in the Supabase dashboard (Project Settings → Database → Reset password).',
      ],
    };
  }

  const host = parsed.hostname;
  const port = parsed.port || '5432';
  const user = decodeURIComponent(parsed.username);
  const database = parsed.pathname.replace(/^\//, '') || '(default)';
  const sslmode = parsed.searchParams.get('sslmode') ?? '(unset)';
  const isPooler = host.includes('pooler.supabase.com');
  const isDirect = host.startsWith('db.') && host.endsWith('.supabase.co');

  lines.push('DATABASE_URL wiring (password withheld):');
  lines.push(`   host      ${host}`);
  lines.push(`   port      ${port}`);
  lines.push(`   user      ${user}`);
  lines.push(`   database  ${database}`);
  lines.push(`   sslmode   ${sslmode}`);
  lines.push(`   password  ${password ? `present (${password.length} chars)` : 'MISSING'}`);
  lines.push(
    `   endpoint  ${isPooler ? `Supavisor pooler (IPv4-OK; ${port === '6543' ? 'transaction' : 'session'} mode)` : isDirect ? 'direct connection (db.<ref> — IPv6-only)' : 'custom/unknown host'}`,
  );
  lines.push('');

  // --- Pre-flight wiring sanity ---
  if (isPooler && !user.includes('.')) {
    lines.push('⚠️  Pooler host but username has no `.<ref>` suffix — Supavisor needs');
    lines.push('   user `postgres.<project-ref>`, not bare `postgres`. This will fail auth.');
    lines.push('');
  }
  if (isDirect) {
    lines.push('⚠️  Direct connection (db.<ref>.supabase.co) is IPv6-only. If this box is');
    lines.push('   IPv4-only it will hang/timeout — prefer the Session pooler host.');
    lines.push('');
  }

  // --- Live connection ---
  const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 15, idle_timeout: 2 });
  try {
    const rows = (await sql.unsafe(
      'select current_user as u, current_database() as d, inet_server_addr()::text as ip, version() as v',
    )) as unknown as Array<{ u: string; d: string; ip: string | null; v: string }>;
    const r = rows[0];
    lines.push('✅ Connected.');
    lines.push(`   current_user      ${r?.u}`);
    lines.push(`   current_database  ${r?.d}`);
    lines.push(`   server_addr       ${r?.ip ?? '(via pooler)'}`);
    lines.push(`   server            ${(r?.v ?? '').split(' ').slice(0, 2).join(' ')}`);
    lines.push('');
    lines.push('DATABASE_URL is good — backfill scripts can connect. Proceed to step 4.');
    return { ok: true, lines };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    const code = e.code ?? '';
    const message = scrub(String(e.message ?? err), databaseUrl, password);
    lines.push('❌ Connection failed.');
    lines.push(`   error  ${code ? `[${code}] ` : ''}${message}`);
    lines.push('');
    lines.push(diagnose(code, message, { isPooler, isDirect, port }));
    return { ok: false, lines };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** Map a connection error to the concrete operator fix. */
function diagnose(
  code: string,
  message: string,
  ctx: { isPooler: boolean; isDirect: boolean; port: string },
): string {
  const m = message.toLowerCase();
  if (code === '28P01' || m.includes('password authentication failed')) {
    return [
      'Fix → wrong password (SASL/SCRAM auth rejected).',
      '  1. Supabase dashboard → Project Settings → Database → Reset database password',
      '     (pick "Generate a password" so it is URL-safe, or alphanumeric-only).',
      '  2. Copy the FULL connection string from the same page (Connection string →',
      '     "Session pooler" for an IPv4 box) and paste it into .env.local as DATABASE_URL,',
      '     quoted. Percent-encode any special character still in the password.',
      '  3. Re-run: pnpm tsx scripts/check-db.ts',
    ].join('\n');
  }
  if (m.includes('sasl') || m.includes('scram')) {
    return [
      'Fix → SASL/SCRAM handshake failed (auth). Treat as wrong/mis-encoded password:',
      '  reset the password in the dashboard, copy the Session-pooler string, and ensure',
      '  every special char is percent-encoded. Then re-run check-db.',
    ].join('\n');
  }
  if (m.includes('tenant or user not found')) {
    return [
      'Fix → pooler rejected the username. The Supavisor pooler needs',
      '  user `postgres.<project-ref>` (the ref is the lenysiqx… id), not bare `postgres`.',
      '  Copy the exact "Session pooler" connection string from the dashboard.',
    ].join('\n');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || m.includes('getaddrinfo')) {
    return [
      'Fix → host did not resolve. Check the host. If it is db.<ref>.supabase.co that',
      "  endpoint is IPv6-only; switch to the Session pooler host (aws-0-<region>.pooler.supabase.com).",
    ].join('\n');
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || m.includes('timeout')) {
    return ctx.isDirect
      ? [
          'Fix → connect timed out on the direct (IPv6-only) endpoint. This box is almost',
          '  certainly IPv4-only. Use the Session pooler connection string instead',
          '  (host aws-0-<region>.pooler.supabase.com, port 5432, user postgres.<ref>).',
        ].join('\n')
      : [
          'Fix → could not reach the server. Verify the host/port and that the project is',
          '  not paused (Supabase dashboard). Session pooler port is 5432, transaction 6543.',
        ].join('\n');
  }
  return [
    'Fix → unrecognized error. Verify the connection string against the dashboard',
    '  (Project Settings → Database → Connection string → Session pooler), confirm the',
    '  project is not paused, and re-run check-db.',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  probeDatabaseUrl(process.env['DATABASE_URL'])
    .then((res) => {
      for (const line of res.lines) console.log(line);
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('check-db crashed:', err?.message ?? err);
      process.exit(1);
    });
}
