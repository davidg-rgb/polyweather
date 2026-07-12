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

// Slack hard limits: a section block's text tops out at 3000 chars and a message at 50 blocks —
// a body over the limit (the daily digest runs 4-5k) made the webhook 400 and the alert sit at
// sent=false forever. Split on line boundaries under a safety margin; never mid-line unless a
// single line itself exceeds the limit.
const SECTION_CHAR_LIMIT = 2900;
const MAX_BODY_SECTIONS = 46; // 50-block cap minus header, context, and the optional link

function chunkBody(body: string): string[] {
  if (body.length <= SECTION_CHAR_LIMIT) return [body];
  const chunks: string[] = [];
  let cur = '';
  for (const line of body.split('\n')) {
    let piece = line;
    while (piece.length > SECTION_CHAR_LIMIT) {
      if (cur !== '') {
        chunks.push(cur);
        cur = '';
      }
      chunks.push(piece.slice(0, SECTION_CHAR_LIMIT));
      piece = piece.slice(SECTION_CHAR_LIMIT);
    }
    const joined = cur === '' ? piece : `${cur}\n${piece}`;
    if (joined.length > SECTION_CHAR_LIMIT) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur = joined;
    }
  }
  if (cur !== '') chunks.push(cur);
  if (chunks.length > MAX_BODY_SECTIONS) {
    return [...chunks.slice(0, MAX_BODY_SECTIONS - 1), '… (truncated: message exceeded the Slack block cap)'];
  }
  return chunks;
}

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
    ...chunkBody(alert.body).map((text) => ({
      type: 'section',
      text: { type: 'mrkdwn', text },
    })),
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
