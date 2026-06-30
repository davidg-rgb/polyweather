# OPENING-CONVERGENCE — Build Handoff

> **↳ 2026-06-30 — TUNED ON 708 EVENTS → KILL at executable spread (see `CONVERGENCE-TUNING.md`).** The bracket
> thesis was tuned on the price-history archive joined to the bot's real `house_gaussian` seed (708 events, the
> live n≈2 was un-gradeable). No entry/exit threshold set clears the frozen §9R-E gate out-of-sample: the
> convergence price-path edge is REAL (+8.2% frictionless) but the **taker round-trip spread eats it** (breakeven
> ×0.70 of the real spread) — a **maker edge, not a taker edge**. Two findings carried forward: a **maker-exit**
> variant is the one open lever (must beat the §12 adverse-selection wall), and the **calibrated `house_gaussian`
> out-selects `ensemble_raw`** for bracketing the winner (73.9% vs 52.8%). Rail stays DORMANT; live config unchanged.

> **Status: GREENLIT FOR BUILD (operator decision, 2026-06-27).** The first signal in twelve that did
> **not** die at its cheap gate. This handoff is the baseline requirements doc for next session: we open
> with the alignment questions (§9), then run the **`architect` skill** with this file as input to produce
> the build blueprint, then build. The deliverable is an **autonomous buy/sell bot** the operator connects
> a funded account to, starting small, aiming for **net profitability**, working the market with reliable
> **bracket orders**.

---

## 0. TL;DR for next session (read first)

1. **Don't start coding.** Open by answering the **§9 alignment questions** (target: 97% shared understanding of scope + risk + autonomy). Use `AskUserQuestion` for the top clusters.
2. Then invoke the **`architect` skill** with this doc as the baseline requirements → it produces `ARCHITECTURE-OPENING-CONVERGENCE.md` (file structure, component signatures, data flow, phases, verification checklist).
3. Then build per the blueprint, paper-first.
4. **Boundary (non-negotiable, §8):** Claude builds the software; the **operator** connects/funds the account, holds the signing key, and authorizes runs. Claude never places a trade, never enters/handles credentials, never surfaces the key.

---

## 1. The decision (2026-06-27)

The project verdict has been "market efficient eleven ways, trading thesis CLOSED, rail DORMANT" since the
2026-06-15 pivot (`FINDINGS.md`). **This reopens the trading rail for ONE scoped, tested lever — opening
convergence — and nothing else.** The other eleven signals stay dead. This is not a reversal of the
efficiency findings; it is the single exception that earned a real test by surviving its cheap kill gate.

**Docs to update next session** once the architecture is set (so the project record stays coherent):
project `CLAUDE.md` header, `FINDINGS.md` (add the live-candidate row), `BUILD-STATE.md` active phase.
A pointer is already in `BUILD-STATE.md` so session-startup surfaces this.

---

## 2. The thesis

A freshly-listed daily-weather market opens **flat** — every °C bucket ~10–12% — because the book is
uninformed and near-empty at listing ("first light"). Over its life it **converges** to a peaked
distribution (mode ~30–40%) as forecasts arrive and the day nears. The play: **buy the buckets our
forecast says are the center, while they're cheap at the flat open, and sell them back into the
convergence** — capturing the re-rating, **not** needing to hit the exact temperature (you exit on a
bracket before resolution). Start small, prove net profit after fees + slippage at executable depth, then
scale.

Why it might be real where the other 11 weren't: the edge lives **specifically in the flat-open window**,
where the market is *not yet efficient*. By lead 1–2 the market has converged enough that KILL-GATE 2
already proved it efficient vs our forecast — so the window is narrow and time-critical, which is exactly
why no prior test caught it.

---

## 3. What we measured this session — the cheap gate (evidence)

Probe: **`scripts/research/opening-convergence-probe.ts`** (read-only, keyless, places nothing; reuses the
`gamma`/`clob` parsers + the `cross-venue-verify` true-book-walk pattern). Re-runnable:
`pnpm tsx scripts/research/opening-convergence-probe.ts --live 4 --hist 5`.

**Data accuracy (operator's explicit concern) — RESOLVED, it was a front-end artifact.**
The "every loser reads 0 throughout" is the chart's **post-resolution collapse** (losers snap to 0 at
settlement), not the data. CLOB `/prices-history` returns a real declining series for *every* bucket
(50+/60 points >1% on losers). E.g. manila 30°C *loser*: open 20% → mid-life peak **63%** → 0% final.
**We can measure the correct data.**

**Convergence — real, and it supports the "sell back even if wrong" idea.**
Winners open ~18–25% → run to 100%. Marks-based buy-open→pre-resolution sell-back gain: **median 79pp**
(n=5 resolved markets). Crucially, **losers near the mode also spiked sellably** (manila 30°C 20%→63%,
qingdao 31°C 17%→46%) — you don't strictly need the winner; center buckets re-rate up as the distribution
sharpens.

