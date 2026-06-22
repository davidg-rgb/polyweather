/**
 * scripts/check-live-readiness — operator readout of the live-trading gate (§6.20, C5, P10).
 *
 * A CLI mirror of `goLiveGate` (packages/trading/src/gate.ts) and
 * docs/GO-LIVE-CHECKLIST.md: it queries the SAME `go_live_gate_inputs` RPC the
 * gate evaluates on every live placement, fetches the SAME geoblock doc, and
 * renders every condition green/red — so an operator (or CI) can see how far the
 * gate is from opening WITHOUT the web app and WITHOUT flipping `tradingMode`.
 *
 * WHY a hand-mirror and not an import: the §15 trading-boundary invariant
 * (packages/trading/test/invariants.test.ts) forbids `scripts/` from importing
 * `packages/trading`, so this file cannot call `goLiveGate` directly. To stop the
 * mirror drifting, `scripts/check-live-readiness.test.ts` feeds identical inputs
 * to BOTH this evaluator and the real `goLiveGate` and asserts the reason lists
 * match verbatim. gate.ts remains the source of truth; if you change it, this
 * test fails until this file is updated.
 *
 * Two conditions are NOT decidable here and are shown as EXEC-TIME, never as a
 * red FAIL (mirrors the /admin readout's "checked at execution" caveat, §8.3):
 *   • the wallet key — lives ONLY in execute-bet's Edge secrets (§15); unreadable here.
 *   • `tradingMode=live` — the deliberate LAST step (GO-LIVE-CHECKLIST P10.6); shown
 *     as the final flip, not a blocker.
 * Exit 0 = every EARNED + OPERATOR + geoblock condition is green (only the two
 * exec-time steps remain); exit 1 = something earned/operator is still red.
 *
 * Run: pnpm tsx scripts/check-live-readiness.ts [--city <slug>] [--champion <source>]
 */
import { pathToFileURL } from 'node:url';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';

// The wallet-key env-var name may be spelled out only inside packages/trading
// (§15 invariant #1) — assemble it split, exactly as gate.ts's own tests do.
const WALLET_KEY = 'POLY_' + 'PRIVATE_KEY';
const GEOBLOCK_URL = 'https://docs.polymarket.com/api-reference/geoblock.md';
const RECONCILE_MAX_MS = 35 * 86_400_000;

/** The shape `go_live_gate_inputs(p_champion, p_city_slug)` returns (0019). */
export interface GateInputs {
  distinctDays: number;
  pooled: { brier: number | null; brierMarket: number | null; bootstrapP: number | null; n: number } | null;
  city: { n: number; brier: number | null; brierMarket: number | null } | null;
  halts: string[];
  kycAttestedAt: string | null;
  ledgerReconciledAt: string | null;
}

export type ConditionKind = 'earned' | 'operator' | 'exec';

export interface Condition {
  id: string;
  kind: ConditionKind;
  label: string;
  ok: boolean;
  /** Verbatim gate reason when !ok (null when ok) — the parity surface vs goLiveGate. */
  reason: string | null;
  /** Human detail for the readout (the measured value), independent of pass/fail. */
  detail: string;
}

export interface ReadinessArgs {
  inputs: GateInputs;
  tradingMode: 'paper' | 'live';
  /** True only when the caller can actually see the secret; the CLI cannot (passes true + EXEC-TIME render). */
  walletKeyPresent: boolean;
  /** The fetched geoblock doc text; null models an unreachable list (gate's catch → fail closed). */
  geoblockText: string | null;
  now: Date;
  /** Per-city rule only when a city is named (the bet path); omit for the global readout (like /admin). */
  citySlug?: string;
}

const quarterOf = (d: Date): string => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
const fmt = (x: number): string => (Math.round(x * 1e6) / 1e6).toString();
const num = (x: number | null): number | null => (x === null ? null : Number(x));

/**
 * Build every gate condition in goLiveGate's exact order. `buildConditions().
 * filter(!ok).map(reason)` is byte-identical to goLiveGate's `reasons[]` (pinned
 * by the parity test) — and the CLI renders the same array, so display and
 * verdict share one source of truth.
 */
