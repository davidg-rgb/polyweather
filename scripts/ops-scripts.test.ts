/**
 * §6.22 ops scripts (§15):
 * - smoke-live-apis: the full harness against the REAL research fixtures (one
 *   assertion per integration), drift detection naming the failed upstream,
 *   Slack skip-until-webhook;
 * - backup-db: gzip round-trip restorability + the F-037 retention-of-8 sweep
 *   + same-day overwrite + empty-dump refusal.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { backupDb, DEFAULT_KEEP } from './backup-db.ts';
import { smokeLiveApis, type SmokeDeps } from './smoke-live-apis.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'research');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const NOW = new Date('2026-06-11T12:00:00Z');

/** Fixture-backed router for every live endpoint the smoke test hits. */
function routeFixture(url: string): unknown {
  if (url.includes('active=true')) return fixture('gamma-events-tag104596-active.json');
  if (url.includes('closed=true')) {
    const raw = fixture('gamma-event-nyc-jun9-resolved.json');
    return Array.isArray(raw) ? raw : [raw];
  }
  if (url.includes('/book')) return fixture('clob-book-nyc-94-95f.json');
  if (url.includes('/prices-history')) return fixture('clob-prices-history.json');
  if (url.includes('previous-runs-api')) return fixture('openmeteo_prevruns_hourly_single_model_RKSI.json');
  if (url.includes('/v1/ensemble')) return fixture('openmeteo_ensemble_daily_max_RKSI.json');
  if (url.includes('/v1/archive')) return fixture('openmeteo_era5_archive_daily_RKSI.json');
  if (url.includes('/static/meta.json')) return { last_run_initialisation_time: 1_781_000_000 };
  if (url.includes('/v1/forecast')) return fixture('openmeteo_forecast_multimodel_daily_RKSI.json');
  if (url.includes('api.weather.com')) return fixture('wunderground_api_v1_obs_historical_KORD_2026-06-09_unitsE.json');
  if (url.includes('aviationweather.gov')) return fixture('aviationweather_metar_RKSI.json');
  if (url.includes('mesonet.agron.iastate.edu')) return fixture('iem_daily_ORD_2026-06-08.json');
  throw new Error(`unrouted url in test: ${url}`);
}

const deps = (over: Partial<SmokeDeps> = {}): SmokeDeps => ({
  fetchJson: async (url) => routeFixture(url),
  fetchText: async () => readFileSync(join(FIXTURES, 'wunderground_history_RKSI_2026-06-09.html'), 'utf8'),
  postSlack: async () => true,
  env: () => undefined,
  now: () => NOW,
  log: () => {},
  ...over,
});

