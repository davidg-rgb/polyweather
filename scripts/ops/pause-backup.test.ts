/**
 * Tests for the pure helpers behind scripts/ops/pause-backup — the three pieces whose
 * silent failure would make a backup LOOK verified when it is not: the pooler-URL
 * rewrite (wrong host = no dump at all), the COPY row counter (the whole verification
 * rests on it), and the cron SQL regeneration (a bad quote = an unrestorable schedule).
 * No DB, no filesystem, no network. Passwords here are fabricated.
 */
import { describe, it, expect } from 'vitest';
import {
  cronRecreateSql,
  deriveSessionPoolerUrl,
  dollarQuote,
  makeCopyRowCounter,
  parseEdgeSecretNames,
  parseFunctionsList,
  projectRefFromUrl,
  redactConninfo,
  unrecordedMigrations,
} from './pause-backup.ts';

const DIRECT = 'postgresql://postgres:pw-not-real@db.abc123xyz.supabase.co:5432/postgres';

describe('deriveSessionPoolerUrl', () => {
  it('rewrites a direct Supabase host into the session-pooler form, keeping the password', () => {
    expect(deriveSessionPoolerUrl(DIRECT)).toBe(
      'postgresql://postgres.abc123xyz:pw-not-real@aws-0-eu-north-1.pooler.supabase.com:5432/postgres',
    );
  });

  it('honours a non-default region and preserves query params (sslmode etc.)', () => {
    expect(deriveSessionPoolerUrl(`${DIRECT}?sslmode=require`, 'us-east-1')).toBe(
      'postgresql://postgres.abc123xyz:pw-not-real@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
    );
  });

  it('returns null when there is nothing to derive — already pooled, or not Supabase', () => {
    expect(deriveSessionPoolerUrl('postgresql://postgres.abc123xyz:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres')).toBeNull();
    expect(deriveSessionPoolerUrl('postgresql://postgres:pw@localhost:5432/postgres')).toBeNull();
    expect(deriveSessionPoolerUrl('not a url')).toBeNull();
  });
});

describe('projectRefFromUrl', () => {
  it('reads the ref out of either conninfo form', () => {
    expect(projectRefFromUrl(DIRECT)).toBe('abc123xyz');
    expect(projectRefFromUrl(deriveSessionPoolerUrl(DIRECT)!)).toBe('abc123xyz');
    expect(projectRefFromUrl('postgresql://postgres:pw@localhost:5432/postgres')).toBeNull();
  });
});

describe('redactConninfo', () => {
  it('strips a conninfo that leaked into child stderr', () => {
    const out = redactConninfo(`pg_dump: error: connection to "${DIRECT}" failed`);
    expect(out).not.toContain('pw-not-real');
    expect(out).toContain('REDACTED');
  });
});

describe('makeCopyRowCounter', () => {
  const feedAll = (lines: string[]) => {
    const c = makeCopyRowCounter();
    for (const l of lines) c.feed(l);
    return c;
  };

  it('counts payload rows per table between the COPY header and its terminator', () => {
    const c = feedAll([
      '--',
      'SET session_replication_role = replica;',
      'COPY public.config (key, value) FROM stdin;',
      'a\t1',
      'b\t2',
      '\\.',
      '',
      'COPY public.empty_table (id) FROM stdin;',
      '\\.',
      'COPY supabase_migrations.schema_migrations (version, name, statements) FROM stdin;',
      '20260101\tinit\t{}',
      '\\.',
    ]);
    expect(c.counts).toEqual({
      'public.config': 2,
      'public.empty_table': 0,
      'supabase_migrations.schema_migrations': 1,
    });
    expect(c.open).toBe(false);
  });

  it('does not treat payload that looks like SQL as a new COPY block', () => {
    const c = feedAll([
      'COPY public.opening_captures (payload) FROM stdin;',
      'COPY public.other (x) FROM stdin;', // a single-column row whose text IS a header
      '{"sql": "COPY public.other (x) FROM stdin;"}',
      '\\\\.', // an escaped backslash-dot — payload, not the terminator
      '\\.',
      'COPY public.other (x) FROM stdin;',
      '1',
      '\\.',
    ]);
    expect(c.counts).toEqual({ 'public.opening_captures': 3, 'public.other': 1 });
  });

  it('unquotes quoted identifiers and flags a truncated dump', () => {
    const c = feedAll(['COPY "public"."order" (id) FROM stdin;', '1']);
    expect(c.counts).toEqual({ 'public.order': 1 });
    expect(c.open).toBe(true);
  });
});

