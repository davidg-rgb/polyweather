import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAlertBlocks, slackPost } from '../src/slack.ts';

const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('slackPost (§6.12)', () => {
  it('POSTs JSON and returns true only on 2xx', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mock);
    await expect(slackPost(HOOK, { text: 'hi' })).resolves.toBe(true);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hi' });
  });

  it('returns false on non-2xx (ADR-11: dedupe key not consumed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no_service', { status: 404 })));
    await expect(slackPost(HOOK, { text: 'hi' })).resolves.toBe(false);
  });

  it('never throws — a Slack outage must not take a job down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    await expect(slackPost(HOOK, { text: 'hi' })).resolves.toBe(false);
  });
});

describe('buildAlertBlocks (§6.12)', () => {
  it('renders header, body, kind context, and the severity emoji', () => {
    const { text, blocks } = buildAlertBlocks({
      kind: 'JOB_FAIL',
      severity: 'CRITICAL',
      title: 'poll-markets failed',
      body: 'UpstreamError: HTTP 503 from clob.polymarket.com',
    });
    expect(text).toContain('🚨');
    expect(text).toContain('[CRITICAL] poll-markets failed');
    expect(blocks.length).toBe(3);
    expect(JSON.stringify(blocks)).toContain('JOB_FAIL');
    expect(JSON.stringify(blocks)).toContain('clob.polymarket.com');
  });

  it('appends a dashboard link section when a link is present', () => {
    const { blocks } = buildAlertBlocks({
      kind: 'BET_REC',
      severity: 'ACTION',
      title: 'New recommendation',
      body: 'NYC 94-95F — edge 9.1%',
      link: 'https://weather-edge.vercel.app/events/nyc-jun-11',
    });
    expect(blocks.length).toBe(4);
    expect(JSON.stringify(blocks.at(-1))).toContain('weather-edge.vercel.app');
  });

  it('each severity maps to its own emoji', () => {
    const emojis = (['INFO', 'ACTION', 'WARN', 'CRITICAL'] as const).map(
      (severity) => buildAlertBlocks({ kind: 'X', severity, title: 't', body: 'b' }).text.split(' ')[0],
    );
    expect(new Set(emojis).size).toBe(4);
  });

  // Slack 400s a section over 3000 chars — the daily digest (4-5k chars) was NEVER delivered until
  // long bodies were split across sections (found 2026-07-12: every DAILY_DIGEST row ever was sent=false).
  it('splits a long body across multiple ≤3000-char section blocks on line boundaries', () => {
    const line = 'x'.repeat(100);
    const body = Array.from({ length: 60 }, () => line).join('\n'); // 6059 chars
    const { blocks } = buildAlertBlocks({ kind: 'DAILY_DIGEST', severity: 'INFO', title: 'd', body });
    const sections = blocks.filter((b) => b['type'] === 'section');
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      const text = (s['text'] as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(3000);
      // line-boundary splits: every chunk is whole lines, never a torn line
      for (const l of text.split('\n')) expect(l).toBe(line);
    }
    // nothing lost: the chunks reassemble to the original body
    expect(sections.map((s) => (s['text'] as { text: string }).text).join('\n')).toBe(body);
  });

  it('hard-splits a single line longer than the section limit', () => {
    const body = 'y'.repeat(7000);
    const { blocks } = buildAlertBlocks({ kind: 'X', severity: 'INFO', title: 't', body });
    const sections = blocks.filter((b) => b['type'] === 'section');
    expect(sections.length).toBe(3);
    expect(sections.map((s) => (s['text'] as { text: string }).text).join('')).toBe(body);
  });

  it('caps the block count under the Slack 50-block message limit', () => {
    const body = Array.from({ length: 300 }, () => 'z'.repeat(2900)).join('\n');
    const { blocks } = buildAlertBlocks({
      kind: 'X',
      severity: 'INFO',
      title: 't',
      body,
      link: 'https://weather-edge.vercel.app',
    });
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(blocks)).toContain('truncated');
  });

  it('keeps a short body as a single section (payload shape unchanged)', () => {
    const { blocks } = buildAlertBlocks({ kind: 'X', severity: 'INFO', title: 't', body: 'short' });
    expect(blocks.filter((b) => b['type'] === 'section').length).toBe(1);
    expect(blocks.length).toBe(3);
  });
});
