/**
 * Magic-link landing: exchanges the emailed credential for a session cookie.
 * Handles both Supabase callback shapes — ?code= (PKCE) and ?token_hash=
 * (OTP template) — then redirects to the dashboard; failures land back on
 * /login with an error flag.
 */
import { NextResponse } from 'next/server';
import { serverClient } from '../../../lib/supabase.ts';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = url.searchParams.get('next') ?? '/';
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');

  const supabase = await serverClient();
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  } else if (tokenHash) {
    const { error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL('/login?error=confirm', url.origin));
}
