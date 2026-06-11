# GO-LIVE-CHECKLIST — the gated path to real money (§6.20, C5, P10)

`goLiveGate` (packages/trading/src/gate.ts) re-evaluates EVERY condition on
EVERY live placement attempt inside execute-bet — this checklist mirrors its
failure reasons **verbatim**. The /admin page renders the same readout
(wallet-key row carries a "checked at execution" caveat — the web tier cannot
read Edge Function secrets, §8.3). All conditions are always evaluated;
nothing short-circuits.

## The gate conditions (reasons verbatim)

| # | Reason string (verbatim) | How it goes green |
|---|---|---|
| 1 | `POLY_PRIVATE_KEY missing from execute-bet function secrets` | `supabase secrets set POLY_PRIVATE_KEY=…` (Edge Function secrets ONLY — never Vercel env; ADR-10, §11.5). Set `POLY_FUNDER_ADDRESS` / `POLY_SIGNATURE_TYPE` alongside. |
| 2 | `tradingMode is 'paper' (config) — not 'live'` | /admin config → `tradingMode` = `live` (audited). Do this LAST. |
| 3 | `only {n} distinct out-of-sample days scored (need ≥60)` | Operate the paper campaign (P9) — run-calibration accumulates scored days. |
| 4 | `pooled 60d calibration row missing (run-calibration has not produced it)` | The nightly run-calibration writes the pooled zero-UUID row (§7.14, lead −1). |
| 5 | `pooled bootstrap p {p} not < 0.05` | C5: pooled paired-bootstrap significance vs market_consensus on time-matched pairs (ADR-16). Not operator-settable — earned. |
| 6 | `pooled 60d Brier {b} not ≤ 0.95× market ({m})` | C5 point estimate. Earned, not configured. |
| 7 | `city {slug}: only {n} scored events in 60d (need ≥30)` | Per-city enablement needs that city's own sample (bet path only — the /admin readout omits it). |
| 8 | `city {slug}: 60d Brier {b} not ≤ 1.0× market ({m})` | No enabling 5 lucky cities (C5). |
| 9 | `halt active: {halt:key}` | Resolve the underlying breaker, then /admin resume with typed confirmation. |
| 10 | `geoblock: Sweden appears on the Polymarket blocked list` | Hard stop — re-check the legal situation; the gate scans docs.polymarket.com/api-reference/geoblock.md and fails closed. |
| 11 | `geoblock list unreachable — failing closed` | Transient: retry. Persistent: verify the docs URL still exists. |
| 12 | `operator KYC/account-standing attestation not refreshed this quarter (config kycAttestedAt)` | Verify account standing on Polymarket, then /admin config → `kycAttestedAt` = today (ISO date), quarterly. |
| 13 | `bankroll_ledger not reconciled within the last 35 days (config ledgerReconciledAt)` | Run the F-036 monthly sweep (RUNBOOK), then /admin config → `ledgerReconciledAt` = today. |

## P10 enablement procedure (in order)

1. P9 exit criteria met (§14): ≥60 out-of-sample days; pooled p < 0.05 with
   point ≤ 0.95×; per-city ≤ 1.0× with n ≥ 30; breakers quiet ≥ 14 days.
2. Wallet: fund the proxy wallet minimally; set the three `POLY_*` secrets in
   **Supabase Edge Function secrets**.
3. Confirm `/admin` gate readout is green except the tradingMode row.
4. **Rollback drill BEFORE the first order:** set `tradingMode=live`, then
   immediately back to `paper`, confirm config_audit recorded both flips and
   poll-markets keeps recommending paper.
5. Month one: hard cap — set `perTradeCapPct` so per-trade ≤ $20.
6. Set `tradingMode=live`. The next approved recommendation routes through
   LiveExecutor (GTC limit at the stored exec ask, tick-rounded, negRisk).
7. After the first fill: nightly grade-bets reconciliation (F-033) must match
   data-api positions to the cent. Any POSITION_DRIFT CRITICAL → back to
   paper until explained.
