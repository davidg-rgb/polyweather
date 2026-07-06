# CITY-LIVE — continuous winner promotion + operator live-testing rail

> Spec written 2026-07-06 (v13 loop, operator directive of the same day). This is the interface
> contract for four parallel build lanes (P core / D db+edge / X daemon / W web). Interfaces here
> are LOCKED — a lane that needs to deviate reports back instead of drifting.

## 0. Locked operator decisions (2026-07-06, AskUserQuestion round)

- **Manual per-city Live toggle.** The system continuously evaluates the multi-city paper-trade
  ledger and FRONTS ranked winners; nothing trades until the operator flips that city's Live
  switch in the /trading input table. Promotion status is ADVISORY — the toggle is the
  authorization (operator sovereignty; do NOT gate the toggle on PROMOTED status).
- **Envelope: $5/day per city, max 2 enabled cities** — both SQL-enforced (CHECK + constraint
  trigger), mirroring the §9R $25-ceiling-in-SQL idiom of 0082.
- **Live entries = faithful TAKER replication** of the tested sim: buy the predicted bucket at
  the ask, at the tested arm hour, hold to resolution. No exits, no stop-loss (that is what the
  paper record measured).
- **Longitudinal MAKER-ENTRY PAPER TWIN** (no money, ever): for every sim placement, simulate a
  maker entry and track the differential taker-vs-maker over time.
- **Boundary unchanged:** Claude builds; operator funds/keys/toggles; TRADE_MODE ladder +
  preflight interlock + operator_guard stay in force; no migration apply / edge-fn deploy by
  Claude — staged DARK, operator executes.

Honest-measurement notes (carry into doc comments): Karachi is currently a point-estimate winner
of a 45-city race — selection effect is the null hypothesis; the LB ranking + day floors below
are the mitigation and the live toggle test is the real gate. The maker twin's fill detection is
a conservative LOWER BOUND (snapshots are event-driven). Live taker fills will drift from the
sim's locked ask — record actual fill price; the drift itself is a measured output.

## 1. Lane P — promotion engine (pure core)

`packages/core/src/sim/city-promotion.ts` + `packages/core/test/city-promotion.test.ts`.

Input (pure, no Date.now, asOf passed in):
```ts
export type CityPromotionInput = {
  asOf: string;                          // ISO
  cities: Array<{
    cityId: string; slug: string; icao: string; unit: 'C'|'F';
    bets: Array<{ won: boolean; ask: number; targetDate: string; armHour: number;
                  pnlUsd: number; stakeUsd: number }>;   // graded only
    prevStatus?: CityPromotionStatus;    // from the previous board, for DEMOTED hysteresis
  }>;
};
export type CityPromotionStatus = 'PROMOTED'|'WATCH'|'INSUFFICIENT'|'DEMOTED';
export type CityPromotionRow = {
  cityId: string; slug: string; icao: string;
  nBets: number; nDays: number; netPnlUsd: number;
  recommendedHour: number|null; watchConfidence: 'insufficient'|'provisional'|'sufficient';
  edge: number|null; edgeCiLo: number|null; edgeCiHi: number|null;  // recommended arm's bets
  status: CityPromotionStatus; reasons: string[];
};
export type CityPromotionBoard = { asOf: string; rows: CityPromotionRow[] };
export function buildCityPromotionBoard(input: CityPromotionInput): CityPromotionBoard;
```

Frozen criteria:
- Reuse `recommendEntryHour` (entry-watch) per city over its arms, and `armEdgeStats` for the
  recommended arm's bets. `edge/edgeCiLo/edgeCiHi` = the paired-gap `won − ask` stats of the
  RECOMMENDED arm only (that is the arm a live test would run).
- Eligibility floors: `nBets ≥ 20` (city total, graded) AND `nDays ≥ 10` (distinct targetDate)
  AND entry-watch confidence `sufficient`.
- `PROMOTED` = eligible AND recommended-arm `edgeCiLo > 0`.
- `DEMOTED` = `prevStatus === 'PROMOTED'` AND (`edgeCiLo < 0` OR (point edge < 0 AND nBets ≥ 20)).
  DEMOTED is sticky-informative: it ranks below WATCH and carries the reason.
