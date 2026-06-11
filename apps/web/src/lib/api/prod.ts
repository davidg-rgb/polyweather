/**
 * Production ApiDeps binding (ARCHITECTURE.md §8.2, §11.5).
 *
 * The DB port is RLS-scoped: a Supabase client authenticated by the caller's
 * session cookie (parsed straight from the Request — route handlers never
 * need next/headers). Writes only succeed through the 0021 SECURITY DEFINER
 * operator_* RPCs, whose is_operator() guard re-checks the same email in SQL.
 * CRON_SECRET is attached server-side for the execute-bet / trigger-job
 * proxies and never reaches the browser (ADR-10).
 */
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import { buildAlertBlocks, slackPost } from '@weather-edge/io';
import { webPort, type SupabaseishClient } from '../port.ts';
import type { ApiDeps, WebAlert, WebDb } from './deps.ts';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing from web environment (§11.2)`);
  return v;
}

/** notifySlack's web twin: alerts_log dedupe via RPC + webhook post (ADR-11). */
async function webNotify(db: WebDb, alert: WebAlert): Promise<boolean> {
  try {
    const [claim] = await db.rpc<{ decision: string; alert_id: string | null }>('claim_alert', {
      p_kind: alert.kind,
      p_severity: alert.severity,
      p_dedupe_key: alert.dedupeKey ?? null,
      p_title: alert.title,
      p_body: alert.body,
    });
    if (!claim || claim.decision === 'skip') return false;
    const webhook = process.env['SLACK_WEBHOOK_URL'];
    if (!webhook) return false;
    const delivered = await slackPost(webhook, buildAlertBlocks(alert));
    if (delivered && claim.alert_id) {
      await db.rpc('mark_alert_sent', { p_alert_id: claim.alert_id });
    }
    return delivered;
  } catch {
    return false; // alerting must never break an operator action
  }
}

export function prodDeps(req: Request): ApiDeps {
  const client = createServerClient(need('SUPABASE_URL'), need('SUPABASE_ANON_KEY'), {
    cookies: {
      getAll: () => parseCookieHeader(req.headers.get('cookie') ?? '')
        .map((c) => ({ name: c.name, value: c.value ?? '' })),
      // Route handlers never refresh sessions — the RSC layer owns cookie writes.
      setAll: () => {},
    },
  }) as unknown as SupabaseishClient;
  const db = webPort(client);

  const edgeHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-cron-secret': need('CRON_SECRET'),
  });

  return {
    db,
    getSessionEmail: async () => {
      const { data } = await client.auth.getUser();
      return data.user?.email ?? null;
    },
    operatorEmail: need('OPERATOR_EMAIL'),
    proxyExecuteBet: (body) =>
      fetch(`${need('SUPABASE_URL')}/functions/v1/execute-bet`, {
        method: 'POST',
        headers: edgeHeaders(),
        body: JSON.stringify(body),
      }),
    proxyTriggerJob: (job, periodKey) =>
      fetch(`${need('SUPABASE_URL')}/functions/v1/${job}`, {
        method: 'POST',
        headers: edgeHeaders(),
        body: JSON.stringify({ periodKey }),
      }),
    notify: (alert) => webNotify(db, alert),
    now: () => new Date(),
  };
}
