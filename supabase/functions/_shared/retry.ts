/**
 * functions/_shared/retry — bounded retry + the shared fetch-timeout race for the panel Edge ticks
 * (WS-5, FASTTRACK-PLAN.md §WS-5 item 1).
 *
 * withTimeout: races a promise against a rejection timer (neither DbPort.rpc nor the underlying supabase-js
 * fetch has a built-in timeout — a hung statement or a stalled pooler connection would otherwise stall the
 * whole isolate toward the ~400s wall). Ported here from the maker-exit-panel/convergence-panel per-city
 * fetch pool (WS-1, 2026-07-03) so it has exactly one implementation instead of two copies.
 *
 * retryWrite: wraps a single terminal write (the panel snapshot RPC) in a BOUNDED retry with backoff.
 * 2026-07-03's incident lost an entire ~6-minute tick (all 45 cities already fetched) to ONE transient
 * "upstream request timeout" on the final `record_maker_exit_panel` insert — no retry meant that tick's
 * work was discarded outright and had to be refetched from scratch on the next cron slot (repeated 3
 * times that day). A per-attempt timeout + 2 retries with short backoff give one flaky write two more
 * chances to land, with an added worst-case delay that is bounded and provable (see each handler's call
 * site for the full tick-budget arithmetic), never open-ended.
 *
 * IDEMPOTENCY — why retrying an INSERT is safe here (verified before wiring this in, not assumed):
 * record_maker_exit_panel / record_convergence_panel (migrations 0073/0069) are a pure
 * `insert into <panel> (captured_at, view) values (now(), p_view) returning id` + a prune-to-latest-200-rows
 * tail — no upsert, no uniqueness constraint on the table, so nothing rejects a second insert. A retry
 * after a write that TIMED OUT CLIENT-SIDE but actually landed server-side produces a harmless duplicate
 * snapshot row (identical view payload, a later captured_at). Every reader — dash_maker_exit / dash_convergence
 * (both `order by captured_at desc limit 1`) — takes only the newest row, and those two RPCs are the ONLY
 * consumers of maker_exit_panel/convergence_panel (verified: apps/web's /maker-exit and /convergence pages,
 * and every script in this repo, read exclusively through the dash_* RPCs — grep confirms no other reader).
 * A duplicate is therefore invisible to every consumer; its only cost is one extra row that the existing
 * prune-to-200 step reclaims within the next couple of ticks.
 *
 * Do NOT point this helper at the best-effort bookkeeping writes (record_bot_gate_snapshot / record_bot_tick).
 * Unlike the two panel tables, bot_gate_snapshot is INTENTIONALLY never pruned (the operator reads the
 * evolving §9R-E history over time) — a retried duplicate there would pollute that history with a phantom
 * extra data point instead of vanishing harmlessly. Those two stay in their existing non-fatal try/catch,
 * unretried; a snapshot has already landed by the time they run, so their failure is not fatal to the tick.
 */

export interface RetryWriteOpts {
  /** retries AFTER the first attempt (2 → up to 3 total attempts). */
  retries: number;
  /** backoff before each retry, ms; index 0 = delay before retry #1, index 1 = delay before retry #2, … */
  delaysMs: number[];
  /** hard per-attempt timeout, ms — bounds a hung write so the worst-case arithmetic is provable, not assumed. */
  attemptTimeoutMs: number;
  /** identifies the write in the timeout error message and the onRetry log line. */
  label: string;
  onRetry?: (attempt: number, error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Race a promise against a rejection timer; always clears the timer on either outcome. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killer = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([p, killer]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Run fn() with a hard per-attempt timeout; on failure (rejection OR timeout), wait the matching backoff
 * delay and retry, up to opts.retries additional times. Throws the LAST error if every attempt fails —
 * callers get the same "the job failed" behavior as an unretried call, just after more chances to land.
 */
export async function retryWrite<T>(
  fn: () => Promise<T>,
  opts: RetryWriteOpts,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await withTimeout(
        fn(),
        opts.attemptTimeoutMs,
        `${opts.label} timed out after ${opts.attemptTimeoutMs}ms`,
      );
    } catch (e) {
      lastErr = e;
      opts.onRetry?.(attempt, e);
      if (attempt < opts.retries) {
        await sleep(opts.delaysMs[attempt] ?? 0);
      }
    }
  }
  throw lastErr;
}
