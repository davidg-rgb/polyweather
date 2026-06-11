/**
 * RSC-side Supabase helpers (§6.21, §11.5): the anon-key session client built
 * from next/headers cookies — RLS-scoped, never the service role. The browser
 * twin lives in supabase-browser.ts (login page only).
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { webPort, type SupabaseishClient } from './port.ts';
import type { WebDb } from './api/deps.ts';

function env(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`${names[0]} missing from web environment (§11.2)`);
}

export async function serverClient(): Promise<SupabaseishClient & {
  auth: SupabaseishClient['auth'] & {
    verifyOtp(args: { type: 'email'; token_hash: string }): Promise<{ error: { message: string } | null }>;
    exchangeCodeForSession(code: string): Promise<{ error: { message: string } | null }>;
    signOut(): Promise<{ error: { message: string } | null }>;
  };
}> {
  const store = await cookies();
  const client = createServerClient(
    env('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
    env('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
          // Writable in Route Handlers (auth/confirm, auth/signout); throws in
          // RSC renders, where the middleware owns cookie refresh writes.
          try {
            for (const { name, value, options } of cookiesToSet) {
              store.set(name, value, options as Parameters<typeof store.set>[2]);
            }
          } catch {
            /* RSC render — middleware handles refresh */
          }
        },
      },
    },
  );
  return client as unknown as Awaited<ReturnType<typeof serverClient>>;
}

/** The RLS-scoped WebDb port for RSC loaders. */
export async function serverDb(): Promise<WebDb> {
  return webPort(await serverClient());
}

export async function sessionEmail(): Promise<string | null> {
  const client = await serverClient();
  const { data } = await client.auth.getUser();
  return data.user?.email ?? null;
}

/**
 * The (dash) layout guard (§6.21): only the single allow-listed operator
 * (env OPERATOR_EMAIL) gets past — everyone else lands on /login.
 */
export async function requireOperator(): Promise<string> {
  const email = await sessionEmail();
  const operator = process.env['OPERATOR_EMAIL'];
  if (!email || !operator || email !== operator) redirect('/login');
  return email;
}
