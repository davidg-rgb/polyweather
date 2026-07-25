/**
 * synoptic-set-secret — one-off ops: copy SYNOPTIC_PUBLIC_TOKEN from the local
 * .env.local into the Supabase Edge secrets, WITHOUT the value ever being
 * printed (loadEnv in-process → spawned authenticated CLI; stdout/stderr are
 * scanned and redacted before display). Re-runnable; idempotent.
 *
 * Usage: pnpm tsx scripts/ops/synoptic-set-secret.ts
 */
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../lib/load-env';

const PROJECT_REF = 'lenysiqxihsmxljvyybt';

loadEnv();
const token = process.env.SYNOPTIC_PUBLIC_TOKEN ?? '';
if (!token) {
  console.error('SYNOPTIC_PUBLIC_TOKEN not in local env — nothing to set.');
  process.exit(1);
}

const res = spawnSync(
  'npx',
  ['supabase', 'secrets', 'set', `SYNOPTIC_PUBLIC_TOKEN=${token}`, '--project-ref', PROJECT_REF],
  { encoding: 'utf8', shell: true },
);

const redact = (s: string | null) => (s ?? '').split(token).join('TOKEN_REDACTED').trim();
console.log('exit:', res.status);
if (res.stdout) console.log(redact(res.stdout));
if (res.stderr) console.error(redact(res.stderr));
process.exit(res.status ?? 1);
