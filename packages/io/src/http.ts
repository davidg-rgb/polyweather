/**
 * packages/io/http — fetchJson (ARCHITECTURE.md §6.12).
 *
 * The single HTTP path shared by ALL runtimes (Edge Functions, trading,
 * scripts): timeout, retry on 429/5xx/network with exponential backoff +
 * jitter, JSON parse. Deno+Node portable — global fetch only.
 */
import { UpstreamError } from '@weather-edge/core';

export interface FetchJsonOpts {
  /** Retries AFTER the first attempt (default 2). */
  retries?: number;
  /** Base backoff in ms; attempt n waits base × 2^(n−1) × jitter (default 500). */
  backoffMs?: number;
  /** Per-attempt timeout (default 20s). */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(
  url: string,
  init?: RequestInit,
  opts?: FetchJsonOpts,
): Promise<unknown> {
  const retries = opts?.retries ?? 2;
  const backoffMs = opts?.backoffMs ?? 500;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const source = new URL(url).hostname;

  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.25));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new UpstreamError(`non-JSON response from ${source}`, {
            source,
            status: res.status,
            retryable: false,
          });
        }
      }
      lastStatus = res.status;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        throw new UpstreamError(`HTTP ${res.status} from ${source}`, {
          source,
          status: res.status,
          retryable: false,
        });
      }
      // retryable status — fall through to the next attempt
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      // network error / timeout abort — retryable, fall through
      lastStatus = 0;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new UpstreamError(`retries exhausted (${retries + 1} attempts) for ${source}`, {
    source,
    status: lastStatus,
    retryable: true,
  });
}