- `WATCH` = not promoted, point edge > 0 (any n). `INSUFFICIENT` = the rest.
- Rank: PROMOTED first (by edgeCiLo desc), then WATCH (edgeCiLo desc, nulls last), then
  INSUFFICIENT, then DEMOTED. Deterministic tiebreak: slug asc.
- Every status carries human-readable `reasons` (e.g. "nDays 6 < 10").

## 2. Lane D — migration `0085_city_live.sql` (staged DARK) + edge-fn extension

Follow the 0082 staged-DARK template exactly (RLS operator_read + service_role, OBJECT envelopes
— never top-level arrays (0081 tripwire), `if not exists` everywhere, seeds inert).

Tables:
- `city_live_arms`: `city_id uuid PK references cities`, `enabled bool not null default false`,
  `stake_usd numeric(10,2) not null default 5 CHECK (stake_usd > 0 AND stake_usd <= 5)`,
  `entry_hour_override smallint CHECK (entry_hour_override between 0 and 23)`,
  `promoted_status text`, `enabled_at timestamptz`, `updated_at timestamptz not null default now()`.
  Constraint trigger `city_live_arms_max2`: RAISE if >2 rows enabled.
- `city_live_audit` (append-only): `id bigserial PK`, `at timestamptz default now()`,
  `city_id uuid`, `field text`, `old_value text`, `new_value text`.
- `city_maker_twin`: `id uuid PK default gen_random_uuid()`, `city_id`, `target_date date`,
  `arm_hour smallint`, `limit_price numeric(8,6)`, `filled bool not null default false`,
  `fill_detected_at timestamptz`, `stake_usd numeric(10,2)`, `shares numeric(14,4)`,
  `status text not null default 'pending' CHECK (status in ('pending','won','lost','unfilled'))`,
  `pnl_usd numeric(10,4)`, `created_at timestamptz default now()`, `graded_at timestamptz`,
  UNIQUE `(city_id, target_date, arm_hour)`.
- `city_promotion_board`: `id bigserial PK`, `captured_at timestamptz default now()`, `view jsonb`.
- `ALTER TABLE live_orders ADD COLUMN IF NOT EXISTS strategy text not null default 'maker-exit'`
  (city lane writes `'city-taker'`). 0082 IS applied on prod (verified 07-06: mode='off',
  183 rows) — the ALTER is safe and the new objects go dark.

RPCs:
- `city_live_arms_get()` → `{rows:[…]}` — operator_guard + authenticated + service_role.
- `city_live_arm_set(p_city_id uuid, p_enabled bool, p_stake_usd numeric, p_entry_hour smallint default null)`
  → `{row}` — SECURITY DEFINER, operator_guard; writes audit rows per changed field; the max-2
  trigger provides the hard stop (surface its RAISE text verbatim).
- `city_live_runner_inputs()` → `{rows:[{cityId,slug,icao,tz,unit,enabled,stakeUsd,entryHour,…}]}`
  — service_role only. `entryHour` = override if set, else the latest board's recommendedHour
  for that city (null if none → runner skips city).
- `city_sim_bets_for_promotion()` → `{rows}` (graded city_paper_bets, fields per Lane P input)
  — service_role only.
- `city_promotion_record(p_view jsonb)` → bigint — service_role; prunes rows older than 90d.
- `dash_city_live()` → OBJECT `{arms, board, twin}` — operator_guard + authenticated. `board` =
  latest `city_promotion_board.view`; `twin` = per-city taker-vs-maker aggregate
  (nPlacements, twinFilledFrac, takerPnlUsd, makerTwinPnlUsd) joining city_paper_bets ⋈ city_maker_twin.
- **Strategy-aware preflight:** `trade_live_preflight(p_strategy text)` overload (keep the no-arg
  fn delegating to `'maker-exit'`). `'city-taker'` branch checks: mode='live', active_until ≥
  today, daily-loss kill not tripped (reuse `trade_today_realized_loss()`), ≥1 enabled city arm,
  every enabled arm stake ≤ 5, ≤ 2 enabled. It does NOT check bot_gate_snapshot and does NOT
  check promotion status (advisory by operator decision).

Edge fn `supabase/functions/city-paper-trade/handler.ts` extension (deploy operator-gated):
1. After PLACE: for each placement with an in-lock-hour snapshot, insert a `city_maker_twin`
   pending row with `limit_price = best_bid` from the SAME lock snapshot (skip if no bid;
   idempotent on the unique key).
