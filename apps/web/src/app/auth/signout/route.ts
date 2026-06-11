import { NextResponse } from 'next/server';
import { serverClient } from '../../../lib/supabase.ts';

export async function POST(req: Request): Promise<Response> {
  const supabase = await serverClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', req.url), { status: 303 });
}
