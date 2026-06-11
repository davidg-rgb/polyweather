/**
 * scripts/smoke-live-apis — one LIVE call per upstream integration, each
 * asserted through the REAL parser (§6.22, §15: "one assertion per
 * integration; fails loudly on shape drift"). Run before every deploy and
 * weekly; a failure names exactly which upstream changed shape.
 *
 * Integrations: Gamma (active + closed pages), CLOB (book + prices-history),
 * Open-Meteo (multi-model daily, single-model previous-runs [the bare-key
 * quirk], ensemble, ERA5 archive, per-model meta.json), Weather Underground
 * (runtime key extraction + hourly obs), aviationweather METAR, IEM daily,
 * Slack webhook (test message; counted skipped until SLACK_WEBHOOK_URL
 * exists — Operator TODO).
 *
 * Run: pnpm tsx scripts/smoke-live-apis.ts
 */
import { pathToFileURL } from 'node:url';
import {
  archiveUrl,
  ensembleUrl,
  extractWuApiKey,
  forecastUrl,
  iemDailyUrl,
  normalizeBook,
  parseEnsembleDaily,
  parseEra5Daily,
  parseGammaEvent,
  parseIemDaily,
  parseMetarJson,
  parseMultiModelDaily,
  parsePreviousRunsHourly,
  parsePricesHistory,
  parseStringArray,
  parseWuObservations,
  previousRunsUrl,
  wuDailyMax,
  wuObsUrl,
  type ParsedEvent,
  type RawClobBook,
  type RawGammaEvent,
} from '../packages/core/src/index.ts';
import { fetchJson as ioFetchJson, slackPost } from '../packages/io/src/index.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const RKSI = { lat: 37.4691, lon: 126.4505 };

