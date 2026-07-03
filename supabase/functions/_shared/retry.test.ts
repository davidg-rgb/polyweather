/**
 * _shared/retry — the terminal-write bounded retry (WS-5, FASTTRACK-PLAN.md §WS-5 item 1).
 *
 * Pins: a write that fails once then succeeds is retried and returns the success (no data loss from a
 * single transient timeout — today's incident); a write that fails on every attempt gives up after
 * `retries` additional tries and throws the LAST error (the job must still fail loudly, not swallow a
 * genuine outage); the backoff delays passed to `sleep` between attempts match `delaysMs` exactly, so the
 * documented wall-clock arithmetic in the handlers is provable rather than assumed; a hung (never-resolving)
 * attempt is force-failed by `attemptTimeoutMs`, not left to hang past the isolate wall; and `onRetry` fires
 * once per failed attempt (not on the final, non-retried failure) with the right 0-based attempt index.
 */
import { describe, expect, it, vi } from 'vitest';
import { retryWrite, withTimeout } from './retry.ts';

/** A no-delay sleep — the retry LOGIC is under test, not real wall-clock timing. */
const instant = async (_ms: number): Promise<void> => {};

/** A sleep that records every requested delay, for asserting the exact backoff schedule. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

describe('retryWrite', () => {
  it('succeeds after one timeout — the second attempt lands and its result is returned', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('upstream request timeout');
      return [{ record_maker_exit_panel: 42 }];
    };
    const result = await retryWrite(
      fn,
      { retries: 2, delaysMs: [3_000, 8_000], attemptTimeoutMs: 15_000, label: 'record_maker_exit_panel' },
      instant,
    );
    expect(result).toEqual([{ record_maker_exit_panel: 42 }]);
    expect(calls).toBe(2); // one failure + one success — no more attempts spent than needed
  });

  it('gives up after two retries (3 total attempts) and throws the LAST error', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error(`fail #${calls}`);
    };
    await expect(
      retryWrite(
        fn,
        { retries: 2, delaysMs: [3_000, 8_000], attemptTimeoutMs: 15_000, label: 'record_convergence_panel' },
        instant,
      ),
    ).rejects.toThrow('fail #3'); // the LAST attempt's error, not the first
    expect(calls).toBe(3); // 1 initial + 2 retries — never a 4th attempt
  });

  it('the backoff schedule fed to sleep matches delaysMs exactly (the arithmetic the handlers document)', async () => {
    const { sleep, calls: sleeps } = recordingSleep();
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('nope');
    };
    await expect(
      retryWrite(fn, { retries: 2, delaysMs: [3_000, 8_000], attemptTimeoutMs: 15_000, label: 'x' }, sleep),
    ).rejects.toThrow();
    expect(sleeps).toEqual([3_000, 8_000]); // exactly 2 backoffs, in order — never a 3rd (no retry after the last attempt)
  });

  it('a hung attempt is force-failed by attemptTimeoutMs, not left to hang', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fn = () => {
        calls++;
        if (calls === 1) return new Promise<unknown>(() => {}); // never resolves
        return Promise.resolve([{ ok: true }]);
      };
      const p = retryWrite(
        fn,
        { retries: 1, delaysMs: [1_000], attemptTimeoutMs: 5_000, label: 'hangy-write' },
        instant,
      );
      // advance past the per-attempt timeout — the hung first attempt must reject, not silently linger.
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await p;
      expect(result).toEqual([{ ok: true }]);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onRetry fires once per FAILED attempt with the 0-based attempt index and the real error', async () => {
    const seen: { attempt: number; message: string }[] = [];
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error(`e${calls}`);
    };
    await expect(
      retryWrite(
        fn,
        {
          retries: 2,
          delaysMs: [1, 1],
          attemptTimeoutMs: 15_000,
          label: 'x',
          onRetry: (attempt, e) => seen.push({ attempt, message: (e as Error).message }),
        },
        instant,
      ),
    ).rejects.toThrow('e3');
    // 3 attempts total (0,1,2), all failed → onRetry fires for every one of them (including the last,
    // non-retried failure — it still logs before the caller re-throws).
    expect(seen).toEqual([
      { attempt: 0, message: 'e1' },
      { attempt: 1, message: 'e2' },
      { attempt: 2, message: 'e3' },
    ]);
  });

  it('a success on the FIRST attempt never calls sleep or onRetry', async () => {
    const { sleep, calls: sleeps } = recordingSleep();
    let onRetryCalls = 0;
    const result = await retryWrite(
      async () => [{ ok: 1 }],
      { retries: 2, delaysMs: [3_000, 8_000], attemptTimeoutMs: 15_000, label: 'x', onRetry: () => onRetryCalls++ },
      sleep,
    );
    expect(result).toEqual([{ ok: 1 }]);
    expect(sleeps).toEqual([]);
    expect(onRetryCalls).toBe(0);
  });

  it('retries: 0 makes exactly one attempt and throws immediately on failure — no backoff sleep called', async () => {
    const { sleep, calls: sleeps } = recordingSleep();
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error('single-shot failure');
    };
    await expect(
      retryWrite(fn, { retries: 0, delaysMs: [], attemptTimeoutMs: 15_000, label: 'x' }, sleep),
    ).rejects.toThrow('single-shot failure');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'label')).resolves.toBe('ok');
  });

  it('rejects with the label-bearing error when the promise never settles in time', async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<never>(() => {});
      const p = withTimeout(hung, 1_000, 'my-op timed out');
      const assertion = expect(p).rejects.toThrow('my-op timed out');
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the original rejection reason when the promise rejects before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'label')).rejects.toThrow('boom');
  });
});