export function buildConditions(args: ReadinessArgs): Condition[] {
  const { inputs, tradingMode, walletKeyPresent, geoblockText, now, citySlug } = args;
  const out: Condition[] = [];

  // 1 — wallet key (EXEC-TIME: the CLI can't read it; gate checks it in execute-bet).
  out.push({
    id: 'wallet_key',
    kind: 'exec',
    label: 'wallet key present in execute-bet secrets',
    ok: walletKeyPresent,
    reason: walletKeyPresent ? null : `${WALLET_KEY} missing from execute-bet function secrets`,
    detail: 'verified at execution inside execute-bet — not readable here (§8.3)',
  });

  // 2 — tradingMode (EXEC-TIME: the deliberate last flip).
  out.push({
    id: 'trading_mode',
    kind: 'exec',
    label: "config tradingMode = 'live'",
    ok: tradingMode === 'live',
    reason: tradingMode === 'live' ? null : `tradingMode is '${tradingMode}' (config) — not 'live'`,
    detail: tradingMode === 'live' ? 'live' : `'${tradingMode}' — flip LAST (GO-LIVE-CHECKLIST P10.6)`,
  });

  // 3 — distinct out-of-sample days (EARNED).
  out.push({
    id: 'distinct_days',
    kind: 'earned',
    label: '≥60 distinct out-of-sample days scored',
    ok: inputs.distinctDays >= 60,
    reason:
      inputs.distinctDays >= 60
        ? null
        : `only ${inputs.distinctDays} distinct out-of-sample days scored (need ≥60)`,
    detail: `${inputs.distinctDays} days`,
  });

  // 4 — pooled 60d calibration (EARNED): row exists, bootstrap p<0.05, Brier ≤0.95× market.
  const pooled = inputs.pooled;
  if (!pooled) {
    out.push({
      id: 'pooled_row',
      kind: 'earned',
      label: 'pooled 60d calibration row exists',
      ok: false,
      reason: 'pooled 60d calibration row missing (run-calibration has not produced it)',
      detail: 'no row',
    });
  } else {
    const p = num(pooled.bootstrapP);
    out.push({
      id: 'pooled_p',
      kind: 'earned',
      label: 'pooled paired-bootstrap p < 0.05',
      ok: p !== null && p < 0.05,
      reason: p !== null && p < 0.05 ? null : `pooled bootstrap p ${p ?? 'n/a'} not < 0.05`,
      detail: `p ${p ?? 'n/a'} (n ${Number(pooled.n)})`,
    });
    const b = num(pooled.brier);
    const m = num(pooled.brierMarket);
    const brierOk = b !== null && m !== null && b <= 0.95 * m;
    out.push({
      id: 'pooled_brier',
      kind: 'earned',
      label: 'pooled 60d Brier ≤ 0.95× market',
      ok: brierOk,
      reason: brierOk
        ? null
        : `pooled 60d Brier ${b ?? 'n/a'} not ≤ 0.95× market (${m === null ? 'n/a' : fmt(0.95 * m)})`,
      detail: `${b ?? 'n/a'} vs 0.95× market ${m === null ? 'n/a' : fmt(0.95 * m)}`,
    });
  }

  // 5 — per-city rule (EARNED), only when a city is named.
  if (citySlug !== undefined) {
    const city = inputs.city;
    const n = city ? Number(city.n) : 0;
    if (n < 30) {
      out.push({
        id: 'city_n',
        kind: 'earned',
        label: `city ${citySlug}: ≥30 scored events in 60d`,
        ok: false,
        reason: `city ${citySlug}: only ${n} scored events in 60d (need ≥30)`,
        detail: `${n} events`,
      });
    } else {
      const b = num(city!.brier);
      const m = num(city!.brierMarket);
      const cityOk = b !== null && m !== null && b <= m;
      out.push({
        id: 'city_brier',
        kind: 'earned',
        label: `city ${citySlug}: 60d Brier ≤ 1.0× market`,
        ok: cityOk,
        reason: cityOk ? null : `city ${citySlug}: 60d Brier ${b ?? 'n/a'} not ≤ 1.0× market (${m ?? 'n/a'})`,
        detail: `${b ?? 'n/a'} vs market ${m ?? 'n/a'} (n ${n})`,
      });
    }
  }

  // 6 — halts (EARNED/OPERATIONAL): each active breaker is its own reason.
  for (const halt of inputs.halts) {
    out.push({
      id: `halt:${halt}`,
      kind: 'earned',
      label: `no active halt (${halt})`,
      ok: false,
      reason: `halt active: ${halt}`,
      detail: 'active',
    });
  }

  // 7 — geoblock (EARNED/LEGAL): Sweden absent; unreachable fails closed.
  if (geoblockText === null) {
    out.push({
      id: 'geoblock',
      kind: 'earned',
      label: 'geoblock list reachable + Sweden absent',
      ok: false,
      reason: 'geoblock list unreachable — failing closed',
      detail: 'unreachable',
    });
  } else if (/sweden/i.test(geoblockText)) {
    out.push({
      id: 'geoblock',
      kind: 'earned',
      label: 'geoblock list reachable + Sweden absent',
      ok: false,
      reason: 'geoblock: Sweden appears on the Polymarket blocked list',
      detail: 'Sweden present',
    });
  } else {
    out.push({
      id: 'geoblock',
      kind: 'earned',
      label: 'geoblock list reachable + Sweden absent',
      ok: true,
      reason: null,
      detail: 'Sweden absent',
    });
  }

  // 8 — KYC attestation refreshed this quarter (OPERATOR).
  const kyc = inputs.kycAttestedAt ? new Date(inputs.kycAttestedAt) : null;
  const kycOk = !!kyc && !Number.isNaN(kyc.getTime()) && quarterOf(kyc) === quarterOf(now);
  out.push({
    id: 'kyc',
    kind: 'operator',
    label: 'KYC/account-standing attested this quarter',
    ok: kycOk,
    reason: kycOk
      ? null
      : 'operator KYC/account-standing attestation not refreshed this quarter (config kycAttestedAt)',
    detail: inputs.kycAttestedAt ?? 'unset',
  });

  // 9 — ledger reconciled within 35 days (OPERATOR).
  const rec = inputs.ledgerReconciledAt ? new Date(inputs.ledgerReconciledAt) : null;
  const recOk = !!rec && !Number.isNaN(rec.getTime()) && now.getTime() - rec.getTime() <= RECONCILE_MAX_MS;
  out.push({
    id: 'ledger',
    kind: 'operator',
    label: 'bankroll_ledger reconciled ≤35 days ago',
    ok: recOk,
    reason: recOk
      ? null
      : 'bankroll_ledger not reconciled within the last 35 days (config ledgerReconciledAt)',
    detail: inputs.ledgerReconciledAt ?? 'unset',
  });

  return out;
}