describe('dollarQuote', () => {
  it('wraps a plain body in the base tag', () => {
    expect(dollarQuote('select 1')).toBe('$cron$select 1$cron$');
  });

  it('escalates the tag until it cannot collide with the body', () => {
    expect(dollarQuote('a $cron$ b')).toBe('$cron0$a $cron$ b$cron0$');
    expect(dollarQuote('a $cron$ b $cron0$ c')).toBe('$cron1$a $cron$ b $cron0$ c$cron1$');
  });
});

describe('cronRecreateSql', () => {
  const job = (over: Partial<Parameters<typeof cronRecreateSql>[0][number]>) => ({
    jobid: 1,
    jobname: 'poll-markets',
    schedule: '*/5 * * * *',
    command: "select net.http_post(url := 'https://x.fn/poll');",
    active: true,
    ...over,
  });

  it('unschedules before scheduling so a migration-created job is superseded, not duplicated', () => {
    const sql = cronRecreateSql([job({})], new Date('2026-08-24T00:00:00Z'));
    expect(sql).toContain("select cron.unschedule('poll-markets') where exists");
    expect(sql.indexOf('cron.unschedule')).toBeLessThan(sql.indexOf('cron.schedule'));
    expect(sql).toContain("select cron.schedule('poll-markets', '*/5 * * * *', $cron$select net.http_post(url := 'https://x.fn/poll');$cron$);");
  });

  it("escapes single quotes in the job name and dollar-quotes a command containing $$", () => {
    const sql = cronRecreateSql([job({ jobname: "o'brien", command: 'do $$ begin end $$;' })]);
    expect(sql).toContain("cron.unschedule('o''brien')");
    expect(sql).toContain('$cron$do $$ begin end $$;$cron$');
  });

  it('restores an inactive job in its inactive state', () => {
    expect(cronRecreateSql([job({ active: false })])).toContain(
      "update cron.job set active = false where jobname = 'poll-markets';",
    );
  });

  it('emits an unnamed job commented out rather than creating an unaddressable duplicate', () => {
    const sql = cronRecreateSql([job({ jobname: null })]);
    expect(sql).toContain('UNNAMED JOB');
    expect(sql).not.toMatch(/^select cron\.schedule/m);
  });
});

describe('parseEdgeSecretNames', () => {
  // Shape of a real `supabase secrets list`: JSON behind an npm banner, `value` = digest.
  const stdout =
    'npm warn Unknown env config\n' +
    '{"secrets":[{"name":"SLACK_WEBHOOK_URL","value":"deadbeef","updated_at":"2026-06-30T21:12:25.342Z"},' +
    '{"name":"CRON_SECRET","value":"cafebabe","updated_at":"2026-06-30T21:12:25.342Z"}],"message":""}';

  it('keeps names and drops the digest, sorted', () => {
    const out = parseEdgeSecretNames(stdout);
    expect(out.map((s) => s.name)).toEqual(['CRON_SECRET', 'SLACK_WEBHOOK_URL']);
    expect(JSON.stringify(out)).not.toContain('deadbeef');
  });

  it('keeps mixed-case names (the project has some) and survives unparseable output', () => {
    expect(parseEdgeSecretNames('{"secrets":[{"name":"checkwxapi_API_KEY","value":"x"}]}')[0]!.name).toBe('checkwxapi_API_KEY');
    expect(parseEdgeSecretNames('Error: not logged in')).toEqual([]);
    expect(parseEdgeSecretNames('{oops')).toEqual([]);
  });
});

describe('parseFunctionsList', () => {
  it('parses the JSON array behind a banner, and yields [] when there is none', () => {
    expect(parseFunctionsList('npm warn x\n[{"slug":"poll-markets","version":3}]')).toEqual([
      { slug: 'poll-markets', version: 3 },
    ]);
    expect(parseFunctionsList('Error: unauthorized')).toEqual([]);
    expect(parseFunctionsList('[{broken')).toEqual([]);
  });
});

describe('unrecordedMigrations', () => {
  it('diffs repo migration files against the recorded history by name, sorted', () => {
    expect(
      unrecordedMigrations(
        ['0001_init.sql', '0003_late.sql', '0002_mid.sql', 'README.md'],
        ['0001_init', '0002_mid'],
      ),
    ).toEqual(['0003_late']);
  });
});
