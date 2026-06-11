/**
 * functions/_shared/slack — notifySlack: DB dedupe + webhook post
 * (ARCHITECTURE.md §6.12, ADR-11).
 */
import { buildAlertBlocks, slackPost, type AlertSeverity } from '../../../packages/io/src/index.ts';
import { getEnv } from './auth.ts';
import type { DbPort } from './db.ts';

export type AlertKind = string; // 'JOB_FAIL' | 'BET_REC' | 'RESOLUTION' | 'STATION_CHANGE' | …

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  link?: string;
  dedupeKey?: string;
}

/**
 * Post a Block-Kit alert to SLACK_WEBHOOK_URL with day-level dedupe:
 * insert alerts_log sent=false first (skip when today's key already sent,
 * reuse the unsent row otherwise) → post → flip sent=true on HTTP 2xx ONLY
 * (ADR-11: a failed post never consumes the dedupe key — the health-monitor
 * resend sweep delivers unsent rows). A Slack outage, a missing webhook, or a
 * DB hiccup logs and returns — this function NEVER throws.
 *
 * Returns true when the message reached Slack (BET_REC callers record this on
 * the bet's audit).
 */
export async function notifySlack(db: DbPort, alert: Alert): Promise<boolean> {
  try {
    const claims = await db.rpc<{ decision: string; alert_id: string | null }>('claim_alert', {
      p_kind: alert.kind,
      p_severity: alert.severity,
      p_dedupe_key: alert.dedupeKey ?? null,
      p_title: alert.title,
      p_body: alert.body,
    });
    const claim = claims[0];
    if (!claim || claim.decision === 'skip') return false;

    const webhook = getEnv('SLACK_WEBHOOK_URL');
    if (!webhook) {
      console.error(JSON.stringify({ msg: 'SLACK_WEBHOOK_URL unset — alert recorded unsent', kind: alert.kind }));
      return false;
    }

    const delivered = await slackPost(webhook, buildAlertBlocks(alert));
    if (delivered && claim.alert_id) {
      await db.rpc('mark_alert_sent', { p_alert_id: claim.alert_id });
    }
    return delivered;
  } catch (e) {
    console.error(JSON.stringify({ msg: 'notifySlack failed (never throws)', error: String(e) }));
    return false;
  }
}

/**
 * ADR-11 resend sweep (health-monitor §6.19): re-post alerts_log rows that
 * are still sent=false after `olderThanMin` — a failed post never consumed
 * the dedupe key, so this is what eventually delivers it. `post` is the raw
 * webhook poster (deps-injected; production = slackPost to SLACK_WEBHOOK_URL).
 * Flips sent=true on 2xx ONLY; never throws. Returns the resent count.
 */
export async function resendUnsentAlerts(
  db: DbPort,
  olderThanMin: number,
  post: (alert: Alert) => Promise<boolean>,
): Promise<number> {
  let resent = 0;
  try {
    const unsent = await db.rpc<{ id: string; kind: string; severity: AlertSeverity; title: string; body: string }>(
      'list_unsent_alerts',
      { p_older_min: olderThanMin },
    );
    for (const row of unsent) {
      const delivered = await post({ kind: row.kind, severity: row.severity, title: row.title, body: row.body });
      if (delivered) {
        await db.rpc('mark_alert_sent', { p_alert_id: row.id });
        resent++;
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ msg: 'resendUnsentAlerts failed (never throws)', error: String(e) }));
  }
  return resent;
}