describe('smoke-live-apis (§6.22, §15 one-assertion-per-integration)', () => {
  it('every integration passes through its REAL parser on the research fixtures', async () => {
    const { results, failures } = await smokeLiveApis(deps());
    expect(failures).toBe(0);
    const byName = new Map(results.map((r) => [r.name, r]));
    expect(byName.get('gamma_active_events')!.detail).toMatch(/parsed '.*' \(11 buckets\)/);
    expect(byName.get('gamma_closed_events')!.ok).toBe(true);
    expect(byName.get('clob_book')!.detail).toContain('book normalized');
    expect(byName.get('clob_prices_history')!.detail).toBe('41 price points');
    expect(byName.get('openmeteo_forecast_multimodel')!.ok).toBe(true);
    expect(byName.get('openmeteo_prevruns_single_model')!.detail).toContain('single-model suffix quirk');
    expect(byName.get('openmeteo_ensemble')!.detail).toMatch(/^51 members/);
    expect(byName.get('openmeteo_era5_archive')!.ok).toBe(true);
    expect(byName.get('openmeteo_model_meta')!.detail).toContain('last run');
    expect(byName.get('wu_key_extraction_and_obs')!.detail).toContain('max 87°F'); // the live-verified KORD case
    expect(byName.get('aviationweather_metar')!.ok).toBe(true);
    expect(byName.get('iem_daily')!.detail).toMatch(/ORD max \d+/);
    // Slack: skipped-with-note until the operator creates the webhook
    expect(byName.get('slack_webhook')).toMatchObject({ ok: true, skipped: true });
    expect(byName.get('slack_webhook')!.detail).toContain('Operator TODO');
  });

  it('shape drift fails loudly and NAMES the integration', async () => {
    const logs: string[] = [];
    const { results, failures } = await smokeLiveApis(
      deps({
        fetchJson: async (url) => (url.includes('/book') ? {} : routeFixture(url)),
        log: (m) => logs.push(m),
      }),
    );
    expect(failures).toBe(1);
    const book = results.find((r) => r.name === 'clob_book')!;
    expect(book.ok).toBe(false);
    expect(book.detail).toContain('ClobShapeError');
    expect(logs.join('\n')).toContain('1 INTEGRATION(S) DRIFTED — clob_book');
    // every other integration still ran (no fail-fast cascade)
    expect(results.filter((r) => r.ok).length).toBe(results.length - 1);
  });

  it('with the webhook set, the Slack probe must be 2xx-acknowledged', async () => {
    const ok = await smokeLiveApis(deps({ env: (n) => (n === 'SLACK_WEBHOOK_URL' ? 'https://hooks.example/x' : undefined) }));
    expect(ok.results.find((r) => r.name === 'slack_webhook')).toMatchObject({ ok: true, skipped: false });
    const bad = await smokeLiveApis(
      deps({
        env: (n) => (n === 'SLACK_WEBHOOK_URL' ? 'https://hooks.example/x' : undefined),
        postSlack: async () => false,
      }),
    );
    expect(bad.results.find((r) => r.name === 'slack_webhook')!.ok).toBe(false);
  });
});

describe('backup-db (§6.22, F-037)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'we-backup-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const day = (n: number): Date => new Date(Date.UTC(2026, 5, n, 3, 0, 0));

  it('writes a gzip whose round-trip restores the exact dump bytes (restorable)', async () => {
    const sql = `-- weather-edge dump\ncreate table bets (...);\ninsert into bets values ('evidence');\n`;
    const r = await backupDb(
      { dir },
      { dump: async () => Buffer.from(sql, 'utf8'), databaseUrl: 'postgres://x', log: () => {}, now: () => day(1) },
    );
    expect(r.path.endsWith('2026-06-01.sql.gz')).toBe(true);
    expect(gunzipSync(readFileSync(r.path)).toString('utf8')).toBe(sql);
  });

  it('keeps the newest 8 and prunes the oldest (F-037); same-day re-runs overwrite', async () => {
    for (let n = 2; n <= 9; n++) {
      await backupDb(
        { dir },
        { dump: async () => Buffer.from(`-- dump ${n}`), databaseUrl: 'x', log: () => {}, now: () => day(n) },
      );
    }
    // days 1..9 written; the day-9 run pruned the oldest (06-01) down to keep=8
    let files = readdirSync(dir).filter((f) => f.endsWith('.sql.gz')).sort();
    expect(files).toHaveLength(DEFAULT_KEEP);
    expect(files[0]).toBe('2026-06-02.sql.gz');
    expect(files.at(-1)).toBe('2026-06-09.sql.gz');

    // same-day overwrite: still 8 files, content replaced
    await backupDb(
      { dir },
      { dump: async () => Buffer.from('-- dump 9 v2'), databaseUrl: 'x', log: () => {}, now: () => day(9) },
    );
    files = readdirSync(dir).filter((f) => f.endsWith('.sql.gz'));
    expect(files).toHaveLength(8);
    expect(gunzipSync(readFileSync(join(dir, '2026-06-09.sql.gz'))).toString('utf8')).toBe('-- dump 9 v2');
  });

  it('refuses to write an empty dump', async () => {
    await expect(
      backupDb({ dir }, { dump: async () => Buffer.alloc(0), databaseUrl: 'x', log: () => {}, now: () => day(10) }),
    ).rejects.toThrow(/zero bytes/);
  });
});
