import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '@weather-edge/core';
import { fetchJson } from '../src/http.ts';

const URL_OK = 'https://gamma-api.polymarket.com/events';
const FAST = { retries: 2, backoffMs: 1, timeoutMs: 100 };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchJson (§6.12)', () => {
  it('returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' })));
    await expect(fetchJson(URL_OK, undefined, FAST)).resolves.toEqual({ hello: 'world' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries 429 with backoff and succeeds', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', mock);
    await expect(fetchJson(URL_OK, undefined, FAST)).resolves.toEqual({ ok: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('retries 5xx and throws UpstreamError with source+status after exhaustion', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', mock);
    try {
      await fetchJson(URL_OK, undefined, FAST);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      const ue = e as UpstreamError;
      expect(ue.source).toBe('gamma-api.polymarket.com');
      expect(ue.status).toBe(503);
      expect(ue.retryable).toBe(true);
    }
    expect(mock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('does NOT retry non-retryable 4xx', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', mock);
    try {
      await fetchJson(URL_OK, undefined, FAST);
      expect.unreachable();
    } catch (e) {
      expect((e as UpstreamError).status).toBe(404);
      expect((e as UpstreamError).retryable).toBe(false);
    }
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('retries network errors', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse([1, 2, 3]));
    vi.stubGlobal('fetch', mock);
    await expect(fetchJson(URL_OK, undefined, FAST)).resolves.toEqual([1, 2, 3]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('a 200 with a non-JSON body is a non-retryable shape failure', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('<html>portal</html>', { status: 200 }));
    vi.stubGlobal('fetch', mock);
    try {
      await fetchJson(URL_OK, undefined, FAST);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      expect((e as UpstreamError).retryable).toBe(false);
      expect((e as UpstreamError).message).toContain('non-JSON');
    }
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('enforces the per-attempt timeout via AbortController', async () => {
    const mock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', mock);
    const start = Date.now();
    await expect(fetchJson(URL_OK, undefined, { retries: 1, backoffMs: 1, timeoutMs: 25 })).rejects.toThrow(
      UpstreamError,
    );
    expect(mock).toHaveBeenCalledTimes(2);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('passes through init (method, headers, body)', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', mock);
    await fetchJson(URL_OK, { method: 'POST', body: '{"x":1}' }, FAST);
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"x":1}');
  });
});
