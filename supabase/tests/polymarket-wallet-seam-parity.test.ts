/**
 * Cross-twin SEAM PARITY guard (WALLET-RECON-HANDOFF.md §6 Deno/Node seam). The io header asserts the PURE
 * PARSERS + CONSTANTS in packages/io/src/polymarket-wallet.ts are a "VERBATIM behavioural copy" of the Deno
 * _shared twin and "must stay behaviourally identical". Until now NOTHING mechanically pinned that — each
 * suite imported only its own module, and a real divergence (the Deno positions fetcher had no ≤500 limit
 * clamp while the Node twin did) shipped green. This is the missing anti-drift guard, modelled on the
 * check-live-readiness §15 mirror test: it imports BOTH twins and asserts identical behaviour on the surface
 * the header claims is verbatim — the four parsers + the shared fetch-wrapper URLs across the >500 boundary.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as deno from '../functions/_shared/polymarket-wallet.ts';
import * as node from '../../packages/io/src/polymarket-wallet.ts';

const RESEARCH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'research');
const loadFixture = (file: string): unknown => JSON.parse(readFileSync(join(RESEARCH, file), 'utf8'));

/** Capture the URL each twin builds (the fetchJson is injected, so we never hit the network). */
function urlCapture(): { url: string; fetchJson: deno.FetchJsonLike } {
  const box = { url: '' };
  const fetchJson: deno.FetchJsonLike = (url: string) => {
    box.url = url;
    return Promise.resolve([]);
  };
  return { get url() { return box.url; }, fetchJson } as { url: string; fetchJson: deno.FetchJsonLike };
}

describe('seam parity — shared parsers produce byte-identical output across the twins', () => {
  it('parsePositionMarket agrees on valid, archived (arch-), and junk slugs', () => {
    const slugs = [
      'highest-temperature-in-amsterdam-on-june-22-2026',
      'lowest-temperature-in-kuala-lumpur-on-december-6-2025',
      'arch-highest-temperature-in-toronto-on-may-17-2026', // archived prefix — both twins tolerate it
      'will-trump-win-2024',
      'highest-temperature-in-amsterdam-on-june-22', // yearless
      '',
    ];
    for (const s of slugs) {
      expect(node.parsePositionMarket(s)).toEqual(deno.parsePositionMarket(s));
    }
    // arch- recovery actually parses (not just "both null") — the whole point of finding [5].
    expect(node.parsePositionMarket('arch-highest-temperature-in-toronto-on-may-17-2026')).toEqual({
      kind: 'highest',
      citySlug: 'toronto',
      targetDate: '2026-05-17',
    });
  });

  it('parsePositions / parseLeaderboard / parseUserPnl agree on the live fixtures', () => {
    const positions = loadFixture('dataapi-positions-badatmath-sample.json');
    const leaderboard = loadFixture('dataapi-weather-leaderboard-sample.json');
    const userpnl = loadFixture('userpnl-badatmath.json');
    expect(node.parsePositions(positions)).toEqual(deno.parsePositions(positions));
    expect(node.parseLeaderboard(leaderboard)).toEqual(deno.parseLeaderboard(leaderboard));
    expect(node.parseUserPnl(userpnl)).toEqual(deno.parseUserPnl(userpnl));
  });

  it('parsers agree on junk / empty / non-array payloads (total, never throws)', () => {
    for (const junk of [null, undefined, {}, 42, 'x', [null, {}, { conditionId: '' }]]) {
      expect(node.parsePositions(junk)).toEqual(deno.parsePositions(junk));
      expect(node.parseLeaderboard(junk)).toEqual(deno.parseLeaderboard(junk));
      expect(node.parseUserPnl(junk)).toEqual(deno.parseUserPnl(junk));
    }
  });

  it('shared constants are identical', () => {
    expect(node.POLYMARKET_DATA_API).toBe(deno.POLYMARKET_DATA_API);
    expect(node.POLYMARKET_USER_PNL_API).toBe(deno.POLYMARKET_USER_PNL_API);
    expect(node.SHARP_WALLET_ADDRESS).toBe(deno.SHARP_WALLET_ADDRESS);
    expect(node.SHARP_WALLET_LABEL).toBe(deno.SHARP_WALLET_LABEL);
  });
});

describe('seam parity — fetch-wrapper URLs match across the >500 limit boundary (the drift that shipped)', () => {
  it('fetchWalletPositions clamps limit to ≤500 on BOTH twins when asked for 1000', async () => {
    const n = urlCapture();
    const d = urlCapture();
    await node.fetchWalletPositions(n.fetchJson, deno.SHARP_WALLET_ADDRESS, { limit: 1000 });
    await deno.fetchWalletPositions(d.fetchJson, deno.SHARP_WALLET_ADDRESS, { limit: 1000 });
    expect(n.url).toContain('&limit=500');
    expect(d.url).toContain('&limit=500');
    expect(n.url).not.toContain('limit=1000');
    expect(d.url).not.toContain('limit=1000');
    expect(n.url).toBe(d.url); // full URL identity on the shared fetcher
  });

  it('fetchWalletPositions builds an identical default URL on both twins', async () => {
    const n = urlCapture();
    const d = urlCapture();
    await node.fetchWalletPositions(n.fetchJson, deno.SHARP_WALLET_ADDRESS);
    await deno.fetchWalletPositions(d.fetchJson, deno.SHARP_WALLET_ADDRESS);
    expect(n.url).toBe(d.url);
  });

  it('fetchUserPnl builds an identical URL on both twins', async () => {
    const n = urlCapture();
    const d = urlCapture();
    await node.fetchUserPnl(n.fetchJson, deno.SHARP_WALLET_ADDRESS);
    await deno.fetchUserPnl(d.fetchJson, deno.SHARP_WALLET_ADDRESS);
    expect(n.url).toBe(d.url);
  });

  it('fetchWeatherLeaderboard builds an identical URL on both twins', async () => {
    const n = urlCapture();
    const d = urlCapture();
    await node.fetchWeatherLeaderboard(n.fetchJson, { limit: 25 });
    await deno.fetchWeatherLeaderboard(d.fetchJson, { limit: 25 });
    expect(n.url).toBe(d.url);
  });

  it('address is URL-encoded in the positions URL (finding [14]/[20])', async () => {
    const n = urlCapture();
    // a contrived address with a reserved char must be percent-encoded, never interpolated raw
    await node.fetchWalletPositions(n.fetchJson, 'abc&evil=1');
    expect(n.url).toContain('user=abc%26evil%3D1');
    expect(n.url).not.toContain('user=abc&evil=1');
  });
});
