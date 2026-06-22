/**
 * scripts/lib/polymarket-crawl — the time-windowed FULL /activity crawler that defeats the data-api
 * offset cap. Shared by scripts/wallet-forensics.ts (lifetime reconstruction) and
 * scripts/research/copytrade-feasibility.ts (fill-mirror study) so the crawl logic lives once.
 *
 * THE OFFSET CAP. The data-api `/activity` offset is hard-capped (~4,000 rows; offset 4000 returns
 * HTTP 400 — verified live 2026-06-22), so a wallet with >4k events cannot be paged by offset alone.
 * To recover the FULL history (the prime directive: no silent caps), we page DESC (newest-first) by
 * offset WITHIN a time window, then SLIDE the window: when a window stops (short page or the offset
 * cap / a 400), set the next window's `end` to one second before the OLDEST timestamp seen and reset
 * offset to 0. Each window only ever pages within the safe offset band. Repeats until a window returns
 * nothing (the wallet's first fill) or --max-pages total pages is hit.
 *
 * If `from` is set, the crawl stops once it pages past that start (REGIME-window mode). Logs exactly
 * which window was used + whether it stopped at the page cap. Pure-ish: side effects are network +
 * stderr progress only; deterministic given the upstream responses.
 */
import { fetchJson } from '../../packages/io/src/index.ts';
import { fetchActivity, type WalletActivity } from '../../packages/io/src/polymarket-wallet.ts';

export interface PagingResult {
  fills: WalletActivity[];
  /** 'full' = recovered to the first fill; 'capped' = stopped at --max-pages; 'window' = restricted to --from. */
  mode: 'full' | 'capped' | 'window';
  pagesFetched: number;
  /** The earliest fill day actually fetched (the reconciliation window start). */
  windowFrom: string | null;
  hitCap: boolean;
}

/**
 * Crawl a wallet's full /activity history despite the offset cap, via the slide-the-window strategy
 * described above. Returns the de-duped fills ASCENDING by timestamp (ready for FIFO replay), the
 * crawl `mode`, the page count, the earliest fetched day, and whether the page cap was hit.
 */
export async function crawlActivity(
  wallet: string,
  opts: { maxPages: number; from?: string },
): Promise<PagingResult> {
  const limit = 500;
  // Stay safely below the verified ~4,000 offset cap: at most 7 pages (offset 3,500) per time window.
  const pagesPerWindow = 7;
  const startBound = opts.from ? Math.floor(Date.parse(`${opts.from}T00:00:00Z`) / 1000) : undefined;

  const all: WalletActivity[] = [];
  const seen = new Set<string>(); // de-dupe across overlapping window boundaries
  let totalPages = 0;
  let hitCap = false;
  let windowEnd: number | undefined = undefined; // newest-first; undefined = "now"
  let oldestTs = Infinity;
  let windowRetries = 0; // transient-error retries on the CURRENT window (reset on progress)
  const MAX_WINDOW_RETRIES = 5;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Stable per-fill identity (the same fill can appear at a window boundary): type+side+condition+ts+size.
  const fid = (f: WalletActivity): string =>
    `${f.type}|${f.side ?? ''}|${f.conditionId}|${f.asset}|${f.timestamp}|${f.sizeShares}|${f.usdcSize}`;

  for (;;) {
    if (totalPages >= opts.maxPages) {
      hitCap = true;
      break;
    }
    const pagesThisWindow = Math.min(pagesPerWindow, opts.maxPages - totalPages);
    let windowRows: WalletActivity[] = [];
    let windowErrored = false;
    try {
      windowRows = await fetchActivity(fetchJson, wallet, {
        type: 'ALL',
        sortDirection: 'DESC', // newest-first; windowed by `end`, paged by offset within the safe band
        limit,
        maxPages: pagesThisWindow,
        start: startBound,
        end: windowEnd,
        timeoutMs: 60_000,
        retries: 2,
        onProgress: (pageRows, _total) => {
          totalPages++;
          process.stderr.write(
            `  …window end=${windowEnd ? new Date(windowEnd * 1000).toISOString().slice(0, 10) : 'now'} ` +
              `page +${pageRows.length} (total fills ${all.length + windowRows.length + pageRows.length}; ` +
              `pages ${totalPages}/${opts.maxPages})\r`,
          );
        },
      });
    } catch (err) {
      // A 4xx mid-window is EITHER the offset cap (HTTP 400 at offset ~4000) OR transient Cloudflare
      // pressure (HTTP 408/429 under heavy crawling). fetchActivity threw, so this window yielded nothing
      // this attempt. We retry the SAME window (below) before giving up, so a transient blip does not
      // masquerade as "reached the first fill" and silently truncate the crawl (the §10 truncation class).
      const msg = err instanceof Error ? err.message : String(err);
      if (!/HTTP 4\d\d/.test(msg)) throw err;
      windowErrored = true;
      process.stderr.write(`\n  (window error: ${msg})\n`);
    }

    let added = 0;
    let windowOldest = Infinity;
    for (const f of windowRows) {
      windowOldest = Math.min(windowOldest, f.timestamp);
      const id = fid(f);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(f);
      added++;
    }

    if (added > 0 && Number.isFinite(windowOldest)) {
      // Progress: slide to just before the oldest fill we've seen, and clear the retry counter.
      windowRetries = 0;
      oldestTs = Math.min(oldestTs, windowOldest);
      windowEnd = oldestTs - 1;
      if (startBound !== undefined && windowEnd <= startBound) break; // paged past the --from bound
      continue;
    }

    // No NEW rows this window. If it ERRORED (transient 4xx), retry the SAME window with backoff before
    // concluding we are done — otherwise an empty 200 means we have reached the wallet's first fill.
    if (windowErrored && windowRetries < MAX_WINDOW_RETRIES) {
      windowRetries++;
      await sleep(1000 * 2 ** windowRetries); // 2s, 4s, 8s, 16s, 32s
      continue; // re-page the SAME windowEnd
    }
    break; // genuine empty (first fill / past --from) OR transient retries exhausted
  }
  process.stderr.write('\n');

  all.sort((a, b) => a.timestamp - b.timestamp); // ascending for FIFO replay
  const windowFrom = all.length > 0 ? new Date(all[0]!.timestamp * 1000).toISOString().slice(0, 10) : null;
  const mode: PagingResult['mode'] = opts.from ? 'window' : hitCap ? 'capped' : 'full';
  return { fills: all, mode, pagesFetched: totalPages, windowFrom, hitCap };
}
