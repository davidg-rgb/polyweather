/**
 * Tests for the credential smoke's pure gate — the --live-smoke interlock (default OFF, refused unless the
 * live gate is open or the explicit escape is given) + the arg parse. No network; importing the module never
 * runs main() (the direct-invoke guard is false under vitest).
 */
import { describe, expect, it } from 'vitest';
import { parseSmokeArgs, smokeLiveGate } from './trade-smoke.ts';

describe('parseSmokeArgs', () => {
  it('defaults --live-smoke and the escape OFF', () => {
    expect(parseSmokeArgs([])).toEqual({ liveSmoke: false, escape: false, token: null });
  });
  it('parses the flags + --token', () => {
    expect(parseSmokeArgs(['--live-smoke', '--i-know-no-preflight', '--token', '0xabc'])).toEqual({
      liveSmoke: true,
      escape: true,
      token: '0xabc',
    });
  });
});

describe('smokeLiveGate — the --live-smoke interlock', () => {
  it('does nothing when not requested', () => {
    expect(smokeLiveGate({ liveSmoke: false, mode: 'live', preflightOk: true, escape: false }).allow).toBe(false);
  });
  it('refuses when TRADE_MODE is not live', () => {
    const g = smokeLiveGate({ liveSmoke: true, mode: 'dry-run', preflightOk: true, escape: false });
    expect(g.allow).toBe(false);
    expect(g.reason).toContain('needs TRADE_MODE=live');
  });
  it('refuses when the preflight does not PASS', () => {
    const g = smokeLiveGate({ liveSmoke: true, mode: 'live', preflightOk: false, escape: false });
    expect(g.allow).toBe(false);
    expect(g.reason).toContain('does not PASS');
  });
  it('allows on a passing live gate', () => {
    expect(smokeLiveGate({ liveSmoke: true, mode: 'live', preflightOk: true, escape: false }).allow).toBe(true);
  });
  it('the explicit escape bypasses the gate (with a WARN reason)', () => {
    const g = smokeLiveGate({ liveSmoke: true, mode: 'off', preflightOk: false, escape: true });
    expect(g.allow).toBe(true);
    expect(g.reason).toContain('BYPASSED');
  });
});
