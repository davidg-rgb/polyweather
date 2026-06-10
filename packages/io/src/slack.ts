/**
 * packages/io/slack — slackPost + Block-Kit alert formatting (ARCHITECTURE.md §6.12).
 *
 * Raw webhook post, NO dedup — the DB-deduped path is functions/_shared
 * notifySlack; scripts use this directly for CLI output.
 */

export type AlertSeverity = 'INFO' | 'ACTION' | 'WARN' | 'CRITICAL';

export interface AlertMessage {
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  link?: string;
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  INFO: 'ℹ️',
  ACTION: '🎯',
  WARN: '⚠️',
  CRITICAL: '🚨',
};

/** Block-Kit payload for an alert — `text` is the notification fallback. */
export function buildAlertBlocks(alert: AlertMessage): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  const emoji = SEVERITY_EMOJI[alert.severity];
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} [${alert.severity}] ${alert.title}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: alert.body },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `kind: \`${alert.kind}\`` }],
    },
  ];
  if (alert.link) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${alert.link}|Open dashboard>` },
    });
  }
  return { text: `${emoji} [${alert.severity}] ${alert.title}`, blocks };
}

/**
 * POST a payload to a Slack incoming webhook. Returns true ONLY on HTTP 2xx
 * (ADR-11: callers flip dedupe state on success only). Never throws — a Slack
 * outage must never take a job down.
 */
export async function slackPost(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
