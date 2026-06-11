'use client';
/**
 * Supabase OTP login (§5): magic-link email to the single allow-listed
 * operator. The emailed link lands on /auth/confirm, which exchanges the
 * token for a session cookie; the (dash) layout guard does the allow-list
 * check — a session for any other email still bounces back here.
 */
import { useState, type ReactElement } from 'react';
import { browserClient } from '../../lib/supabase-browser.ts';

export default function LoginPage(): ReactElement {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const supabase = browserClient();
      const { error: e } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/confirm?next=/` },
      });
      if (e) setError(e.message);
      else setSent(true);
    } catch (e) {
      setError(String(e));
    } finally {
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
