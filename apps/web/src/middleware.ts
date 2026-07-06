/**
 * Session-refresh middleware (§6.21) — the @supabase/ssr contract: the
 * middleware is the ONLY place that both reads and writes auth cookies, so
 * expired sessions are refreshed before any RSC loader runs. Route handlers
 * and RSC loaders read cookies but never write them.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'];
  if (!url || !key) return response; // unconfigured preview build — the page guard still redirects

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2]);
        }
      },
    },
  });

  // The token refresh is BEST-EFFORT and must NEVER block the page render. `supabase.auth.getUser()`
  // is a network call to the Supabase auth service; when that service is slow/degraded (a saturated
  // instance), an unbounded await here runs the whole middleware past Vercel's invocation limit and
  // 504s EVERY page with MIDDLEWARE_INVOCATION_TIMEOUT (2026-07-07 incident, prod down under DB load).
  // Bound it: on timeout/unreachable, skip the refresh and let the request through on its existing
  // cookies — the page's own auth guard still runs, and the next request retries the refresh.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      supabase.auth.getUser(), // triggers the refresh-token exchange when expired
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('auth-refresh-timeout')), AUTH_REFRESH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    /* slow/unreachable auth service → skip this refresh, never block the render */
  } finally {
    if (timer) clearTimeout(timer);
  }
  return response;
}

/** best-effort session-refresh budget — short enough to stay well under Vercel's middleware invocation
 *  limit so a degraded auth service can never 504 the site (2026-07-07 incident). */
const AUTH_REFRESH_TIMEOUT_MS = 2_500;

export const config = {
  // /api/health is the unauthenticated uptime probe (R-18) — skip the refresh.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|api/health).*)'],
};
