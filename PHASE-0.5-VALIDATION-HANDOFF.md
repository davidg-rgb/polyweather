# Phase 0.5 — Validation-Phase Handoff (opening-convergence)

**Date:** 2026-06-28 · **Branch:** `feat/opening-convergence-phase0` (NOT merged to main) · **Prod ref:** `lenysiqxihsmxljvyybt`
**Status:** Phase 0 (keyless capture) + Phase 1 (pure core) are BUILT, TESTED, LIVE. We are now in the **checking/validation phase** — accruing forward capture data until the Phase-0.5 spike can render a GO/NO-GO. **No trading. No Phase 2 code until the spike says GO.**

This doc is self-contained — a fresh session can execute it with no prior context.

---

## TL;DR — the one main pending action
**Expand the CAPTURE universe from 10 → ~45 cities** (see §2). We're only *measuring* right now, and the 10-city limit is a leftover from the *trading* universe (cities chosen for liquidity, which is irrelevant when checking). Broader = more independent weather-days = a far better-powered spike verdict, for ~zero capital risk. The only real cost is a one-time IANA-tz fix per added city.

Everything else below is context, near-term verification, and the standing hard gate.

---

## 1. What was done this session (context — already committed + deployed)
All on branch `feat/opening-convergence-phase0`, all keyless, all live on prod:

- **`19ef65d`** — Phase 0/1 5-round review fixes (GATE_MIN_CITIES 4→6, seedFreshnessMin, lead-aware bot_seed_quality, {rows} RPC wrap, config clamps). Deploy-propagated (`b77be9e`): re-applied changed 0066 objects + `minCities=6` + `gateStaleMin=180`, redeployed `opening-capture`.
- **`aa7db0f`** — **Fresh Phase-0.5 review (the big one).** A 2-agent adversarial review + live verification found the capture was **structurally missing the flat open**:
  - **CAP-1 (CRITICAL, FIXED+DEPLOYED):** §9R ladders list in a daily batch ~2.8 lead-days ahead with sub-$7k volume, so the `lead≤2 ∧ vol≥$7k` filter only admitted them ~15–35h post-listing — long after the ≤1h flat-open window. **Live proof:** 1454 rows, min `hours_since_listing` 35.7h, min `peak_mid` 0.285, ZERO `is_flat_open`. **Fix:** a fresh-listing bypass (`openingUniverseReason` in `pure.ts`, `FRESH_LISTING_MAX_H=3`) — any scoped event listed within 3h is captured regardless of lead/vol so the OPEN is always sampled.
  - **CAP-3 (HIGH, FIXED+DEPLOYED):** `capture_deadman` was blind to CAP-1 (its seeded-fraction check is gated on `is_flat_open` rows, of which there were 0). Added a "flat-open window never sampled" alarm (warmup-gated, `bot.captureFlatOpenWarmupDays` default 3).
  - **F1/F2/F4 (FIXED):** spike would `RangeError` on a large panel (the decisive gate crashing) → reduce-pass; UTC day-bucket; `center_ask_above_cap` vs `below_depth_floor` reason.
- **`a16b4f9`** — **CAP-2 + both-sides logging.**
  - **CAP-2 (DONE in code):** dropped the `vol < minVol24hUsd` gate from `selectEntries`. A "be-first" thesis can't gate entry on volume — the flat open is low-vol by construction. Liquidity is now the executable **depth floor** ($50, walked from the live book) + the 20% price cap. `bot.minVol24hUsd` stays only the *capture liquid-trajectory* bound.
  - **Both-sides depth:** `walkBucketDepth` now walks the BID side too (`execBid` + `sellbackDepthUsd`, mirror of the +10% ask band) so the full round-trip ("buy at open, sell into convergence") P&L is reconstructable. Added to `OpeningBucket` (core), the capture row, and the spike (new `exitDep` report column). `opening-capture` is at **version 6**.

Suite **1617 green**, typecheck clean throughout. The spike artifact (`scripts/research/opening-spike.ts`) runs live and correctly returns `INSUFFICIENT_DATA` today.

---

## 2. PENDING ACTION — expand the capture universe to ~45 cities

**Why:** pure checking/validation — broader is strictly better (more independent weather-days → a better-powered spike, and it attacks the degrees-of-freedom wall that overfit the REC-1 selector). Trading stays capped by the $100–200 bankroll/selection regardless (≈5 concurrent at $20), so this is **check-many-select-few** — exactly the thesis. Capture is keyless → ~zero capital risk.

**The numbers (verified this session):** Polymarket lists daily-highest-temp markets for **49 cities**; we already have calibrated forecasts for **45** of them; but only **10 have a real DST-aware IANA tz** — the other 35 carry placeholder `Etc/GMT±N` zones and the capture **fail-closes** on non-IANA tz (the C2/C2b guard). So the binding constraint is the tz, NOT forecasts.