2. Fill detection each tick: pending twins where any later `market_snapshots` row for the bucket
   has `best_ask <= limit_price` → `filled`, `fill_detected_at`. (Conservative lower bound.)
3. After GRADE: grade filled twins with the same settlement facts (maker fee = $0; won ⇒
   `pnl = shares*(1-limit) `, lost ⇒ `-stake`); unfilled twins at resolution → `status='unfilled'`, pnl 0.
4. Compute `buildCityPromotionBoard` from `city_sim_bets_for_promotion()` (+ previous board for
   prevStatus) and `city_promotion_record` it. Board write is best-effort (failure must not
   break placing/grading).

## 3. Lane X — daemon city lane

- New pure module `scripts/lib/city-live-decide.ts`: `decideCityTick({now, mode, arms, placeInputs,
  openIntentKeys, preflightOk})` → city intents. In-hour rule mirrors the sim (place only within
  the arm hour, city-local tz via the same tz-hour idiom the sim uses; once per city/day).
  Intent key = existing `orderIntentKey({marketId, side:'BUY', purpose:'entry', tradeDate})`;
  ledger idempotency via the existing partial-unique index. Sizing: `shares = stakeUsd/ask`
  (venue min-size respected), order_type FAK, `strategy='city-taker'`.
- Data path: `city_live_runner_inputs()` for enabled arms; `city_sim_place_inputs(...)` (existing
  RPC) for the day's predicted bucket/tokenId/ask — the SAME inputs the sim locks, so live
  faithfully mirrors paper.
- `scripts/trade-bot.ts` tick(): run the city lane after the maker-exit lane. Same TRADE_MODE
  ladder; live posts additionally require `trade_live_preflight('city-taker')` ok. Defensive
  code-side re-checks: stake ≤ 5, ≤ 2 cities, once/day. Dry-run default logs dry_run ledger rows
  exactly like the maker-exit lane. No exit management; resolution bookkeeping = mark the ledger
  row's reason at resolution (reuse the existing resolution sweep idiom if present, else note).
- Tests colocated with the existing decide-spine tests (find `trade-bot-decide` tests and mirror).

## 4. Lane W — /trading input table + winners board

Follow the existing mutation idiom EXACTLY (recon §3): `/api/admin/trading/config` and
`/api/admin/trading/city-arm` POST routes → `apps/web/src/lib/api/routes.ts` handlers →
`requireOperator(deps)` → RPC (`trade_config_set` / `city_live_arm_set`) on the RLS anon client.
NO service key, NO server actions.

/trading page additions (glass idiom, graceful `not-applied` degradation for `dash_city_live`
via the `isUndefinedFunctionError` split):
1. **Config input table** — editable `trade_config` fields (mode off/dry-run/live, caps, stake,
   daily-loss kill, city_allowlist, active_until). Surface DB CHECK RAISE messages verbatim
   (the $25 ceiling etc). Current-value + input + single Save per row or form; audit list below
   (dash_trading already returns audit rows).
2. **Winners board ("front the winners")** — ranked `dash_city_live().board` rows with status
   badges, edgeCiLo/edge/nBets/nDays/recommendedHour, and the taker-vs-maker twin columns
   (twinFilledFrac, takerPnlUsd vs makerTwinPnlUsd).
3. **City Live arms table** — per-city toggle + stake input (≤$5) + entry-hour override;
   disable unchecked toggles once 2 are enabled; confirmation dialog on enabling ("arms $X/day
   of real capital when the daemon runs live"); audit trail.
Loader in loaders.ts (`getCityLive`), types per idiom; render + loader tests mirroring
`trading-loader.test.ts` / `trading-page.render.test.tsx`.

## 5. Integration, review, deploy gates

- Each lane: targeted tests + `pnpm typecheck` green in its worktree, commit locally, report
  SHA + summary. Orchestrator merges, runs the FULL suite, lens-reviews, then commits to main.
- Deploys (ALL operator-gated, in order): ① apply 0085 → ② redeploy `city-paper-trade` edge fn →
  ③ Vercel auto-deploys web on push (page degrades gracefully before ①). Live activation
  sequence (operator, later): toggle a city on /trading → daemon runs with TRADE_MODE=live and
  `trade_live_preflight('city-taker')` must pass. Nothing in this build arms by itself.
