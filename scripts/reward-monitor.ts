/**
 * scripts/reward-monitor — REC-4: the liquidity-rewards monitor (MAKER-REBATE-HANDOFF.md §4 / REC-4).
 *
 * Polymarket's FUNDED liquidity-reward pool is the CLOB `/sampling-markets` list (markets with active
 * rewards, paid daily regardless of fill). Weather is NOT in that pool today; if it ever is,
 * "rest-near-mid, paid regardless of fill" becomes a real, FORECAST-FREE income path (no selection skill
 * — the only forecast-axis-independent money path this whole investigation has surfaced). This script
 * paginates the live endpoint, runs the pure `scanWeatherRewards` detector, and reports whether any
 * weather/temperature market has entered the funded pool. Read-only, public, keyless.
 *
 * This is the runnable MVP that answers the question NOW. The continuous version (an Edge Function on a
 * daily pg_cron that Slack-alerts when `fundedWeather.length > 0`) is a small, deploy-gated follow-up —
 * see RUNBOOK. Exit code 0 = no weather in the pool (the expected, dormant state); 2 = weather FOUND
 * (the trigger fired — act on it).
 *
 * Run: pnpm tsx scripts/reward-monitor.ts [--max-pages 50] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { scanWeatherRewards, type RawSamplingMarket } from '../packages/core/src/polymarket/rewards.ts';
import { fetchJson } from '../packages/io/src/http.ts';

export const SCRIPT = 'reward-monitor';

const CLOB_BASE = 'https://clob.polymarket.com';

interface SamplingPage {
  data?: RawSamplingMarket[];
  next_cursor?: string;
  count?: number;
}

/** The CLOB end-of-pagination sentinel cursor (base64 of a terminal marker). */
const END_CURSOR = 'LTE=';

/**
 * Page through `/sampling-markets` (cursor-based) collecting every funded reward-eligible market.
 * Stops at the end sentinel, an empty page, a repeated cursor, or `maxPages`. Degrades cleanly — a
 * fetch failure ends pagination with what we have (and is surfaced in the report).
 */
export async function fetchSamplingMarkets(
  maxPages: number,
  log: (m: string) => void,
  fetcher: (url: string) => Promise<unknown> = (u) => fetchJson(u, undefined, { timeoutMs: 25_000 }),
): Promise<{ markets: RawSamplingMarket[]; pages: number; complete: boolean }> {
  const markets: RawSamplingMarket[] = [];
  let cursor = '';
  const seen = new Set<string>();
  let pages = 0;
  let complete = false;
  for (; pages < maxPages; ) {
    const url = `${CLOB_BASE}/sampling-markets${cursor ? `?next_cursor=${encodeURIComponent(cursor)}` : ''}`;
    let page: SamplingPage;
    try {
      page = (await fetcher(url)) as SamplingPage;
    } catch (e) {
      log(`  page ${pages + 1} fetch failed (${(e as Error)?.message ?? e}) — stopping with ${markets.length} markets`);
      break;
    }
    pages++;
    const data = Array.isArray(page.data) ? page.data : [];
    markets.push(...data);
    const next = page.next_cursor ?? '';
    if (data.length === 0 || next === '' || next === END_CURSOR || seen.has(next)) {
      complete = true;
      break;
    }
    seen.add(next);
    cursor = next;
  }
  return { markets, pages, complete };
}

export function report(
  scan: ReturnType<typeof scanWeatherRewards>,
  meta: { pages: number; complete: boolean },
  log: (m: string) => void,
): void {
  log(`=== REC-4 liquidity-rewards monitor — CLOB /sampling-markets (funded reward pool) ===`);
  log(`scanned ${scan.nScanned} funded reward-eligible markets across ${meta.pages} page(s)${meta.complete ? '' : ' (INCOMPLETE — pagination cut short)'}`);
  log('');
  if (scan.fundedWeather.length > 0) {
    log(`🔔 TRIGGER: ${scan.fundedWeather.length} WEATHER market(s) are in the FUNDED reward pool:`);
    for (const h of scan.fundedWeather) {
      log(`  • ${h.slug || h.question}  (${h.dailyRateTotal}/day, condition ${h.conditionId.slice(0, 12)}…)`);
    }
    log('');
    log('  → Weather has entered the funded liquidity-reward pool. This is a FORECAST-FREE income path');
    log('    (rest near mid, paid regardless of fill). Re-evaluate the maker rail with this new info.');
  } else if (scan.weather.length > 0) {
    log(`${scan.weather.length} weather market(s) are reward-eligible (sampling-listed) but UNFUNDED (rates null) — scaffolded, not paying.`);
    log('  → Not a trigger yet. Keep monitoring.');
  } else {
    log('No weather/temperature markets in the funded reward pool (the expected, dormant state — §2).');
    log('  → Forecast-free reward farming on weather is NOT available today. Keep monitoring.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { 'max-pages': { type: 'string' }, json: { type: 'boolean' } },
  });
  const maxPages = values['max-pages'] ? Number(values['max-pages']) : 50;
  const { markets, pages, complete } = await fetchSamplingMarkets(maxPages, console.log);
  const scan = scanWeatherRewards(markets);
  report(scan, { pages, complete }, console.log);
  if (values.json) {
    console.log('\nJSON ' + JSON.stringify({ ...scan, pages, complete }));
  }
  // exit 2 when the trigger fires so a cron/CI wrapper can alert; 0 = dormant (expected)
  process.exit(scan.fundedWeather.length > 0 ? 2 : 0);
}