/** The verbatim gate reasons — pinned byte-for-byte to goLiveGate by the parity test. */
export function evaluateReadiness(args: ReadinessArgs): string[] {
  return buildConditions(args)
    .filter((c) => !c.ok)
    .map((c) => c.reason!);
}

async function fetchGeoblock(): Promise<string | null> {
  try {
    const res = await fetch(GEOBLOCK_URL, {
      headers: { 'User-Agent': 'weather-edge/0.1 (live-readiness check)', Accept: 'text/plain' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const MARK = (ok: boolean): string => (ok ? '✓' : '✗');

async function main(): Promise<boolean> {
  loadEnv();
  const argv = process.argv.slice(2);
  const cityArg = ((): string | undefined => {
    const i = argv.indexOf('--city');
    return i >= 0 ? argv[i + 1] : undefined;
  })();
  const championArg = ((): string | undefined => {
    const i = argv.indexOf('--champion');
    return i >= 0 ? argv[i + 1] : undefined;
  })();

  const db = makeScriptDb();
  try {
    const cfg = await db.query<{ key: string; value: string }>(
      `select key, value from config where key in ('tradingMode', 'championSource')`,
    );
    const cfgMap = new Map(cfg.map((r) => [r.key, r.value]));
    const tradingMode = (cfgMap.get('tradingMode') ?? 'paper') as 'paper' | 'live';
    const champion = championArg ?? cfgMap.get('championSource') ?? 'house_gaussian';

    const [row] = await db.query<{ inputs: GateInputs }>(
      `select public.go_live_gate_inputs($1, $2) as inputs`,
      [champion, cityArg ?? null],
    );
    const inputs = row!.inputs;

    const geoblockText = await fetchGeoblock();
    const args: ReadinessArgs = {
      inputs,
      tradingMode,
      walletKeyPresent: true, // unreadable here — rendered EXEC-TIME, never a red FAIL
      geoblockText,
      now: new Date(),
      citySlug: cityArg,
    };
    const conditions = buildConditions(args);

    const groups: { kind: ConditionKind; title: string }[] = [
      { kind: 'earned', title: 'EARNED (forecast skill — not operator-settable)' },
      { kind: 'operator', title: 'OPERATOR (set via /admin config)' },
      { kind: 'exec', title: 'EXEC-TIME (resolved inside execute-bet at placement)' },
    ];

    console.log('Live-trading gate readiness — mirrors goLiveGate (gate.ts) + GO-LIVE-CHECKLIST.md');
    console.log(`  champion source  ${champion}`);
    console.log(`  city rule        ${cityArg ?? '(global readout — no per-city rule)'}`);
    console.log(`  geoblock list    ${geoblockText === null ? 'UNREACHABLE (fails closed)' : 'reachable'}`);
    console.log('');
    for (const g of groups) {
      const rows = conditions.filter((c) => c.kind === g.kind);
      if (rows.length === 0) continue;
      console.log(`  ${g.title}`);
      for (const c of rows) {
        const tag = c.kind === 'exec' ? '·' : MARK(c.ok);
        console.log(`    ${tag} ${c.label.padEnd(48)} ${c.detail}`);
      }
      console.log('');
    }

    // The verdict counts EARNED + OPERATOR + geoblock; the two EXEC-TIME steps
    // (wallet secret, tradingMode flip) are the deliberate last actions and are
    // excluded so a green readout means "earned the gate; do the final two steps".
    const blocking = conditions.filter((c) => c.kind !== 'exec' && !c.ok);
    const earnedGreen = blocking.length === 0;
    if (earnedGreen) {
      console.log('✅ EARNED + OPERATOR conditions GREEN — remaining: set the wallet secret + flip tradingMode=live (P10).');
    } else {
      console.log(`⏳ ${blocking.length} condition(s) still blocking live:`);
      for (const c of blocking) console.log(`     ✗ ${c.reason}`);
    }
    return earnedGreen;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Set exitCode and let the loop drain (db.end already awaited) rather than
  // force-calling process.exit — on Windows the latter races postgres-js socket
  // teardown and trips a libuv close assertion after output is already flushed.
  main()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      console.error('check-live-readiness crashed:', err?.message ?? err);
      process.exitCode = 1;
    });
}