**Wall 1 (capacity) — did NOT kill it (the surprise).**
Expected single-digit mirage depth (like cross-venue/complete-set). Instead, near-dated markets carry real
depth: buyable within +10% of best ask — amsterdam 31°C **$309**, chengdu 29°C **$302**, chengdu 30°C
$135. These are $7k–28k/24h markets. **No instant capacity-wall KILL.**

**The decisive unmeasured number.** That depth is at **lead 1–2 in a liquid, already-partly-converged
state** (peak mids 24–28%) — *not* the flat 10–12% open the thesis targets. At the snapshot moment there
were **no brand-new flat-open listings** (even the freshest had peak ~24%). The flat-open window is brief
and gone once volume arrives. **Flat-open depth + net-of-costs edge can only be measured by capturing
markets AT listing** → the forward harness, which the bot's capture layer provides.

**Two unhandled risks the build must address:** (1) **survivorship** — at open the top-3 buckets sit within
~1pp (manila 30/31/32°C all ~20–21%); picking the riser leans on our forecast at our worst horizon.
(2) **exit timing** — every loser ends at 0; the gain only exists if you exit mid-life. Brackets + a hard
time-stop before resolution are mandatory.

---

## 4. The vision (operator's words, 2026-06-27)

> "Autonomous buying — set the system so I can connect an account to it and the bot handles the buys and
> sells for me to fully test this out. Start small scale and aim for net profitability, set reliable
> sell/buy brackets and systematically work the market."

Concretely: a bot that (a) captures freshly-listed markets at open, (b) decides entries from our forecast
vs the flat book, (c) places + manages **bracketed** buy/sell orders autonomously against a connected,
funded account, (d) is capped small and instrumented for a clean net-profit read, (e) scales only if it
proves +EV.

---

## 5. Functional scope the architect must design

- **A · Capture** — snapshot freshly-listed weather markets *at/near listing*: full bucket distribution +
  **true CLOB depth** (not the vol proxy) + our forecast distribution, timestamped, into a new table.
  Forward, on a cron (capture can be keyless Supabase edge/cron — no signing). Seed logic exists in the
  probe.
- **B · Signal / entry** — flag flat-open markets (peak mid ≤ threshold, within N hours of listing); select
  our-forecast-center buckets priced below our model prob by a margin; per-bucket sizing; **maker-vs-taker
  entry discipline** (maker = cheaper + rebate but slower fill; the §C maker/taker fork matters here too).
- **C · Execution** — sign + place orders against the connected wallet; **bracket engine**
  (take-profit / stop-loss / time-stop); partial-fill handling; cancel/replace; **idempotency** (no
  double-fills on retry/restart); reconcile open orders on startup.
- **D · Risk controls (non-negotiable)** — per-position / per-market / daily exposure caps; **daily-loss
  kill switch**; **paper / dry-run mode (default)**; **instant manual kill** (config flag the loop checks);
  full audit ledger of every intent + fill.
- **E · Monitoring** — dashboard (extend the `(dash)` surface — a `/bot` page, or fold into `/efficiency`):
  live positions, fills, realized + unrealized PnL, net-of-fees, per-market outcomes; alerts via the
  existing Slack alarm (reuse `whale-watch` plumbing).
- **F · Account connection** — a **dedicated, separately-funded** Polymarket wallet; signing key supplied
  via env/secret at runtime (`.env.local`, guard-secrets hook), **never** in chat/commits/logs; the signer
  reads it, Claude never sees it.
- **G · Validation gate** — paper → small-real → scale, with an explicit net-profit criterion (§9-E).

---

## 6. What exists to reuse (don't rebuild)

- **`packages/trading`** — the dormant trading machinery (the rail being reactivated).
- **`packages/io/src/polymarket-wallet.ts`** — wallet/signing scaffolding.
- **`packages/core/src/polymarket/clob.ts` + `gamma.ts`** — book + market parsers (`normalizeBook`,
  `parseGammaEvent`, `parsePricesHistory`); endpoints `gamma-api.polymarket.com`, `clob.polymarket.com`,
  tag `104596`. **Reachable from here (Sweden) — no 403** (the proxy 403 was a *cloud* run only).
- **The `bets` surface + `post.ts`** — existing order-posting path (currently dormant/unused in UI).
- **Forecast `house_gaussian` mode** — the entry signal's "center"; see `DATA.md` + the sim package.
- **Slack alarm** — `whale-watch` + the global Slack-pause gate (reuse for bot alerts + kill).
- **Supabase migration + pg_cron pattern** — for the capture layer (e.g. follow `0062`/`0065`).
- **`scripts/research/opening-convergence-probe.ts`** — the measurement spine; the capture layer
  generalizes it forward.
