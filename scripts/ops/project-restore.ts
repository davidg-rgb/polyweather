/**
 * project-restore.ts — un-pause (restore) a paused Supabase project via the Management API,
 * then poll until ACTIVE_HEALTHY. sb.ts-style: loads SUPABASE_ACCESS_TOKEN from .env.local
 * in-process so the token never appears in argv, logs, or chat. Needed because the MCP
 * connection is org-scoped and cannot see projects transferred to another org.
 *   pnpm tsx scripts/ops/project-restore.ts [project-ref]   (default: lenysiqxihsmxljvyybt)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/load-env.ts';

loadEnv();
const ref = process.argv[2] ?? 'lenysiqxihsmxljvyybt';
// Token source order: env (.env.local), then the CLI's own `supabase login` store —
// same account either way; the value stays in-process and is never printed.
let token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token && process.env.APPDATA) {
  try {
    token = readFileSync(join(process.env.APPDATA, 'supabase', 'access-token'), 'utf8').trim();
  } catch {
    /* fall through */
  }
}
if (!token) {
  console.error('no access token: set SUPABASE_ACCESS_TOKEN in .env.local or run `supabase login`');
  process.exit(1);
}
const api = 'https://api.supabase.com/v1';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const res = await fetch(`${api}/projects/${ref}/restore`, { method: 'POST', headers, body: '{}' });
// 201 = restore started; 400 with "not paused" means it is already running — treat as ok.
const body = await res.text();
if (!res.ok && !/not.*paused|already/i.test(body)) {
  console.error(`restore failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  process.exit(1);
}
console.log(`restore requested for ${ref}: HTTP ${res.status}`);

const deadline = Date.now() + 10 * 60_000;
for (;;) {
  const p = await fetch(`${api}/projects/${ref}`, { headers });
  if (p.ok) {
    const { status } = (await p.json()) as { status?: string };
    console.log(`  status: ${status}`);
    if (status === 'ACTIVE_HEALTHY') break;
  } else {
    console.log(`  status poll: HTTP ${p.status}`);
  }
  if (Date.now() > deadline) {
    console.error('timed out after 10 min waiting for ACTIVE_HEALTHY');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log('project is ACTIVE_HEALTHY');
