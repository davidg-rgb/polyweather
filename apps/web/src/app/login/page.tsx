'use client';
/**
 * Supabase OTP login (§5): magic-link email to the single allow-listed
 * operator. The emailed link lands on /auth/confirm, which exchanges the
 * token for a session cookie; the (dash) layout guard does the allow-list
 * check — a session for any other email still bounces back here.
 */
import { useState, useEffect, type ReactElement } from 'react';
import { browserClient } from '../../lib/supabase-browser.ts';

/** send-link budget — a degraded/DB-loaded auth service can leave signInWithOtp pending; without a
 *  bound the button just sits in `busy` ("nothing happens", 2026-07-07 report). */
const SEND_TIMEOUT_MS = 12_000;

export default function LoginPage(): ReactElement {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // surface the /auth/confirm failure bounce (?error=confirm) so an invalid/expired magic link is
  // not a silent no-op back on this page.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('error') === 'confirm') {
      setError('That sign-in link was invalid or expired — request a new one below.');
    }
  }, []);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const supabase = browserClient();
      const { error: e } = await Promise.race([
        supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${window.location.origin}/auth/confirm?next=/` },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('send-timeout')), SEND_TIMEOUT_MS);
        }),
      ]);
      // a degraded/5xx auth response can carry a BLANK message — never render empty error brackets.
      if (e) setError(e.message?.trim() || 'Could not reach the sign-in service (it may be busy). Try again in a moment.');
      else setSent(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg === 'send-timeout'
          ? 'The sign-in service did not respond in time (it may be busy). Try again in a moment.'
          : msg.trim() || 'Something went wrong sending the link. Try again.',
      );
    } finally {
      if (timer) clearTimeout(timer);
      setBusy(false);
    }
  };

  return (
    <div className="login-box panel">
      <h1>Weather Edge</h1>
      {sent ? (
        <p className="form-ok">Magic link sent — check your inbox and open it in this browser.</p>
      ) : (
        <>
          <p className="muted small">Operator login (allow-listed email only).</p>
          <div className="form-row">
            <input
              type="email"
              placeholder="operator email"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && email) void send();
              }}
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={busy || !email} onClick={() => void send()}>
              send link
            </button>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
        </>
      )}
    </div>
  );
}