- **`cross-venue-verify.ts`** — the true-depth-walk + "gate wins on executable depth" pattern; the bot's
  fill model must inherit it (never trust the quoted price).

---

## 7. Where this is risky (foreground in the architecture)

1. **Real-money autonomy.** Bugs spend money. Mitigations: paper-default, hard caps, daily-loss kill,
   idempotency, dedicated tiny wallet, instant kill switch, audit ledger.
2. **The edge is unproven at the load-bearing state** (flat-open depth). The bot's first job is to *measure*
   it forward (paper) before risking capital — the build is also the experiment.
3. **Adverse selection on exit** (§12 of the wallet-recon work: resting cheap and getting picked off). The
   bracket logic and maker/taker choice must be designed against it.
4. **Where it runs.** Capture is keyless (edge/cron). **Execution holds a key and runs a bracket loop** —
   that wants a persistent signer process (local always-on machine, or a small VPS), not a stateless edge
   fn. This is an architecture decision (§9-D).
5. **Forecast dependence at our worst horizon** (lead 1–2 within-1° = 69% vs market 82%). The signal must
   be robust to being wrong on the exact bucket (hence center ± 1 + sell-into-convergence, not hold).

---

## 8. Boundaries & safety (NON-NEGOTIABLE)

- **Claude action boundary.** Claude **builds the software**. The **operator** connects + funds the account,
  holds the signing key, and authorizes runs. **Claude never:** places/cancels a live trade itself, enters
  or handles financial credentials, or surfaces/echoes/commits/logs the key. The bot the operator runs does
  the signing; the key lives in `.env.local` (guard-secrets hook), read at runtime only.
- **Dedicated wallet, small balance, separate from main funds** — limits blast radius.
- **Paper-first, dry-run default.** No real capital until the paper harness shows a net-profit read meeting
  §9-E. Real money starts at the §9-A floor.
- **Instant kill** the operator controls (config flag + Slack pause), checked every loop.
- **Reactivating the dormant rail is a scoped exception** — update `CLAUDE.md`/`FINDINGS.md`/`BUILD-STATE.md`
  to say so, so the record doesn't read as "trading reopened wholesale."

---

## 9. Alignment questions — answer at next-session open (target 97%)

Each has a **recommended default**; confirm or override. Cluster A–F. The first session-open action is to
walk these (top clusters via `AskUserQuestion`).

**A · Capital & risk envelope**
- Starting real bankroll (after paper)? *Default: **$100–200** in a dedicated wallet.*
- Max per position / per market / total concurrent exposure? *Default: **$10–25** / **$40** / **$100**.*
- Daily-loss kill-switch threshold? *Default: **−$30 or −25% of bankroll**, whichever first → halt + alert.*
- Paper-first duration before any real money? *Default: **≥2 weeks AND ≥40 captured markets**.*

**B · Entry**
- Trigger only in the flat-open window (peak mid ≤ threshold, within N hours of listing)? *Default: **yes**,
  peak mid ≤ **18%**, within **~6h** of listing — the edge is the uninformed window.*
- Which buckets? *Default: house_gaussian **mode ± 1** (3 buckets), only if the ask is below our model prob
  by ≥ a margin (e.g. model 30% vs ask ≤ 18%).*
- **Maker or taker entry?** *Default: **maker** (rest near mid — cheaper + rebate), with a taker fallback if
  unfilled within a window. (Real fork — affects fill rate vs cost.)*
- Hard max entry price? *Default: never buy above **20%**.*
- Universe? *Default: the **6–10 most-liquid cities** first (those with $7k+ vol24h); expand once proven.*

**C · Exit / brackets**
- Take-profit rule? *Default: sell when mark ≥ **entry + 15pp** OR ≥ our model prob, whichever first.*
- Stop-loss rule? *Default: sell when mark ≤ **entry − 8pp**.*
- Time-stop? *Default: **flatten everything by lead-0, local noon** — never hold into resolution (losers → 0).*
- Maker or taker exit? *Default: **taker** when a bracket fires (certainty of exit > the spread saved).*

**D · Execution & autonomy**
- Where does execution run? *Default: **local always-on Node process** for paper + small-real; move to a VPS
  before scaling. (Capture stays keyless edge/cron.)*
- Autonomy level? *Default: **fully autonomous within the caps**, but **human-approve the first ~10 real
  trades** (bot proposes → you one-click), then flip to full auto once it tracks paper.*
- Kill switch mechanism? *Default: a `bot_enabled` config flag checked every loop + Slack pause.*

