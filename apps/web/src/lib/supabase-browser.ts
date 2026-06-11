/**
 * Browser-side Supabase client — used ONLY by the /login OTP form (§6.21).
 * Requires the NEXT_PUBLIC_* env twins (inlined at build time; the
 * server-only SUPABASE_URL/SUPABASE_ANON_KEY never reach the bundle).
 */
import { createBrowserClient } from '@supabase/ssr';

export function browserClient(): ReturnType<typeof createBrowserClient> {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing (§11.2)');
  }
  return createBrowserClient(url, key);
}