### Step 1 — identify the fix candidates (authoritative, run live)
```sql
-- cities Polymarket lists ∩ we have calibration for ∩ tz is a placeholder (need the IANA fix)
select c.slug, c.tz, round(c.lat::numeric,3) lat, round(c.lon::numeric,3) lon
from public.cities c
join public.city_stations cs on cs.city_id=c.id and cs.valid_to is null
where exists (select 1 from public.model_stats ms where ms.icao=cs.icao)
  and (c.tz like 'Etc/%' or c.tz not like '%/%')
order by c.slug;
```

### Step 2 — set the correct IANA zone per city (the load-bearing, get-it-right part)
A wrong zone → wrong local-noon time-stop later. Pre-vetted mapping for the Polymarket expansion candidates (apply ONLY to slugs that exist in our `cities` table; verify each against the lat/lon from Step 1). Non-DST IANA zones (e.g. `Asia/Shanghai`) are fine — `isDstAwareIana` only rejects `Etc/*`, and the current 10 already include non-DST zones:

```sql
update public.cities set tz = case slug
  when 'ankara'        then 'Europe/Istanbul'
  when 'atlanta'       then 'America/New_York'
  when 'austin'        then 'America/Chicago'
  when 'buenos-aires'  then 'America/Argentina/Buenos_Aires'
  when 'busan'         then 'Asia/Seoul'
  when 'cape-town'     then 'Africa/Johannesburg'
  when 'chicago'       then 'America/Chicago'
  when 'chongqing'     then 'Asia/Shanghai'
  when 'dallas'        then 'America/Chicago'
  when 'denver'        then 'America/Denver'
  when 'helsinki'      then 'Europe/Helsinki'
  when 'hong-kong'     then 'Asia/Hong_Kong'
  when 'houston'       then 'America/Chicago'
  when 'istanbul'      then 'Europe/Istanbul'
  when 'jeddah'        then 'Asia/Riyadh'
  when 'karachi'       then 'Asia/Karachi'
  when 'london'        then 'Europe/London'
  when 'los-angeles'   then 'America/Los_Angeles'
  when 'lucknow'       then 'Asia/Kolkata'
  when 'mexico-city'   then 'America/Mexico_City'
  when 'miami'         then 'America/New_York'
  when 'milan'         then 'Europe/Rome'
  when 'moscow'        then 'Europe/Moscow'
  when 'munich'        then 'Europe/Berlin'
  when 'nyc'           then 'America/New_York'
  when 'panama-city'   then 'America/Panama'
  when 'san-francisco' then 'America/Los_Angeles'
  when 'sao-paulo'     then 'America/Sao_Paulo'
  when 'seattle'       then 'America/Los_Angeles'
  when 'seoul'         then 'Asia/Seoul'
  when 'shenzhen'      then 'Asia/Shanghai'
  when 'singapore'     then 'Asia/Singapore'
  when 'taipei'        then 'Asia/Taipei'
  when 'tel-aviv'      then 'Asia/Jerusalem'
  when 'tokyo'         then 'Asia/Tokyo'
  when 'toronto'       then 'America/Toronto'
  when 'warsaw'        then 'Europe/Warsaw'
  when 'wellington'    then 'Pacific/Auckland'
  when 'wuhan'         then 'Asia/Shanghai'
  else tz end
where slug in (/* only the slugs returned by Step 1 */);
```
(The 4 Polymarket cities NOT in our 45 — identify via the count diff — would need `discover-markets` + calibration first. Optional, later.)

### Step 3 — widen the capture city list (PROD CONFIG ONLY — no redeploy needed)
`bot.cities` is read live from `config` every tick, so this takes effect on the next `*/2` tick with **no redeploy**:
```sql
update public.config set value =
  'amsterdam,chengdu,manila,qingdao,madrid,guangzhou,kuala-lumpur,beijing,shanghai,paris,'
  || '<append the newly-IANA-fixed slugs here, comma-separated>'
where key = 'bot.cities';
```
**Intentional divergence:** leave `BOT_DEFAULTS.cities` / the 0066 mirror at the canonical **10-city TRADE set**. Prod config is the **wide CHECK set** (~45). They legitimately differ (check-wide, trade-narrow) — do NOT "sync" them, and note this in BUILD-STATE so the override isn't seen as drift. (A 0066 re-apply won't clobber it — `on conflict do nothing`.)

### Step 4 — MEASURE, then optimize only if needed
After a few ticks (and especially after the next ~04:00 UTC daily batch — the seed burst):
```sql
-- per-tick health: how many events, how many seeded, did the open get sampled
select date_trunc('minute', captured_at) tick, count(*) events,
       count(*) filter (where house_seeded) seeded,
       count(*) filter (where is_flat_open) flat_open
from public.opening_captures
where captured_at > now() - interval '30 min'
group by 1 order by 1 desc;
```
Check the `opening-capture` edge logs for `time_budget` seed-skips. The `seedFreshnessMin` throttle (180 min) means the burst should be a ~2–3-tick catch-up (≈6 min) — well inside the 1h window — so config-only is likely enough. **Only if** the burst saturates (seeds consistently dropping): bump `EVENT_CONCURRENCY` (handler.ts, currently `4` → `8`) and/or `SEED_TIME_BUDGET_MS`, then redeploy:
`npx --no-install supabase functions deploy opening-capture --use-api --project-ref lenysiqxihsmxljvyybt`
(There is a Supabase edge wall-clock ceiling; beyond some city count the single-fn-per-tick model would need sharding. ~45 should be fine.)

