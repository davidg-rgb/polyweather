import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { notifySlack } from '../functions/_shared/slack.ts';
import { runJob, type JobStats } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const SECRET = 'runjob-test-secret-0123456789abcdef-xyz';
const HOOK = 'https://hooks.slack.com/services/T0/B0/RUNJOB';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env['CRON_SECRET'] = SECRET;
  process.env['SLACK_WEBHOOK_URL'] = HOOK;
});

afterEach(() => {
  delete process.env['CRON_SECRET'];
  delete process.env['SLACK_WEBHOOK_URL'];
  vi.unstubAllGlobals();
});

const reqWith = (secret?: string) =>
  new Request('https://x.supabase.co/functions/v1/test-job', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  });

/** Run and capture the background work so tests can await completion deterministically. */
function capturedWaitUntil(): { waitUntil: (p: Promise<void>) => void; done: () => Promise<void> } {
  let work: Promise<void> = Promise.resolve();
  return {
    waitUntil: (p) => {
      work = p;
    },
    done: () => work,
  };
}

describe('runJob (§6.12, ADR-02/12)', () => {
  it('401 without the cron secret; nothing is claimed', async () => {
    const res = await runJob('test-job', 'p401', reqWith('wrong-secret-wrong-secret-wrong!!'), async () => ({}), {
      db: port,
    });
    expect(res.status).toBe(401);
    const runs = await rows(db, `select 1 from job_runs where period_key = 'p401'`);
    expect(runs.length).toBe(0);
  });

  it('202 fast path: responds BEFORE the handler finishes, then records ok + stats', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let handlerDone = false;

    const cap = capturedWaitUntil();
    const handler = async (): Promise<JobStats> => {
      await gate;
      handlerDone = true;
      return { processed: 7 };
    };

    const res = await runJob('test-job', 'p202', reqWith(SECRET), handler, {
      db: port,
      waitUntil: cap.waitUntil,
    });
    expect(res.status).toBe(202);
    expect(handlerDone).toBe(false); // the response did not wait for the work

    release();
    await cap.done();

    const run = await rows<{ status: string; stats: { processed: number } }>(
      db,
      `select status, stats from job_runs where period_key = 'p202'`,
    );
    expect(run[0]!.status).toBe('ok');
    expect(run[0]!.stats.processed).toBe(7);
  });

  it('409 ERR_ALREADY_RAN on a re-POST of the same period', async () => {
    const cap = capturedWaitUntil();
    const first = await runJob('test-job', 'p409', reqWith(SECRET), async () => ({}), {
      db: port,
      waitUntil: cap.waitUntil,
    });
    expect(first.status).toBe(202);
    await cap.done();

    const second = await runJob('test-job', 'p409', reqWith(SECRET), async () => ({}), { db: port });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'ERR_ALREADY_RAN', decision: 'already_ran' });
  });

  it("failure → job_runs 'failed' + Slack CRITICAL; runJob never rethrows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const cap = capturedWaitUntil();
    const res = await runJob(
      'test-job',
      'pfail',
      reqWith(SECRET),
      async () => {
        throw new Error('upstream exploded');
      },
      { db: port, waitUntil: cap.waitUntil },
    );
    expect(res.status).toBe(202); // failure happens in the background
    await cap.done();

    const run = await rows<{ status: string; error: string }>(
      db,
      `select status, error from job_runs where period_key = 'pfail'`,
    );
    expect(run[0]!.status).toBe('failed');
    expect(run[0]!.error).toContain('upstream exploded');

    expect(fetchMock).toHaveBeenCalledWith(HOOK, expect.anything());
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      text: string;
    };
    expect(body.text).toContain('CRITICAL');
    expect(body.text).toContain('test-job failed');

    const alert = await rows<{ kind: string; sent: boolean }>(
      db,
      `select kind, sent from alerts_log where dedupe_key = 'job-fail:test-job:pfail'`,
    );
    expect(alert[0]!.kind).toBe('JOB_FAIL');
    expect(alert[0]!.sent).toBe(true);
  });

  it('a failed run is claimable again (taken_over) on the next cron fire', async () => {
    const retry = await runJob('test-job', 'pfail', reqWith(SECRET), async () => ({ recovered: true }), {
      db: port,
      waitUntil: (p) => void p.then(() => {}),
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ decision: 'taken_over', attempt: 2 });
  });
});

describe('notifySlack (§6.12, ADR-11)', () => {
  it('dedupe lifecycle: post-fail keeps the key → retry delivers → skip thereafter', async () => {
    const key = 'lifecycle:test';
    const alert = { kind: 'MODEL_DEGRADED', severity: 'WARN' as const, title: 'icon null', body: '3 runs', dedupeKey: key };

    // 1. webhook 500 → sent stays false (key NOT consumed)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })));
    expect(await notifySlack(port, alert)).toBe(false);
    let row = await rows<{ sent: boolean }>(db, `select sent from alerts_log where dedupe_key = '${key}'`);
    expect(row.length).toBe(1);
    expect(row[0]!.sent).toBe(false);

    // 2. retry with a healthy webhook → delivered, sent=true
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    expect(await notifySlack(port, alert)).toBe(true);
    row = await rows<{ sent: boolean }>(db, `select sent from alerts_log where dedupe_key = '${key}'`);
    expect(row.length).toBe(1); // same row reused, no duplicate
    expect(row[0]!.sent).toBe(true);

    // 3. same key again today → skip, webhook NOT called
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await notifySlack(port, alert)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Slack outage never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    await expect(
      notifySlack(port, { kind: 'X', severity: 'INFO', title: 't', body: 'b', dedupeKey: 'outage:test' }),
    ).resolves.toBe(false);
  });

  it('missing webhook env records the row unsent and returns false (resend sweep picks it up)', async () => {
    delete process.env['SLACK_WEBHOOK_URL'];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await notifySlack(port, { kind: 'X', severity: 'INFO', title: 't', body: 'b', dedupeKey: 'nohook:test' }),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await rows<{ sent: boolean }>(db, `select sent from alerts_log where dedupe_key = 'nohook:test'`);
    expect(row[0]!.sent).toBe(false);
  });
});
