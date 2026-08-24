/**
 * fn-trigger.ts — manually invoke an Edge Function the way pg_cron does: POST with
 * x-cron-secret. Loads SUPABASE_URL + CRON_SECRET from .env.local in-process (sb.ts
 * pattern) so neither appears in argv or output.
 *   pnpm tsx scripts/ops/fn-trigger.ts daily-digest
 */
import { loadEnv } from '../lib/load-env.ts';

loadEnv();
const fn = process.argv[2];
if (!fn) {
  console.error('usage: pnpm tsx scripts/ops/fn-trigger.ts <function-name>');
  process.exit(1);
}
const base = process.env.SUPABASE_URL;
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  console.error('SUPABASE_URL or CRON_SECRET missing from env (.env.local)');
  process.exit(1);
}
const res = await fetch(`${base.replace(/\/$/, '')}/functions/v1/${fn}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
  body: '{}',
});
const text = await res.text();
console.log(`${fn}: HTTP ${res.status}`);
console.log(text.slice(0, 2000));
process.exit(res.ok ? 0 : 1);
