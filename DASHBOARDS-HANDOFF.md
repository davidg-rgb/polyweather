# DASHBOARDS-HANDOFF — build `/rewards` + `/whaletracker` live pages

> **Authored 2026-06-24.** Execution package for the next session (fresh context). Two new dashboard pages
> for the prod Vercel site (`weather-edge-two.vercel.app`), so the live tests are visually followable.
> Read first: this doc, then the EXACT analog to copy — `apps/web/src/app/(dash)/replica/page.tsx` (+ its
> loader `apps/web/src/lib/loaders.ts`). Data models: `supabase/migrations/0055_whale_watch.sql` (whales)
> and `0057_market_rewards_snapshot.sql` (rewards). Branch context: `REWARD-FARMING-HANDOFF.md` §9–§11.

---

## 0. State at hand-off (where things are)

- **Branch:** `feat/reward-farming` (off `feat/whale-watch` HEAD). NOT merged to `main`. The web app is
  unchanged by the recent REC-8/9 work, so **prod Vercel currently shows nothing of rewards or whales**.
- **Prod = `main` → `weather-edge-two.vercel.app`** (Vercel auto-deploys `main`). Live pages today:
  `/` `/amsterdam` `/replica` `/calibration` `/city/[slug]` `/events` `/system` `/admin` `/bets` (all behind login).
- **Both data feeds are LIVE on prod and accumulating** (nothing to build on the ingest side):
  - `public.whale_trades` — every ≥$100k Polymarket taker fill, recorded by the `whale-watch` Edge tick
    (cron `* * * * *`, since ~2026-06-24). Columns + a `dash_whale_watch` RPC already exist (migration 0055).
  - `public.market_rewards` — funded-weather reward rate + near-mid book depth, by the `reward-snapshot`
    Edge tick (cron `*/20 * * * *`, since 2026-06-24; **deployed + verified** — REWARD-FARMING-HANDOFF §11).
- **Net-profit thread status (context, not a task):** the reward-farming lever leans NEGATIVE (advertised
  rates are under-paid caps; practitioners call passive farming "a bonus, not an engine"). The ~$59 REC-9
  probe + the wallet are **held until the operator raises it**. These dashboards are visibility, not capital.
- CLI is authed here via `npx --no-install supabase` (`--use-api`, `--project-ref lenysiqxihsmxljvyybt`);
  migrations are applied on prod via the **Supabase MCP `apply_migration`** (this project's established path —
  remote history is timestamp-versioned, NOT `db push`). Prod migrations applied: through 0053, + 0055, + 0057
  (0054 + 0056 are unapplied separate features — leave them).

---

## 1. The shared build pattern (copy `/replica`)

Every dashboard page is the same shape — follow `apps/web/src/app/(dash)/replica/page.tsx`:
- **Page:** a server component, `export const dynamic = 'force-dynamic'`, `const db = await serverDb()`
  (`apps/web/src/lib/supabase.ts`), then a loader call. Render with the shared CSS classes (`ams-dash`,
  `strip`, `tile`, `panel`, `chip`, `tbl-scroll`, `num`, `mono`, `muted`, `pos`/`neg`).
- **Loader:** add a function to `apps/web/src/lib/loaders.ts` that calls the `dash_*` RPC via `db.rpc(...)`
  and shapes a typed view (mirror `getReplicaSim`).
- **Formatting:** `apps/web/src/lib/format.ts` — `fmtUsd`, `fmtPct`, `fmtDate`, `fmtAgo`, `fmtProb`, `num`.
- **Charts:** `apps/web/src/components/EquityChart.tsx` is a line/area chart (SVG, no deps) — reuse for time
  series; for the whale daily bars, add a tiny `BarChart.tsx` in the same dependency-free SVG idiom (don't
  pull a chart lib — match the repo).
- **Nav:** add entries to the `NAV` array in `apps/web/src/app/(dash)/layout.tsx`:
  `['/rewards', 'rewards']` and `['/whaletracker', 'whales']`.
- **Data RPCs:** new `dash_*` functions in ONE migration `0058_reward_and_whale_dashboards.sql`,
  `security definer`, `perform public.operator_guard();` at the top, granted `to authenticated, service_role`.

