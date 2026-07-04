# city-paper-trade placement fix — the 0081 top-level-array port trap (0081 + handler + entrypoint)

> **✅ DEPLOYED 2026-07-04 ~19:27Z (operator go, in-session):** migration **0081 APPLIED** via MCP
> `apply_migration` + **`city-paper-trade` REDEPLOYED** via the authed CLI + smoke PASS
> (`jsonb_typeof` = object, `->'rows'` = array of **4** configs: ankara/houston/karachi/singapore).
> **✅ §3 GAP-FILL DONE 2026-07-04 22:08Z** (`city-sim.ts --from 2026-07-04 --to 2026-07-04`):
> **24 bets landed for target 07-04** — KHOU (°F) arms 11–16 · LTAC arms 11–16 · OPKC arms 10–15 ·
> WSSS arms 10–15, verified per-city via read-only SQL. Remaining: **only the §4 verification** at
> the 2026-07-05 10:00Z tick (`stats.cities:4, placed>0` at a CRON slot — the end-to-end proof).
>
> ~~Staged DARK (built 2026-07-04, not applied/deployed).~~ Migration **0081** + the `city-paper-trade`
> handler/entrypoint fix. Restores daily bet PLACEMENT on `/paper-trade`, which has silently placed **zero**
> bets via cron since migration 0070 shipped. Rail stays DORMANT — this is the analytics paper-trade, not
> trading; Claude never places a real trade or touches keys.

Project ref: `lenysiqxihsmxljvyybt` (eu-north-1). SQL via the Supabase SQL editor / MCP `execute_sql`;
edge-fn deploy via the authed CLI (`npx --no-install supabase functions deploy city-paper-trade --use-api
--project-ref lenysiqxihsmxljvyybt`, the repo idiom).

---

## 1. The defect

`city_sim_active_configs()` (migration 0070, run-window-gated in 0075) returned a **TOP-LEVEL jsonb array**
(`coalesce(jsonb_agg(...), '[]')` straight into the return value). The Edge service-role port
(`supabase/functions/_shared/db.ts` `supabasePort`, mirrored by `apps/web` `port.ts`) normalizes a PostgREST
result **by shape**: an array is assumed to be a `RETURNS TABLE` row set and passed through **unwrapped**;
only a bare object/scalar is wrapped as `[{ [fn]: value }]`. `supabase-js .rpc()` returns the **bare** jsonb
for a scalar function, so the bare array was passed straight through → the handler's
`cfgRows[0]?.city_sim_active_configs` was **undefined** → `configs = []` → the daily `city-paper-trade` tick
placed **nothing, every day**, while `job_runs` reported `status: 'ok'`.

This is the **exact same trap** as migration 0044 (the two Amsterdam `*_inputs` RPCs). The GRADE half of the
tick worked only because `city_sim_grade_inputs()` was already wrapped in `{ rows: [...] }` (the 0044
workaround); the config read was the one that slipped through.

**Why it shipped green:** the PGlite test twin (`supabase/tests/pglite-port.ts`) runs `select * from fn()`,
which wraps **either** shape (array or object) into one row → every integration test saw the correct
`[{fn: value}]` shape. Prod (bare value) and the twin (always-wrapped) diverge precisely on top-level arrays.

## 2. The evidence

- **Prod `job_runs.stats` on the 10:00Z ticks show `cities:0, placed:0`** on 2026-07-03 and 2026-07-04 (the
  RPC returned configs server-side, but the isolate read `[]`).
- **Every existing `city_paper_bets` row traces to a manual backfill script**, never to a cron placement:
  the last bets were written at **20:11Z 2026-07-03** and **23:07Z 2026-07-02** (the operator's
  `scripts/city-sim.ts` runs), not at any 10:00Z cron slot.
- Reproduced deterministically in a unit test that feeds the PostgREST **bare-array** shape through a fake
  `DbPort`: the old read yields `configs=[]` (cities:0/placed:0); the fixed read places
  (`supabase/tests/city-sim.test.ts` → "the 0081 PostgREST bare-array defect").

## 3. What the fix changes (all staged dark)