**E · Validation gate (the net-profit bar)**
- Paper → real criterion? *Default: **net positive after fees + measured slippage over ≥40 markets, CI
  excluding 0** (the project's standard bar).*
- Real small → scale criterion? *Default: **+EV holds over ≥2 weeks live small-scale**.*

**F · Boundary confirmation**
- Confirm: **dedicated wallet**, **you fund it + hold the key** (`.env.local`, never in chat), **Claude
  never places a trade or touches the key** — the bot you run signs. Are you OK funding a separate small
  wallet for this? *Default assumption: **yes**.*

---

## 9R. Alignment — RESOLVED (2026-06-27, operator-confirmed)

These are the **locked build parameters** (chosen via AskUserQuestion at next-session open). They override
the §9 defaults wherever they differ. The `architect` skill consumes THESE, not the open defaults.

**A · Capital & risk** — Dedicated wallet **$100–200**. Caps: **$10–25/position**, **$40/market**, **$100
total concurrent**. Daily-loss kill at **−$30 or −25% of bankroll**, whichever first → halt + alert. Paper
duration before any real money: **≥2 weeks AND ≥40 captured markets**.

**B · Entry** — Trigger **only in the flat-open window**: peak bucket mid **≤ 18%** AND **within ~6h of
listing**. Buy **house_gaussian mode ± 1** (3 buckets), only where the ask is **below our model prob by a
margin** (e.g. model 30% vs ask ≤ 18%). **Hard max entry price 20%** (never buy above). Entry style:
**maker** (rest a limit near mid — cheaper + maker rebate) with a **taker fallback if unfilled within a
window**. Universe: the **6–10 most-liquid cities** ($7k+ vol24h) first; expand once proven. *(Adverse-
selection caveat from §12 wallet-recon: resting cheap risks getting picked off — the bracket logic must be
designed against it; the rebate + lower entry is the net-edge margin.)*

**C · Exit / brackets** — Take-profit: sell when mark **≥ entry + 25pp OR ≥ our model prob**, whichever
first (wider — lets winners run toward model prob to capture more of the median 79pp convergence).
Stop-loss: sell when mark **≤ entry − 12pp**. Time-stop: **flatten everything by lead-0 local noon** — never
hold into resolution (losers → 0). Exit style: **taker when a bracket fires** (certainty of exit > the
spread saved).

**D · Execution & autonomy** — Runs on a **small VPS from day one** (always-on persistent signer process,
survives the operator's machine sleeping — chosen over local always-on for uptime on the bracket loop).
**Capture stays keyless** (Supabase edge/cron — no signing). Autonomy: **fully autonomous within the caps**,
but **human-approve the first ~10 real trades** (bot proposes → operator one-click), then flip to full auto
once it tracks paper. Kill switch: a **`bot_enabled` config flag checked every loop** + the existing Slack
pause gate.

**E · Validation gate** — Paper → real: **net positive after fees + measured slippage over ≥40 markets, CI
excluding 0** (the project's standard bar). Real small → scale: **+EV holds over ≥2 weeks live small-scale**.

**F · Boundary** — **CONFIRMED.** Dedicated, separately-funded Polymarket wallet. **Operator funds it and
holds the signing key** in `.env.local` (guard-secrets hook; never in chat/commits/logs). **Claude never
places/cancels a live trade, never enters/handles credentials, never surfaces/echoes/commits/logs the key.**
The bot the operator runs does the signing; the key is read at runtime only. **Build BOTH the paper harness
AND the execution layer now** (bracket engine + signer interface); the operator connects the funded wallet
when the paper harness clears the §9-E gate.

---

## 10. Session log

- **2026-06-27** — Thesis surfaced by operator from live Polymarket observation (Paris Jun 28 market, all
  buckets ~10–12% at 6:10 AM). Ran the cheap gate (`opening-convergence-probe.ts`): data accuracy confirmed,
  convergence real (median 79pp marks sell-back), Wall-1 capacity did **not** kill (lead-1–2 depth $100–320),
  flat-open depth still unmeasured. **Operator greenlit the build** with autonomous buy/sell + bracket
  scope. Handoff written. **Next session: alignment questions → `architect` skill → build.**
- **2026-06-27 (next session, continued)** — Walked the §9 alignment questions via AskUserQuestion (two
  rounds, 8 decisions). Operator confirmed: $100–200 envelope, **VPS from day one**, ≥2wk/≥40-mkt CI-excl-0
  gate, dedicated funded wallet (build both layers now), flat-open entry (peak≤18%/≤6h/mode±1), maker+taker-
  fallback entry, **wider brackets (TP +25pp/model, SL −12pp)**, flatten-by-noon taker exit. Locked into
  §9R. **Next: run the `architect` skill with this doc → `ARCHITECTURE-OPENING-CONVERGENCE.md`, then build
  paper-first.**
- Uncommitted artifacts on `main`: `scripts/research/opening-convergence-probe.ts`, this handoff, the
  BUILD-STATE pointer, the BUILD-STATE deploy-freshness fixes from earlier today.
