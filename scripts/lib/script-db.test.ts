/**
 * script-db retry policy: transient connection drops (ECONNRESET et al.) retry
 * with backoff and eventually succeed; server-side query rejections do NOT retry;
 * a persistently-down connection exhausts retries and surfaces the last error.
 */
import { describe, expect, it, vi } from 'vitest';
import { isTransientDbError, runWithDbRetry } from './script-db.ts';

const noSleep = async () => {};

describe('isTransientDbError', () => {
  it('classifies Node socket errno codes as transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']) {
      expect(isTransientDbError(Object.assign(new Error('boom'), { code }))).toBe(true);
    }
  });

  it('classifies postgres-js connection-lifecycle codes as transient', () => {
    for (const code of ['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED']) {
      expect(isTransientDbError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('classifies Postgres class-08 / admin-shutdown SQLSTATEs as transient', () => {
    for (const code of ['08006', '08003', '57P01', '57P03', '53300']) {
      expect(isTransientDbError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('matches a raw ECONNRESET even when the code is absent (message only)', () => {
    expect(isTransientDbError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('does NOT classify app-level SQLSTATEs (unique_violation, etc.) as transient', () => {
    expect(isTransientDbError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    expect(isTransientDbError(Object.assign(new Error('bad'), { code: '42601' }))).toBe(false);
    expect(isTransientDbError(new Error('syntax error at or near'))).toBe(false);
  });
});

describe('runWithDbRetry', () => {
  it('retries a transient drop and returns the eventual success', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      return 'ok';
    });
    const out = await runWithDbRetry(exec, { sleep: noSleep });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient error — throws on the first attempt', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls++;
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    await expect(runWithDbRetry(exec, { sleep: noSleep })).rejects.toThrow('duplicate key');
    expect(calls).toBe(1);
  });

  it('exhausts retries on a persistently-down connection and surfaces the last error', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls++;
      throw Object.assign(new Error('connection closed'), { code: 'CONNECTION_CLOSED' });
    });
    await expect(runWithDbRetry(exec, { retries: 2, sleep: noSleep })).rejects.toThrow('connection closed');
    expect(calls).toBe(3); // first attempt + 2 retries
  });
});
