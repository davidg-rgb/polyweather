/**
 * goLiveGate — every condition for live mode, evaluated fresh on every live
 * placement attempt (ARCHITECTURE.md §6.20, C5). ALL conditions are always
 * evaluated (checklist semantics — the dashboard shows every failed reason
 * verbatim), never short-circuited.
 *
 * C5 fix: a 0.95× point threshold alone is passable by noise ≈30% of the
 * time — the gate demands ≥60 distinct out-of-sample days AND pooled paired
 * bootstrap p < 0.05 AND the pooled point estimate ≤ 0.95×; per-city betting
 * additionally requires that city's own 60d estimate ≤ 1.0× with n ≥ 30
 * (no enabling 5 lucky cities).
 */
import type { TradingDb } from './types.ts';

export interface GateInputs {
  distinctDays: number;
  pooled: { brier: number | null; brierMarket: number | null; bootstrapP: number | null; n: number } | null;
  city: { n: number; brier: number | null; brierMarket: number | null } | null;
  halts: string[];
  kycAttestedAt: string | null;
  ledgerReconciledAt: string | null;
}

export interface GateDeps {
  /** Bet's city for the per-city C5 rule; omit for the global /admin readout. */
  citySlug?: string;
  /** Env probe — execute-bet injects Deno.env; tests inject a stub. */
  getEnvVar: (name: string) => string | undefined;
  /** Polymarket geoblock list (docs page text). Fetch failure ⇒ fail closed. */
  fetchGeoblock: () => Promise<string>;
  now: Date;
}

const quarterOf = (d: Date): string => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;

const fmt = (x: number): string => (Math.round(x * 1e6) / 1e6).toString();

export async function goLiveGate(
  db: TradingDb,
  cfg: { tradingMode: 'paper' | 'live'; championSource: string },
  deps: GateDeps,
): Promise<{ pass: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  if (!deps.getEnvVar('POLY_PRIVATE_KEY')) {
    reasons.push('POLY_PRIVATE_KEY missing from execute-bet function secrets');
  }
  if (cfg.tradingMode !== 'live') {
    reasons.push(`tradingMode is '${cfg.tradingMode}' (config) — not 'live'`);
  }

  const [row] = await db.rpc<{ go_live_gate_inputs: GateInputs }>('go_live_gate_inputs', {
    p_champion: cfg.championSource,
    p_city_slug: deps.citySlug ?? null,
  });
  const inputs = row!.go_live_gate_inputs;

  if (inputs.distinctDays < 60) {
    reasons.push(`only ${inputs.distinctDays} distinct out-of-sample days scored (need ≥60)`);
  }

  const pooled = inputs.pooled;
  if (!pooled) {
    reasons.push('pooled 60d calibration row missing (run-calibration has not produced it)');
  } else {
    const p = pooled.bootstrapP === null ? null : Number(pooled.bootstrapP);
    if (p === null || !(p < 0.05)) {
      reasons.push(`pooled bootstrap p ${p ?? 'n/a'} not < 0.05`);
    }
    const b = pooled.brier === null ? null : Number(pooled.brier);
    const m = pooled.brierMarket === null ? null : Number(pooled.brierMarket);
    if (b === null || m === null || !(b <= 0.95 * m)) {
      reasons.push(
        `pooled 60d Brier ${b ?? 'n/a'} not ≤ 0.95× market (${m === null ? 'n/a' : fmt(0.95 * m)})`,
      );
    }
  }

  if (deps.citySlug !== undefined) {
    const city = inputs.city;
    const n = city ? Number(city.n) : 0;
    if (n < 30) {
      reasons.push(`city ${deps.citySlug}: only ${n} scored events in 60d (need ≥30)`);
    } else {
      const b = city!.brier === null ? null : Number(city!.brier);
      const m = city!.brierMarket === null ? null : Number(city!.brierMarket);
      if (b === null || m === null || !(b <= m)) {
        reasons.push(
          `city ${deps.citySlug}: 60d Brier ${b ?? 'n/a'} not ≤ 1.0× market (${m ?? 'n/a'})`,
        );
      }
    }
  }

  for (const halt of inputs.halts) {
    reasons.push(`halt active: ${halt}`);
  }

  // Geoblock re-check: Sweden must be ABSENT from the blocked list. Any
  // mention of Sweden in the list text fails closed (a false positive costs an
  // operator look; a false negative costs a rejected/frozen order) — as does
  // an unreachable list.
  try {
    const text = await deps.fetchGeoblock();
    if (/sweden/i.test(text)) {
      reasons.push('geoblock: Sweden appears on the Polymarket blocked list');
    }
  } catch {
    reasons.push('geoblock list unreachable — failing closed');
  }

  // Operator KYC/account-standing attestation, refreshed this quarter
  // (config row 'kycAttestedAt', written via /admin).
  const kyc = inputs.kycAttestedAt ? new Date(inputs.kycAttestedAt) : null;
  if (!kyc || Number.isNaN(kyc.getTime()) || quarterOf(kyc) !== quarterOf(deps.now)) {
    reasons.push(
      'operator KYC/account-standing attestation not refreshed this quarter (config kycAttestedAt)',
    );
  }

  // bankroll_ledger reconciled against actual balances on the F-036 monthly
  // cadence (config row 'ledgerReconciledAt', written via /admin).
  const rec = inputs.ledgerReconciledAt ? new Date(inputs.ledgerReconciledAt) : null;
  const RECONCILE_MAX_MS = 35 * 86_400_000;
  if (!rec || Number.isNaN(rec.getTime()) || deps.now.getTime() - rec.getTime() > RECONCILE_MAX_MS) {
    reasons.push('bankroll_ledger not reconciled within the last 35 days (config ledgerReconciledAt)');
  }

  return { pass: reasons.length === 0, reasons };
}