| Artifact | Change |
| --- | --- |
| `supabase/migrations/0081_city_sim_active_configs_rows_wrap.sql` | Redefine `city_sim_active_configs()` to return `jsonb_build_object('rows', coalesce(jsonb_agg(...), '[]'))`. Pure **envelope** change — the inner aggregate + the 0075 `active_until` run-window gate are byte-identical. `SECURITY DEFINER`, `search_path=public`, service-role grant re-asserted. |
| `supabase/functions/city-paper-trade/handler.ts` | `readActiveConfigs()` tolerantly reads **all three shapes**: (a) new RPC `{rows:[...]}` via PostgREST/twin, (b) pre-0081 bare array via PostgREST (the defect), (c) pre-0081 array via the twin. **Deploy-order-safe** — the handler places whether or not 0081 is applied. |
| `supabase/functions/city-paper-trade/index.ts` | Parse an optional `{ targetDate: 'YYYY-MM-DD' }` from the request body and pass it to the handler, enabling the manual gap-fill below (the handler already accepted `deps.targetDate`; the entrypoint did not wire it). |
| `scripts/city-sim.ts` | The seed/backfill reads `city_sim_active_configs()` via direct SQL (`select fn() as v`), so it now unwraps `.rows` tolerantly too (deploy-order-safe against either RPC version). |
| `supabase/tests/{migrations,city-sim}.test.ts` | 0081 manifest entry; a `jsonb_typeof = 'object'` twin guard; the fake-port defect proof; and a **CLASS tripwire** that enumerates every public no-arg `RETURNS jsonb` function and forbids a top-level array. |

## 4. Operator rollout bundle (in order)

> One DB op at a time; each step has a verify + rollback line. Stop on any regression.

**Step 1 — apply migration 0081.**
Apply `0081_city_sim_active_configs_rows_wrap.sql`.
Verify (should be `object` / `array`):
```sql
select jsonb_typeof(public.city_sim_active_configs())            as outer,   -- object
       jsonb_typeof(public.city_sim_active_configs() -> 'rows')  as inner;   -- array
```
Rollback: re-apply the 0075 body (top-level array). Safe — the fixed handler reads that shape too (shape c/b).

**Step 2 — redeploy the `city-paper-trade` edge function** (handler + entrypoint fix):
```
npx --no-install supabase functions deploy city-paper-trade --use-api --project-ref lenysiqxihsmxljvyybt
```
Rollback: redeploy the previous function build. **0081 is backward-tolerated by the fixed handler**, so the
apply/redeploy order of steps 1↔2 is not load-bearing for the fixed handler (the only state to avoid is the
*old* handler against the *new* RPC — naturally avoided since both ship in this bundle).

**Step 3 — manual gap-fill for the missed day 2026-07-04.**
The daily cron uses each city's local "today"; to backfill a specific missed day, POST a `targetDate` override
plus a unique `periodKey` (so the retrigger doesn't 409 against the day's already-claimed slot). Replace
`$CRON_SECRET` with the Vault `cron_secret`:
```bash
curl -sS -X POST \
  'https://lenysiqxihsmxljvyybt.supabase.co/functions/v1/city-paper-trade' \
  -H 'Content-Type: application/json' \
  -H "x-cron-secret: $CRON_SECRET" \
  -d '{"targetDate":"2026-07-04","periodKey":"city-paper-trade:2026-07-04:manual:gapfill"}'
```
> **Timing:** the °F city arms run latest — Houston (KHOU, last arm 16:00 CDT = **21:00Z**) and Ankara
> (LTAC, last arm ~17:00 local ≈ **14:00Z**) — so for a same-day 07-04 gap-fill, run this **after ~22:00Z
> 07-04** (or next morning) so every arm's lock hour has passed and its odds are on the book. Earlier arms
> that are already due are placed; not-yet-due arms are simply skipped (no phantom bets) and can be filled on
> a later retrigger. Idempotent (`city_sim_record` is `ON CONFLICT DO NOTHING` — odds lock at first placement).
>
> **Alternative (equivalent):** run the seed script from a dev box —
> `pnpm tsx scripts/city-sim.ts --from 2026-07-04 --to 2026-07-04` — same core planners, byte-identical bets.

**Step 4 — verification (the next scheduled tick).**
After the next 10:00Z cron slot:
```sql
select period_key, status, stats
from job_runs
where job = 'city-paper-trade'
order by started_at desc
limit 3;
```
Expect `status = 'ok'` with **`stats.cities = 4`** (the 4 active cities: singapore, karachi, houston, ankara —
confirm the live active set) and **`stats.placed > 0`**. Then confirm the bets landed at a cron slot:
```sql
select target_date, count(*), min(created_at), max(created_at)
from city_paper_bets
where created_at >= now() - interval '2 days'
group by target_date order by target_date desc;
```
Rollback (per step): redeploy the previous function (step 2) and/or re-apply the 0075 RPC body (step 1) —
both are tolerated by the fixed handler, so a partial rollback cannot wedge the tick.

## 5. Guardrail added

`migrations.test.ts` now carries a **tripwire for the CLASS**: it enumerates every public no-arg
`RETURNS jsonb` function and asserts none returns a top-level jsonb array (`jsonb_typeof <> 'array'`). The
prior `no RETURNS SETOF` guard caught one form of the port-misread; this catches its corollary, so a **third**
instance of this trap cannot ship green.