export interface SmokeDeps {
  fetchJson: (url: string) => Promise<unknown>;
  fetchText: (url: string) => Promise<string>;
  postSlack: (webhookUrl: string, payload: Record<string, unknown>) => Promise<boolean>;
  env: (name: string) => string | undefined;
  now: () => Date;
  log: (msg: string) => void;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (now: Date, n: number): string => iso(new Date(now.getTime() - n * 86_400_000));

export async function smokeLiveApis(deps: SmokeDeps): Promise<{ results: SmokeResult[]; failures: number }> {
  const results: SmokeResult[] = [];
  const record = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      results.push({ name, ok: true, skipped: false, detail: await run() });
    } catch (e) {
      results.push({ name, ok: false, skipped: false, detail: String(e).slice(0, 300) });
    }
  };
  const skip = (name: string, detail: string): void => {
    results.push({ name, ok: true, skipped: true, detail });
  };

  // --- Gamma -----------------------------------------------------------------
  let liveEvent: ParsedEvent | null = null;
  await record('gamma_active_events', async () => {
    const page = (await deps.fetchJson(
      `${GAMMA}/events?tag_id=104596&active=true&closed=false&limit=10&offset=0`,
    )) as RawGammaEvent[];
    if (!Array.isArray(page) || page.length === 0) throw new Error('empty active-events page');
    const errors: string[] = [];
    for (const ev of page) {
      try {
        liveEvent = parseGammaEvent(ev);
        return `${page.length} events; parsed '${liveEvent.slug}' (${liveEvent.buckets.length} buckets)`;
      } catch (e) {
        errors.push(`${ev.slug}: ${String(e).slice(0, 80)}`);
      }
    }
    throw new Error(`no event on the page parses — ${errors[0]}`);
  });

  await record('gamma_closed_events', async () => {
    const page = (await deps.fetchJson(
      `${GAMMA}/events?tag_id=104596&closed=true&limit=5&offset=0`,
    )) as RawGammaEvent[];
    if (!Array.isArray(page) || page.length === 0) throw new Error('empty closed-events page');
    if (!page.every((ev) => ev.closed === true)) throw new Error('closed=true page returned a non-closed event');
    const prices = parseStringArray(page[0]!.markets[0]!.outcomePrices!, 'outcomePrices');
    return `${page.length} closed events; outcomePrices decodes (${prices.length} entries)`;
  });

  // --- CLOB ------------------------------------------------------------------
  const liveToken =
    liveEvent === null
      ? null
      : ((liveEvent as ParsedEvent).buckets.find((b) => b.bestAsk !== null) ?? (liveEvent as ParsedEvent).buckets[0])
          ?.tokenYes ?? null;
  if (liveToken === null) {
    skip('clob_book', 'no live token (gamma_active_events failed)');
    skip('clob_prices_history', 'no live token (gamma_active_events failed)');
  } else {
    await record('clob_book', async () => {
      const book = normalizeBook(
        (await deps.fetchJson(`${CLOB}/book?token_id=${liveToken}`)) as RawClobBook,
      );
      return `book normalized: ${book.bids.length} bids / ${book.asks.length} asks, tick ${book.tickSize}`;
    });
    await record('clob_prices_history', async () => {
      const pts = parsePricesHistory(
        await deps.fetchJson(`${CLOB}/prices-history?market=${liveToken}&interval=1d&fidelity=10`),
      );
      return `${pts.length} price points`;
    });
  }

  // --- Open-Meteo --------------------------------------------------------------
  const omKey = deps.env('OPENMETEO_API_KEY');
  const prefix = omKey ? 'customer-' : '';
  await record('openmeteo_forecast_multimodel', async () => {
    const url = forecastUrl(`https://${prefix}api.open-meteo.com`, RKSI, ['gfs_seamless', 'ecmwf_ifs025'], 3, omKey);
    const rows = parseMultiModelDaily(await deps.fetchJson(url), ['gfs_seamless', 'ecmwf_ifs025']);
    if (rows.length === 0) throw new Error('no daily rows parsed');
    return `${rows.length} (model × day) rows`;
  });
  await record('openmeteo_prevruns_single_model', async () => {
    const url = previousRunsUrl(
      `https://${prefix}previous-runs-api.open-meteo.com`, RKSI, ['gfs_seamless'], [1, 2],
      { start: daysAgo(deps.now(), 8), end: daysAgo(deps.now(), 1) }, omKey,
    );
    const rows = parsePreviousRunsHourly(await deps.fetchJson(url), ['gfs_seamless'], [1, 2], 'Asia/Seoul');
    if (rows.length === 0) throw new Error('no rows — the single-model bare-key quirk may have changed');
    return `${rows.length} (lead × day) rows via the single-model suffix quirk`;
  });
  await record('openmeteo_ensemble', async () => {
    const url = ensembleUrl(`https://${prefix}ensemble-api.open-meteo.com`, RKSI, 'ecmwf_ifs025', 3, omKey);
    const rows = parseEnsembleDaily(await deps.fetchJson(url));
    const members = new Set(rows.map((r) => r.member)).size;
    if (members < 20) throw new Error(`only ${members} ensemble members (need ≥20 for §6.5)`);
    return `${members} members × ${new Set(rows.map((r) => r.targetDate)).size} days`;
  });
  await record('openmeteo_era5_archive', async () => {
    const url = archiveUrl(`https://${prefix}archive-api.open-meteo.com`, RKSI,
      { start: daysAgo(deps.now(), 14), end: daysAgo(deps.now(), 7) }, omKey);
    const rows = parseEra5Daily(await deps.fetchJson(url));
    if (rows.length === 0) throw new Error('no archive rows');
    return `${rows.length} ERA5 daily rows`;
  });
  await record('openmeteo_model_meta', async () => {
    // §6.19 health-monitor MODEL_STUCK input. The data dirs use real-model
    // names (gfs_seamless → ncep_gfs013) — same mapping as health-monitor's
    // META_DIR (live-verified 2026-06-11; resolves the BUILD-STATE deviation).
    const meta = (await deps.fetchJson('https://api.open-meteo.com/data/ncep_gfs013/static/meta.json')) as {
      last_run_initialisation_time?: unknown;
    };
    if (typeof meta?.last_run_initialisation_time !== 'number') {
      throw new Error(`last_run_initialisation_time is ${typeof meta?.last_run_initialisation_time}, expected number`);
    }
    const ageH = (deps.now().getTime() / 1000 - meta.last_run_initialisation_time) / 3600;
    return `ncep_gfs013 (gfs_seamless) last run ${ageH.toFixed(1)}h ago`;
  });

  // --- Weather Underground -------------------------------------------------------
  await record('wu_key_extraction_and_obs', async () => {
    const html = await deps.fetchText('https://www.wunderground.com/history/daily/kr/incheon/RKSI');
    const key = extractWuApiKey(html);
    if (!key) throw new Error('no 32-hex apiKey in the page source — extraction regex drifted');
    const day = daysAgo(deps.now(), 2).replaceAll('-', '');
    const obs = parseWuObservations(await deps.fetchJson(wuObsUrl('KORD', 'US', 'e', day, key)));
    const max = wuDailyMax(obs);
    if (max === null) throw new Error('no usable hourly obs for KORD two days ago');
    return `key extracted; KORD ${day}: max ${max.maxInt}°F over ${max.nObs} obs`;
  });

  // --- aviationweather METAR --------------------------------------------------------
  await record('aviationweather_metar', async () => {
    const obs = parseMetarJson(
      await deps.fetchJson('https://aviationweather.gov/api/data/metar?ids=RKSI&format=json&hours=72'),
    );
    if (obs.length === 0) throw new Error('no METAR observations for RKSI in 72h');
    return `${obs.length} METAR obs`;
  });

  // --- IEM ---------------------------------------------------------------------------
  await record('iem_daily', async () => {
    const row = parseIemDaily(await deps.fetchJson(iemDailyUrl('ORD', 'IL_ASOS', daysAgo(deps.now(), 2))));
    if (row === null) throw new Error('no IEM daily row for ORD two days ago');
    return `ORD max ${row.maxTmpF}°F`;
  });

  // --- Slack -----------------------------------------------------------------------
  const webhook = deps.env('SLACK_WEBHOOK_URL');
  if (!webhook) {
    skip('slack_webhook', 'SLACK_WEBHOOK_URL unset — Operator TODO 4; notifier path is suite-tested');
  } else {
    await record('slack_webhook', async () => {
      const delivered = await deps.postSlack(webhook, {
        text: `weather-edge smoke-live-apis OK probe (${deps.now().toISOString()})`,
      });
      if (!delivered) throw new Error('webhook POST not acknowledged with 2xx');
      return 'test message delivered';
    });
  }

  const failures = results.filter((r) => !r.ok).length;
  for (const r of results) {
    deps.log(`${r.ok ? (r.skipped ? '−' : '✓') : '✗'} ${r.name.padEnd(34)} ${r.detail}`);
  }
  deps.log(
    failures === 0
      ? `smoke-live-apis: ${results.filter((r) => r.ok && !r.skipped).length} live integrations OK` +
          `${results.some((r) => r.skipped) ? `, ${results.filter((r) => r.skipped).length} skipped` : ''}`
      : `smoke-live-apis: ${failures} INTEGRATION(S) DRIFTED — ${results.filter((r) => !r.ok).map((r) => r.name).join(', ')}`,
  );
  return { results, failures };
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Cloudflare fronts the Polymarket hosts and rejects bare library user agents.
  const headers = { 'User-Agent': 'weather-edge/0.1 (smoke test)', Accept: 'application/json' };
  const { failures } = await smokeLiveApis({
    fetchJson: (url) => ioFetchJson(url, { headers }),
    fetchText: async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'] } });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return res.text();
    },
    postSlack: slackPost,
    env: (name) => process.env[name],
    now: () => new Date(),
    log: console.log,
  });
  process.exit(failures > 0 ? 1 : 0);
}
