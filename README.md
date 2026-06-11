# Weather Edge

A calibrated weather-forecasting edge engine for Polymarket daily-temperature
markets. The system snapshots multi-model forecasts, learns per-station bias/σ
(EMOS-style), prices the bucket ladder, compares against the order book, and
recommends fractional-Kelly stakes — paper-traded until the go-live gate is
statistically earned.

**Contract:** [ARCHITECTURE.md](./ARCHITECTURE.md) is the blueprint; every
module, table, and endpoint is specified there. [REQUIREMENTS.md](./REQUIREMENTS.md)
is the source spec. Build progress and operator actions live in
[BUILD-STATE.md](./BUILD-STATE.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure domain logic (parsing, math, calibration, Kelly) — no IO |
| `supabase/migrations` | Schema 0001–0010: reference → ingestion → markets → analytics → trading → ops → RLS → cron → seed |
| `supabase/functions` | Deno Edge Functions (11 scheduled jobs + execute-bet) |
| `supabase/tests` | Migration tests against embedded Postgres (PGlite) |
| `apps/web` | Next.js dashboard + operator API |
| `scripts/` | Local CLIs: seed-stations, backfill-forecasts/actuals/market-history, simulate-historical-edge, backup-db, smoke-live-apis |
| `research/` | Live-verified API ground truth — parsers must match these fixtures exactly |
| `docs/` | DATA-SOURCES · CALIBRATION · TRADING-MATH · GO-LIVE-CHECKLIST (mirrors the gate verbatim) |
| `RUNBOOK.md` | Incidents, manual triggers, backfill ops, backups, the F-036 monthly sweep |

## Quickstart

```bash
pnpm install
pnpm typecheck     # strict TS across all packages
pnpm test          # vitest: 540+ tests — core math, PGlite-backed jobs/RPCs, web loaders, scripts
pnpm dev           # the Next.js dashboard (needs .env.local — see .env.example)
pnpm --filter @weather-edge/web build
pnpm tsx scripts/smoke-live-apis.ts   # one live call per upstream, real parsers (12/12 PASS)
```

The migration suite boots an embedded Postgres, applies the full migration
chain twice, and verifies natural keys, indexes, RLS (anon sees nothing;
operator email reads all; writes service-role only), the §6.11 config seed,
the model seed (incl. disabled trap models), the pg_cron registrations
(secrets via Vault — never literal), and every retention rule of the
downsample cron.

### Hosted Supabase (operator steps)

1. Create the Supabase project (free tier carries P0–P3; Pro from P4 — R-4).
2. `supabase link --project-ref <ref>` then `supabase db reset` (applies 0001–0010).
3. Seed Vault secrets `cron_secret` and `project_url` (RUNBOOK; pg_cron commands read them at run time).
4. Copy `.env.example` → `.env.local` and fill in project keys.

## Status

**P0–P8 build-complete** — every module, job, page, and script implemented and
tested; trading is paper-mode everywhere (live execution stays dormant behind
the §6.20 gate). Remaining work is operator-gated: hosted deploy, full-universe
backfill, the 60-day paper campaign (P9), then go-live (P10) — see the
Operator TODO in [BUILD-STATE.md](./BUILD-STATE.md).
Verification checklist: ARCHITECTURE.md §15 (boxes tick as items are proven by tests).