### Migration / deploy mechanics (do these exactly)
1. Write `supabase/migrations/0058_reward_and_whale_dashboards.sql` (the two read RPCs below).
2. Append `'0058_reward_and_whale_dashboards.sql',` to the names array in `supabase/tests/migrations.test.ts`
   (~line 186, after 0057). **No cron change** → the cron-count test stays **18** (don't touch it).
3. `pnpm typecheck && pnpm test` green.
4. Apply on prod: Supabase MCP `apply_migration(project_id='lenysiqxihsmxljvyybt', name='0058_reward_and_whale_dashboards', query=<sql>)`.
5. To make the PAGES live on Vercel: merge `feat/reward-farming` → `main` (or cherry-pick the web files onto a
   fresh PR branch off `main`). Vercel auto-deploys `main`. (Merging also carries whale-watch + REC-8/9 — fine;
   the web app gains exactly these two pages, backend already live.)

### Three traps that WILL bite (from prior migrations)
- **0044 jsonb-array trap:** a `dash_*` RPC returning a collection MUST return a jsonb **OBJECT**
  (`jsonb_build_object('rows', coalesce(jsonb_agg(...), '[]'::jsonb), 'series', ...)`), NEVER a top-level
  jsonb array — the prod `supabasePort` misreads a bare array as a RETURNS TABLE row set and silently zeroes
  it. The loader reads `p[0].dash_xxx.rows`. (PGlite tests pass either way — this only breaks live.)
- **0054 overload trap:** do NOT re-`create or replace` an existing function with a DIFFERENT signature
  → "function is not unique". For whales, add a **new** `dash_whale_tracker(int)` rather than re-signaturing
  `dash_whale_watch(int)`.
- **RLS:** `market_rewards` is RLS-on with **no read policy** → it is ONLY readable through a
  `security definer` RPC (which bypasses RLS). `whale_trades` already grants `select` to authenticated under
  an `is_operator()` policy, but still read via the RPC for consistency + the operator_guard.

---

## 2. TASK A — `/rewards` live page (the reward-farming test, made visible)

**Goal:** let the operator watch the REC-8 Phase A feed without anyone re-running a script — especially the
**thin-book trend** (is competing maker capital thickening = window closing, or staying thin = window open).
That trend IS the deferred "Phase A re-run" read, surfaced live.

**Data RPC (`0058`, part 1) — `dash_market_rewards(p_days int default 7, p_top int default 20)`:**
- A jsonb OBJECT with:
  - `series`: per-capture aggregate over the last `p_days`, one row per `captured_at` (group by it):
    `{ capturedAt, nMarkets, totalPoolUsd: sum(daily_pool_usd), totalInBandUsd: sum(bid_depth_usd+ask_depth_usd) }`,
    ascending. This is the time series (pool vs competing capital).
  - `latest`: the most-recent capture's headline — `{ capturedAt, nMarkets, totalPoolUsd, totalInBandUsd }`.
  - `topMarkets`: from the latest capture, top `p_top` by `daily_pool_usd`:
    `{ slug, dailyPoolUsd, mid, bestBid, bestAsk, bidDepthUsd, askDepthUsd, maxSpreadCents }`.
- `security definer`, `perform operator_guard()`, grant to authenticated + service_role.

**Page (`apps/web/src/app/(dash)/rewards/page.tsx`) — visuals:**
1. **Headline tiles** (`strip`/`tile`): funded weather markets (latest `nMarkets`), total daily pool
   (`totalPoolUsd`), total in-band competing maker capital (`totalInBandUsd`), and an "implied universe gross
   yield" = pool/inBand (the thin-book paradox number).
2. **Time-series chart** (reuse `EquityChart`): two lines over `series` — total daily pool vs total in-band
   competing capital. The gap/trend is the story.
3. **Top-markets table:** the `topMarkets` rows (slug, pool $/day, mid, in-band bid/ask $).
4. **Verdict banner** (static, sourced from `REWARD-FARMING-HANDOFF.md`): "REC-8 first-pass = PASS-per-criterion
   but NOT actionable — advertised rates are likely under-paid caps; passive forecast-free farming is a thin
   bonus, not a profit engine. REC-9 probe ($59) + wallet held pending operator. This page tracks whether the
   competition window is opening or closing." Link the handoff doc.

**Verify:** page renders on prod after merge; tiles match `select count(*), round(sum(daily_pool_usd)),
round(sum(bid_depth_usd+ask_depth_usd)) from market_rewards where captured_at = (select max(captured_at) from market_rewards);`

---

## 3. TASK B — `/whaletracker` page (operator spec, build extensible)

**Operator ask (verbatim intent):** "show visuals of the past 10 days worth of bets made above $100k — link
to profile, link to bet, what the bet was, and the value." Plus: **"we will expand on the whaletracker"** →
build the RPC + loader + page so adding fields/filters later is trivial (param the window + min-USD; keep the
row shape rich).

**Data:** `public.whale_trades` (migration 0055, live). Per-fill columns already present:
`proxy_wallet, trader_name, title, outcome, side, size_shares, price, notional_usd, event_slug, market_slug,
link, traded_at, transaction_hash`. ⚠ Data only exists since whale-watch go-live (~2026-06-24), so "past 10
days" fills in over time — that's expected; show whatever's in the window.

**Data RPC (`0058`, part 2) — NEW `dash_whale_tracker(p_days int default 10, p_min_usd numeric default 0)`:**
- jsonb OBJECT with:
  - `bets`: rows where `traded_at >= now() - p_days*interval '1 day'` and `notional_usd >= p_min_usd`,
    ordered `traded_at desc` (cap ~500): `{ tradedAt, proxyWallet, trader: coalesce(nullif(trader_name,''), proxy_wallet),
    side, outcome, title, notionalUsd, price, sizeShares, link, txHash, eventSlug }`.
    - `proxyWallet` is REQUIRED here (it builds the profile link) — `dash_whale_watch` omits it, which is why
      this is a new function, not a reuse.
  - `daily`: per-UTC-day aggregate over the window: `{ date, count, totalUsd: sum(notional_usd) }`, ascending
    (the bar-chart series).
  - `meta`: `{ days, minUsd, count: total bets in window, totalUsd }`.
- `security definer`, `perform operator_guard()`, grant authenticated + service_role. (jsonb OBJECT — 0044 trap.)

**Page (`apps/web/src/app/(dash)/whaletracker/page.tsx`) — the four required fields + visuals:**
- **Link to profile:** `https://polymarket.com/profile/{proxyWallet}` (open in new tab; show `trader`).
- **Link to bet:** the `link` column (already resolved to `polymarket.com/event/{slug}`, polygonscan tx fallback).
- **What the bet was:** `title` (market question) + a `side outcome` chip (e.g. "BUY Yes").
- **The value:** `fmtUsd(notionalUsd)` headline + `sizeShares @ price (≈prob%)` subtext.
- **Visuals:**
  1. **Daily bar chart** (new `BarChart.tsx`, SVG): total whale $ per day over the window (+ count label).
     Title it "≥$100k Polymarket bets — last 10 days".
  2. **Headline tiles:** total whales in window, total notional, largest single bet, busiest day.
  3. **Ranked table** of individual bets — columns: time, trader (→ profile link), what (title + side/outcome),
     value ($notional + shares@price), and a "View bet ↗" link. Default order by time desc; make value-desc easy.
- **Default window = 10 days, min = $100,000** (the recorded floor). Param the page later for the expansion.

**Extensibility (the "we will expand" hook — leave these seams, don't build them yet):**
- The RPC already takes `p_days` + `p_min_usd` → trivial to add UI filters.
- Future: per-wallet rollups (repeat whales, net direction), market/category clustering, follow-up P&L once the
  bet's market resolves (join `whale_trades.condition_id` → resolution), a "biggest movers" view. Keep `bets`
  rows rich (already include `eventSlug`, `conditionId` is available in-table if needed) so these are additive.
- Optional future ingest expansion (NOT v1): backfill historical ≥$100k trades from the Polymarket data-api
  (`/trades?filterType=CASH&filterAmount=100000`, `_shared/polymarket-wallet.ts` `fetchTrades`) into
  `whale_trades` to pre-fill the 10-day window before go-live accumulation catches up.

**Verify:** page renders on prod; table rows match `select traded_at, proxy_wallet, title, side, outcome,
notional_usd, link from whale_trades where traded_at >= now() - interval '10 days' order by traded_at desc;`

---

## 4. Definition of done

- [ ] `0058_reward_and_whale_dashboards.sql` written (both RPCs, jsonb-object returns, operator_guard, grants);
      names array updated; `pnpm typecheck && pnpm test` green; migration applied on prod via MCP.
- [ ] `apps/web/src/app/(dash)/rewards/page.tsx` + loader + (reused) chart; nav entry added.
- [ ] `apps/web/src/app/(dash)/whaletracker/page.tsx` + loader + `BarChart.tsx`; nav entry added; shows the
      four required fields (profile link, bet link, what, value) + the daily-bars visual over the last 10 days.
- [ ] Merged to `main` → both pages live on `weather-edge-two.vercel.app` (verify behind login).
- [ ] Sanity: tiles/tables match the verification SQL above against prod data.
- Rail stays DORMANT throughout; these are read-only analytics pages. `packages/trading` not touched.