**DoD:** ≥~40 cities in `bot.cities`; the next daily batch produces `is_flat_open` rows across the new cities; no sustained `time_budget` seed-drops on the open tick.

**Discipline (carry into the eventual selection analysis):** more cities = more multiple-comparisons / look-elsewhere risk. The cure is in the *analysis*, not the collection — pre-register the selection rule, validate strictly out-of-sample on *independent* weather-days, correct for the number of cities tested. **Log everything now, fit nothing yet.** Favor climatic diversity when weighting (the current 10 are clustered — half Chinese cities that co-move; US + Southern-Hemisphere adds genuinely independent days).

---

## 3. Near-term verification (do this at/after the next ~04:00 UTC = ~06:00 CEST daily batch)
The fresh-listing bypass is deployed but hasn't yet caught a real *open* (markets list once/day ~04:00 UTC). Confirm it works end-to-end:
```sql
select city, target_date, round(min(hours_since_listing)::numeric,2) youngest_h,
       round(min(peak_mid)::numeric,3) min_peak,
       bool_or(is_flat_open) ever_flat
from public.opening_captures
where captured_at > now() - interval '12 hours'
group by city, target_date order by youngest_h;
```
**Expect:** at least some rows with `youngest_h ≤ 1` and `is_flat_open = true` (the bypass caught a market in its first hour). **This is the first real data point on whether the opens are even flat** — read `min_peak` at the open: if it's already ≫ 0.18, the thesis premise (markets open flat ~10–12%/bucket) is weak and the spike will likely NO-GO honestly. Also eyeball the new `exitDep` vs `ctrDepth` (buy vs sell depth at the open) via `pnpm tsx scripts/research/opening-spike.ts --days 2`.

---

## 4. THE STANDING HARD GATE (unchanged — do NOT skip)
After **≥1 week** of capture: `pnpm tsx scripts/research/opening-spike.ts --days 8` → **GO/NO-GO**.
- GO iff ≥ `spikeGoFrac` (0.5) of ≥1-week seeded events are still-flat-open with cheap **executable** center depth at first house_gaussian, AND seed coverage ≥ 0.5.
- NO-GO ⇒ KILL the lever cheaply HERE; update `FINDINGS.md` (signal #12). **Do NOT build Phase 2+ before a GO.** A false-GO costs build effort; the §9R-E net-profit gate (≥40 paper markets, clustered CI, zero-skill MC) remains the capital backstop.

---

## 5. The thesis frame (so the next session reasons correctly)
- **It's a LATENCY bet, not a forecast-skill bet.** R&D already showed our forecast doesn't beat the market (day-before market efficient vs our forecast; KILL-GATE 2). This lever only works if **the market is slow to price public forecast info in the first hour of a fresh listing** — which cuts against the broader finding that the market is fast/efficient everywhere else (eleven dead signals). The open is the one untested regime (efficiency hasn't had *time* to engage), which is why it earned a test — but the prior is against it.
- **The exit is the unmodeled half.** "Sell into the convergence" needs bid-side liquidity at exit. If it's thin, you hold to resolution = the directional forecast bet R&D says we lose. That's why we now log `execBid`/`sellbackDepthUsd` every tick — the Phase-3 paper backtest must model the exit from the real per-tick bid walk.
- **"Be first" only pays if you're actually first.** The book is already at peak ~0.28 by 15h; the flat window might be minutes, and a `*/2` poll can't catch a 90-second window. Whether the window is 1h or 90s is make-or-break and unknown until §3.

---

## 6. Minor open threads (noted, low priority)
- **F3** (LOW, dormant): the spike's coverage denominator excludes null-eventId captures (126 old junk rows today). Surface a caveat if that share grows.
- **F5** (intentional): the spike's `seededCoverage ≥ 0.5` floor is stricter than the bare §6.13c DoD — a deliberate TEST-1 addition to close the thin-minority false-GO. Leave it.
- **CAP-4** (DONE): the §16-D `created_at_gamma ≈ first-seen` assumption was false (markets list at lead ~2.8); amended in `ARCHITECTURE-OPENING-CONVERGENCE.md` §6.10-step-2 + §16-D.
- The **4 Polymarket cities not in our forecast set** (49−45): discover + calibrate before they can be checked. Optional.

---

## Boundary (NON-NEGOTIABLE)
Claude builds the software (keyless capture, analysis); the operator funds the dedicated wallet + holds the signing key (`.env.local`, never in chat); Claude never places a trade or touches credentials. Everything in this handoff is keyless/measurement — no capital until a frozen net-profit gate PASSes.
