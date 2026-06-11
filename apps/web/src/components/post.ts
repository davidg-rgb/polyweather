'use client';
/** Shared browser-side POST helper for the §8.2 operator routes. */

export interface PostResult {
  status: number;
  body: Record<string, unknown>;
}

export async function postJson(url: string, body?: Record<string, unknown>): Promise<PostResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON (e.g. CSV) — caller handles via status */
  }
  return { status: res.status, body: parsed };
}

/** Render an §8.2 error body into one operator-readable line. */
export function errText(r: PostResult): string {
  const e = r.body['error'];
  const details = r.body['details'];
  const reasons = r.body['reasons'];
  const parts: string[] = [`HTTP ${r.status}`];
  if (typeof e === 'string') parts.push(e);
  if (Array.isArray(details)) {
    parts.push(
      details
        .map((d) => (typeof d === 'string' ? d : `${(d as { key?: string }).key}: ${(d as { message?: string }).message}`))
        .join('; '),
    );
  }
  if (Array.isArray(reasons)) parts.push((reasons as string[]).join('; '));
  if (typeof r.body['status'] === 'string') parts.push(`status=${r.body['status'] as string}`);
  return parts.join(' — ');
}
