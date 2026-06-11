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
  await supabase.auth.getUser(); // triggers the refresh-token exchange when expired
  return response;
}

export const config = {
  // /api/health is the unauthenticated uptime probe (R-18) — skip the refresh.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|api/health).*)'],
};
