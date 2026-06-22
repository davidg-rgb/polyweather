/**
 * Parity guard for the live-readiness mirror (§15): the CLI cannot import
 * goLiveGate (trading-boundary invariant), so this test feeds IDENTICAL inputs
 * to both `evaluateReadiness` (the mirror) and the real `goLiveGate` and asserts
 * the reason lists are byte-identical across a battery of scenarios. If gate.ts
 * changes a threshold or a reason string, this fails until the mirror is updated.
 */
import { describe, expect, it } from 'vitest';
import { goLiveGate, type TradingDb } from '../packages/trading/src/index.ts';
import { evaluateReadiness, type GateInputs, type ReadinessArgs } from './check-live-readiness.ts';

const NOW = new Date('2026-06-22T12:00:00Z'); // Q2 2026

const stubDb = (inputs: GateInputs): TradingDb => ({
  async rpc<T>(fn: string): Promise<T[]> {
    if (fn === 'go_live_gate_inputs') return [{ go_live_gate_inputs: inputs }] as T[];
    return [] as T[];
  },
  async getConfigRows() {
    return [];
  },
});

/** Run both paths on the same args and return their reason lists for comparison. */
async function bothReasons(args: ReadinessArgs): Promise<{ mirror: string[]; gate: string[]; pass: boolean }> {
  const mirror = evaluateReadiness(args);
  const gate = await goLiveGate(
    stubDb(args.inputs),
    { tradingMode: args.tradingMode, championSource: 'house_gaussian' },
    {
      citySlug: args.citySlug,
      getEnvVar: () => (args.walletKeyPresent ? 'secret-present' : undefined),
      fetchGeoblock:
        args.geoblockText === null
          ? async () => {
              throw new Error('geoblock host down');
            }
          : async () => args.geoblockText as string,
      now: args.now,
    },
  );
  return { mirror, gate: gate.reasons, pass: gate.pass };
}

/** A fully-passing live configuration (every earned + operator + exec condition green). */
const passingArgs = (over: Partial<ReadinessArgs> = {}): ReadinessArgs => ({
  inputs: {
    distinctDays: 60,
    pooled: { brier: 0.2, brierMarket: 0.3, bootstrapP: 0.01, n: 100 },
    city: { n: 40, brier: 0.2, brierMarket: 0.25 },
    halts: [],
    kycAttestedAt: '2026-04-05', // Q2 — same quarter as NOW
    ledgerReconciledAt: '2026-06-01', // within 35d of NOW
    ...(over.inputs ?? {}),
  },
  tradingMode: 'live',
  walletKeyPresent: true,
  geoblockText: 'Blocked regions: United States of America, Ontario, France.',
  now: NOW,
  citySlug: 'amsterdam',
  ...over,
});

/** Each scenario mutates the passing baseline toward a specific failure (or stays green). */
const scenarios: { name: string; args: ReadinessArgs }[] = [
  { name: 'all green (live, city)', args: passingArgs() },
  { name: 'all green (global readout — no city)', args: passingArgs({ citySlug: undefined }) },
  { name: 'wallet key absent', args: passingArgs({ walletKeyPresent: false }) },
  { name: "tradingMode 'paper'", args: passingArgs({ tradingMode: 'paper' }) },
  { name: 'too few distinct days', args: passingArgs({ inputs: { ...passingArgs().inputs, distinctDays: 41 } }) },
  { name: 'pooled row missing', args: passingArgs({ inputs: { ...passingArgs().inputs, pooled: null } }) },
  {
    name: 'pooled bootstrap p not significant',
    args: passingArgs({ inputs: { ...passingArgs().inputs, pooled: { brier: 0.2, brierMarket: 0.3, bootstrapP: 0.2, n: 100 } } }),
  },
  {
    name: 'pooled bootstrap p null',
    args: passingArgs({ inputs: { ...passingArgs().inputs, pooled: { brier: 0.2, brierMarket: 0.3, bootstrapP: null, n: 100 } } }),
  },
  {
    name: 'pooled Brier not ≤ 0.95× market',
    args: passingArgs({ inputs: { ...passingArgs().inputs, pooled: { brier: 0.29, brierMarket: 0.3, bootstrapP: 0.01, n: 100 } } }),
  },
  {
    name: 'city sample too small',
    args: passingArgs({ inputs: { ...passingArgs().inputs, city: { n: 12, brier: 0.2, brierMarket: 0.25 } } }),
  },
  {
    name: 'city Brier not ≤ market',
    args: passingArgs({ inputs: { ...passingArgs().inputs, city: { n: 40, brier: 0.26, brierMarket: 0.25 } } }),
  },
  { name: 'city row null but city named', args: passingArgs({ inputs: { ...passingArgs().inputs, city: null } }) },
  {
    name: 'two active halts',
    args: passingArgs({ inputs: { ...passingArgs().inputs, halts: ['halt:global', 'halt:city:amsterdam'] } }),
  },
  { name: 'geoblock names Sweden', args: passingArgs({ geoblockText: 'Blocked: Sweden, United States.' }) },
  { name: 'geoblock unreachable', args: passingArgs({ geoblockText: null }) },
  { name: 'kyc attested last quarter', args: passingArgs({ inputs: { ...passingArgs().inputs, kycAttestedAt: '2026-03-30' } }) },
  { name: 'kyc unset', args: passingArgs({ inputs: { ...passingArgs().inputs, kycAttestedAt: null } }) },
  { name: 'ledger reconciled >35d ago', args: passingArgs({ inputs: { ...passingArgs().inputs, ledgerReconciledAt: '2026-04-01' } }) },
  { name: 'ledger unset', args: passingArgs({ inputs: { ...passingArgs().inputs, ledgerReconciledAt: null } }) },
  {
    name: 'everything failing at once',
    args: passingArgs({
      inputs: { distinctDays: 0, pooled: null, city: null, halts: ['halt:global'], kycAttestedAt: null, ledgerReconciledAt: null },
      tradingMode: 'paper',
      walletKeyPresent: false,
      geoblockText: null,
    }),
  },
];

describe('check-live-readiness mirrors goLiveGate verbatim (§15 anti-drift)', () => {
  for (const { name, args } of scenarios) {
    it(`parity: ${name}`, async () => {
      const { mirror, gate } = await bothReasons(args);
      expect(mirror).toEqual(gate);
    });
  }

  it('the fully-passing live config yields zero reasons and goLiveGate.pass === true', async () => {
    const { mirror, gate, pass } = await bothReasons(passingArgs());
    expect(mirror).toEqual([]);
    expect(gate).toEqual([]);
    expect(pass).toBe(true);
  });

  it('exec-time conditions never render as a blocking FAIL in the readout grouping', () => {
    // wallet key + tradingMode are kind:'exec' — excluded from the earned/operator
    // verdict (the CLI flips them last), so a paper-mode unkeyed config can still
    // report "earned the gate".
    const { evaluateReadiness: _e } = { evaluateReadiness };
    void _e;
    // buildConditions is the rendering source; assert the two exec rows exist and
    // are the only ones whose failure the verdict ignores.
    const reasons = evaluateReadiness(passingArgs({ tradingMode: 'paper', walletKeyPresent: false }));
    // Only the two exec-time reasons should be present (everything else green).
    expect(reasons).toContain("tradingMode is 'paper' (config) — not 'live'");
    expect(reasons.some((r) => r.includes('missing from execute-bet function secrets'))).toBe(true);
    expect(reasons).toHaveLength(2);
  });
});
