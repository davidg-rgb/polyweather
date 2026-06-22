# SPEC — the day-before-edge gate socket (WALLET-RECON-HANDOFF.md Build #4a)

> **Status: DESIGN ONLY — implementation-ready. NOT built in this lane.** This spec is the
> contract between the **forensics/study lanes** (Build #3 produces the verdict) and the
> **live lane** (Build #4 consumes it). It is executed in **Phase 3 ONLY IF KILL-GATE 2
> (Build #3) passes** (handoff §9). No code, no migration, no test is written by the lane
> that authored this spec.
>
> **Migration number is RESERVED, not created.** The orchestrator has reserved **`0052`**
> for this socket (handoff §9 migration-number broker). Phase 3 creates
> `0052_day_before_edge_gate.sql`; this lane only references the number.

---

## 1. The problem — the "false green" gap

`goLiveGate` (`packages/trading/src/gate.ts`) validates that our **SAME-DAY**
house-champion is calibrated against the market: ≥60 distinct out-of-sample days, pooled
paired-bootstrap p < 0.05, pooled 60d Brier ≤ 0.95× market, per-city Brier ≤ 1.0× with
n ≥ 30, no halts, geoblock clean, KYC + ledger fresh. Every one of those conditions is
about **same-day champion-vs-market Brier**, sourced from `go_live_gate_inputs` (`0019`),
which reads `calibration_scores` at leads {0, 1}.

The badatmath strategy — and Build #3's experiment — is a **day-before cheap-longshot**
edge: buy our calibrated modal bucket cheap (`<0.25`) the day before, beating the
**day-before ask**. **`goLiveGate` does not measure that at all.** So:

- A **perfect** Build #3 result (edge CI clears 0 on the `<0.25` subset, multi-station,
  all leads, survives fees) **would not register on the gate** — none of its conditions
  look at day-before edge.
- Worse, if the same-day calibration conditions happen to go green for unrelated reasons,
  the gate would report **"ready to go live"** for a strategy whose edge it never checked.
  That is a **false green**: the gate would authorize a day-before strategy on the strength
  of same-day calibration evidence.

Until a `day-before-edge` condition is wired into the gate, a green gate is a false green
**for the new strategy**. Build #3 produces the data; Build #4 builds the socket, extends
`goLiveGate`, and extends the `check-live-readiness` parity test **in lockstep**.

---

## 2. The data the socket carries — Build #3's verdict

Build #3 (`scripts/research/db1-daybefore-efficiency.ts`) already computes, per arm /
station / lead, the `ArmEdgeStats` bundle from `packages/core/src/sim/stats.ts`:
`{ edge, edgeCiLo, edgeCiHi, nGraded, ... }` where `edge = mean(won − ask)` over graded
day-before bets and `edgeCiLo/Hi` is its CI. The **pre-registered kill-criterion** (handoff
§6 Build #3 / KILL-GATE 2) is:

> edge CI **clears 0** on the **`<0.25`** subset, **survives fees**, **multi-station +
> all leads**, **not EHAM-only**, with a **+1.5%** point floor.

The socket carries that verdict as a single structured value. Proposed shape (the contract
both `GateInputs` and the RPC must produce):

```ts
dayBeforeEdge: {
  edgeLo: number | null;   // lower bound of the edge CI on the <0.25 subset, fee-adjusted
  edgeHi: number | null;   // upper bound (for the readout/detail line)
  nStations: number;       // distinct stations contributing graded day-before bets
  nLeads: number;          // distinct leads with graded bets (all-leads check)
  passesKillCriterion: boolean; // Build #3's own adjudication of the pre-registered rule
} | null
```

**Why carry both `edgeLo` and a `passesKillCriterion` boolean.** `passesKillCriterion` is
Build #3's authoritative adjudication of the *full* pre-registered rule (it has all the
per-arm data, fee model, EHAM-exclusion logic, and the multi-station/all-leads cut). The
gate re-checks the **machine-checkable invariants** it can see itself (`edgeLo` clears the
+1.5% floor; `nStations ≥ 2`; `nLeads` covers all leads) as a **defence-in-depth guard
against the persistence layer being stale or hand-edited** — the gate must never authorize
on a boolean alone that something could have flipped without the underlying CI moving.
`null` (no row) is a hard fail (the study hasn't been persisted).

---

## 3. The migration — `0052_day_before_edge_gate.sql` (RESERVED; shape only)

Mirror the `0019`/`0028` idiom: `create or replace function`, `language sql`,
`security definer`, `set search_path = public`, and a `revoke all … / grant execute to
service_role[, authenticated]` block (the **`0034` contract** — every new RPC ships its own
revoke/grant or the `0034` invariant test fails; `go_live_gate_inputs` is in the
`web_authenticated` surface, so the *extended* function keeps `authenticated`).

### 3a. Persistence table (Build #3's `--persist` target → or a dedicated socket table)

Build #3 with `--persist` writes its per-arm results. The gate needs the **adjudicated
day-before verdict** for the configured champion. Add a small verdict table the study
writes and the RPC reads (one current row per champion):

```sql
create table public.day_before_edge_verdict (
  champion        text primary key,
  edge_lo         numeric,         -- fee-adjusted edge CI lower bound, <0.25 subset
  edge_hi         numeric,
  n_stations      int not null,
  n_leads         int not null,
  passes_kill     boolean not null,
  subset          text not null default '<0.25',
  computed_at     timestamptz not null default now(),
  source_run      text,            -- the Build #3 run id / git sha for audit
  updated_at      timestamptz not null default now()
);
-- set_updated_at trigger (0039 idiom); RLS operator_read (0008 idiom);
-- the 0034 revoke/grant block for any new RPC below.
```

> **Reuse note:** if Build #3's `--persist` already lands a richer per-arm table (handoff
> leaves that to the study lane), `day_before_edge_verdict` can instead be a **view** that
> reduces it to the one adjudicated row per champion — the RPC contract below is unchanged
> either way. Phase 3 picks whichever avoids duplicating the per-arm rows.

### 3b. Extend `go_live_gate_inputs` to emit the `dayBeforeEdge` key (additive)

`create or replace` the **0019** `go_live_gate_inputs(p_champion text, p_city_slug text)`
exactly as it stands, **appending one key** to the `jsonb_build_object` (additive — same
pattern as the handoff's "recreate fn, append key" for `dash_amsterdam_sim.sharps`):

```sql
-- ... existing distinctDays / pooled / city / halts / kycAttestedAt / ledgerReconciledAt ...
'dayBeforeEdge', (
  select case when v.champion is null then null else jsonb_build_object(
    'edgeLo', v.edge_lo, 'edgeHi', v.edge_hi,
    'nStations', v.n_stations, 'nLeads', v.n_leads,
    'passesKillCriterion', v.passes_kill
  ) end
  from (select * from day_before_edge_verdict where champion = p_champion) v
)
```

Re-ship the `0034` revoke/grant block for `go_live_gate_inputs` after the `create or
replace` (re-creating a function resets its grants — keep `service_role` + `authenticated`).

---

## 4. The new condition in `goLiveGate`

Add the condition to `gate.ts` **in checklist semantics** — always evaluated, never
short-circuited, each failure pushes its own verbatim reason onto `reasons[]` (matching the
file's existing style). Place it **after** the per-city block and **before** the halts loop
(so the readout groups it with the EARNED conditions).

### 4a. Extend `GateInputs`

```ts
export interface GateInputs {
  distinctDays: number;
  pooled: { brier: number | null; brierMarket: number | null; bootstrapP: number | null; n: number } | null;
  city: { n: number; brier: number | null; brierMarket: number | null } | null;
  halts: string[];
  kycAttestedAt: string | null;
  ledgerReconciledAt: string | null;
  dayBeforeEdge: {
    edgeLo: number | null;
    edgeHi: number | null;
    nStations: number;
    nLeads: number;
    passesKillCriterion: boolean;
  } | null;
}
```

### 4b. The condition logic + verbatim reason strings

The pre-registered kill-criterion in gate form. Use a named constant for the floor so the
mirror and the gate share the literal:

```ts
const DAY_BEFORE_EDGE_FLOOR = 0.015; // +1.5% pre-registered kill-criterion (Build #3 / KILL-GATE 2)
const DAY_BEFORE_MIN_STATIONS = 2;   // multi-station, not EHAM-only
const DAY_BEFORE_MIN_LEADS = 2;      // all leads (leads {0,1} per ADR-16)
```

```ts
const dbe = inputs.dayBeforeEdge;
if (!dbe) {
  reasons.push('day-before-edge verdict missing (Build #3 study not persisted for this champion)');
} else {
  if (!dbe.passesKillCriterion) {
    reasons.push('day-before-edge kill-criterion not met (Build #3 verdict: REJECTED)');
  }
  const lo = dbe.edgeLo === null ? null : Number(dbe.edgeLo);
  if (lo === null || !(lo > 0)) {
    reasons.push(`day-before-edge CI does not clear 0 (lo ${lo ?? 'n/a'})`);
  } else if (!(lo >= DAY_BEFORE_EDGE_FLOOR)) {
    reasons.push(
      `day-before-edge below +1.5% floor (lo ${fmt(lo)} < ${fmt(DAY_BEFORE_EDGE_FLOOR)})`,
    );
  }
  if (dbe.nStations < DAY_BEFORE_MIN_STATIONS) {
    reasons.push(`day-before-edge not multi-station (only ${dbe.nStations}, need ≥${DAY_BEFORE_MIN_STATIONS})`);
  }
  if (dbe.nLeads < DAY_BEFORE_MIN_LEADS) {
    reasons.push(`day-before-edge not across all leads (only ${dbe.nLeads}, need ≥${DAY_BEFORE_MIN_LEADS})`);
  }
}
```

**Design notes (each is a deliberate constraint, mirroring WO-5 discipline):**
- **`passesKillCriterion` AND the re-derived guards both fire.** The boolean is Build #3's
  full adjudication; the `edgeLo`/`nStations`/`nLeads` re-checks are the gate's own
  defence-in-depth (handoff: "do NOT move the criteria to fit a result"). If the persisted
  boolean and the persisted numbers ever disagree, the gate fails on whichever is failing —
  it never authorizes on a stale boolean alone.
- **`edgeLo` is the FEE-ADJUSTED CI lower bound on the `<0.25` subset.** Build #3 must
  persist the fee-adjusted bound — "survives fees" is part of the kill-criterion and must
  be baked into the number the gate sees, not re-derived here (the gate has no fee model).
- **Two distinct reason strings for "does not clear 0" vs "below +1.5% floor"** so the
  readout tells the operator *which* threshold failed (a positive-but-tiny edge reads very
  differently from a straddling CI).
- **`null` is a hard fail** — an unpersisted study must never read as green.

This condition is **purely additive** to the existing reason list; all current conditions
and their strings are untouched, so existing gate behavior for the same-day path is
unchanged.

---

## 5. The parity mirror — extend `scripts/check-live-readiness.ts` IN LOCKSTEP

This is the **§15 anti-drift guard**: the CLI cannot import `goLiveGate` (the trading
boundary forbids `scripts/` importing `packages/trading`), so `check-live-readiness.ts`
hand-mirrors the gate and `check-live-readiness.test.ts` asserts the two reason lists are
**byte-identical** across every scenario. **Any change to `gate.ts` that is not mirrored
here fails the parity test.** Therefore Build #4a touches **all three** in one change:
`gate.ts`, `check-live-readiness.ts`, and `check-live-readiness.test.ts`.

### 5a. Mirror `GateInputs` and add the conditions to `buildConditions`

Add the identical `dayBeforeEdge` field to the CLI's local `GateInputs` interface, and the
same three constants (`DAY_BEFORE_EDGE_FLOOR = 0.015`, `DAY_BEFORE_MIN_STATIONS = 2`,
`DAY_BEFORE_MIN_LEADS = 2`). Then add `Condition` rows to `buildConditions` — **kind
`'earned'`** (forecast skill, not operator-settable), inserted in the **same position**
the gate emits them (after the per-city block, before the halts), with `reason` strings
**byte-identical** to §4b and a human `detail` line. Each gate reason becomes one
`Condition` so `buildConditions().filter(!ok).map(reason)` stays equal to the gate's
`reasons[]`:

```ts
// after the per-city block, before the halts loop
const dbe = inputs.dayBeforeEdge;
if (!dbe) {
  out.push({
    id: 'day_before_edge_row', kind: 'earned',
    label: 'day-before-edge verdict persisted (Build #3)',
    ok: false,
    reason: 'day-before-edge verdict missing (Build #3 study not persisted for this champion)',
    detail: 'no verdict row',
  });
} else {
  out.push({
    id: 'day_before_edge_kill', kind: 'earned',
    label: 'day-before-edge kill-criterion met (Build #3)',
    ok: dbe.passesKillCriterion,
    reason: dbe.passesKillCriterion ? null : 'day-before-edge kill-criterion not met (Build #3 verdict: REJECTED)',
    detail: dbe.passesKillCriterion ? 'PASS' : 'REJECTED',
  });
  const lo = dbe.edgeLo === null ? null : Number(dbe.edgeLo);
  if (lo === null || !(lo > 0)) {
    out.push({
      id: 'day_before_edge_ci', kind: 'earned',
      label: 'day-before-edge CI clears 0',
      ok: false,
      reason: `day-before-edge CI does not clear 0 (lo ${lo ?? 'n/a'})`,
      detail: `lo ${lo ?? 'n/a'}`,
    });
  } else {
    const floorOk = lo >= DAY_BEFORE_EDGE_FLOOR;
    out.push({
      id: 'day_before_edge_floor', kind: 'earned',
      label: 'day-before-edge ≥ +1.5% floor',
      ok: floorOk,
      reason: floorOk ? null : `day-before-edge below +1.5% floor (lo ${fmt(lo)} < ${fmt(DAY_BEFORE_EDGE_FLOOR)})`,
      detail: `lo ${fmt(lo)} vs floor ${fmt(DAY_BEFORE_EDGE_FLOOR)}`,
    });
  }
  out.push({
    id: 'day_before_edge_stations', kind: 'earned',
    label: `day-before-edge multi-station (≥${DAY_BEFORE_MIN_STATIONS})`,
    ok: dbe.nStations >= DAY_BEFORE_MIN_STATIONS,
    reason: dbe.nStations >= DAY_BEFORE_MIN_STATIONS ? null
      : `day-before-edge not multi-station (only ${dbe.nStations}, need ≥${DAY_BEFORE_MIN_STATIONS})`,
    detail: `${dbe.nStations} stations`,
  });
  out.push({
    id: 'day_before_edge_leads', kind: 'earned',
    label: `day-before-edge across all leads (≥${DAY_BEFORE_MIN_LEADS})`,
    ok: dbe.nLeads >= DAY_BEFORE_MIN_LEADS,
    reason: dbe.nLeads >= DAY_BEFORE_MIN_LEADS ? null
      : `day-before-edge not across all leads (only ${dbe.nLeads}, need ≥${DAY_BEFORE_MIN_LEADS})`,
    detail: `${dbe.nLeads} leads`,
  });
}
```

> **CRITICAL parity rule — the conditional structure must match the gate exactly.** The
> gate emits the "below +1.5% floor" reason **only on the `else` branch** of "clears 0"
> (a CI that fails to clear 0 emits the clears-0 reason and *not* the floor reason). The
> mirror above replicates that `if (lo clears 0) … else floor-check` structure so the
> reason **arrays match element-for-element**, not just as sets. The parity test compares
> ordered arrays (`expect(mirror).toEqual(gate)`), so order + which-reasons-fire must be
> identical.

### 5b. Extend the 22-scenario parity test

`scripts/check-live-readiness.test.ts` currently has a 22-scenario battery
(`passingArgs` baseline + 21 single-failure mutations + the all-green + all-failing cases).
The new field must appear in **both** the `passingArgs` baseline **and** new mutation
scenarios:

1. **Add `dayBeforeEdge` to `passingArgs().inputs`** so the existing "all green" scenarios
   stay green:
   ```ts
   dayBeforeEdge: { edgeLo: 0.03, edgeHi: 0.06, nStations: 5, nLeads: 2, passesKillCriterion: true },
   ```
2. **Add the `dayBeforeEdge` field to the "everything failing at once" scenario's inputs**
   as `null` (so it contributes its verdict-missing reason to the all-fail list).
3. **Add new single-failure scenarios** (each mutates the passing baseline), one per new
   reason string, so the parity test pins every new reason:
   - `'day-before-edge verdict missing'` → `dayBeforeEdge: null`
   - `'day-before-edge kill-criterion REJECTED'` → `{ ...passing, passesKillCriterion: false }`
   - `'day-before-edge CI straddles 0'` → `{ ...passing, edgeLo: -0.01 }`
   - `'day-before-edge below +1.5% floor'` → `{ ...passing, edgeLo: 0.005 }`
   - `'day-before-edge single station (EHAM-only)'` → `{ ...passing, nStations: 1 }`
   - `'day-before-edge missing a lead'` → `{ ...passing, nLeads: 1 }`
4. **Update the `stubDb` / `bothReasons` harness:** the test's `stubDb` already returns
   `inputs` verbatim from `go_live_gate_inputs`, so it carries the new field with no change.
   The "exec-time conditions never render as a blocking FAIL" test asserts
   `toHaveLength(2)` for a paper/unkeyed-but-otherwise-green config — that stays 2 because
   the new conditions are all green in `passingArgs`. **Verify this length assertion after
   adding the baseline field** (it is the one existing assertion most likely to break if the
   baseline `dayBeforeEdge` is accidentally left failing).

The parity test (`expect(mirror).toEqual(gate)`) is the enforcement: if §4b and §5a drift
by a single character, every affected scenario fails until they match. The
`scenarios.length` will rise from 22 to ~28; update any count comment.

---

## 6. The single contract point between the lanes (handoff §9 "lane independence")

This spec is the **one place** the live lane meets the forensics/study lane. The boundary
is exactly:

- **Build #3 (study lane) produces:** the adjudicated day-before verdict — `edgeLo`
  (fee-adjusted, `<0.25` subset), `edgeHi`, `nStations`, `nLeads`, `passesKillCriterion` —
  and persists it (its `--persist`/`0052` write target → `day_before_edge_verdict`).
- **Build #4 (live lane) consumes:** that verdict via `go_live_gate_inputs.dayBeforeEdge`,
  enforces it in `goLiveGate`, mirrors it in `check-live-readiness`, and pins it in the
  parity test.

The study lane never touches `packages/trading` / `gate.ts` / `check-live-readiness*`; the
live lane never touches the EMOS harness / `openmeteo.ts` / `0010_seed.sql`. They agree
only on the **`dayBeforeEdge` shape in §2** — keep that shape identical in (a) the
persistence table/view, (b) the RPC's `jsonb_build_object`, (c) `gate.ts`'s `GateInputs`,
and (d) `check-live-readiness.ts`'s `GateInputs`. A change to the shape is a coordinated
four-file change, exactly like the existing `GateInputs` ↔ `go_live_gate_inputs` ↔ mirror
triple is today.

---

## 7. Acceptance criteria (Phase 3 execution)

- `0052_day_before_edge_gate.sql` created: `day_before_edge_verdict` table/view + extended
  `go_live_gate_inputs` emitting `dayBeforeEdge` + the `0034` revoke/grant block; idempotent
  under db-reset re-run.
- `goLiveGate` emits the new reasons in checklist semantics; all existing same-day
  conditions and their strings unchanged.
- `check-live-readiness.ts` mirrors the new conditions verbatim (kind `'earned'`, identical
  reason strings, identical conditional structure).
- `check-live-readiness.test.ts`: baseline `passingArgs` includes a green `dayBeforeEdge`;
  ≥6 new single-failure scenarios added; the all-failing scenario includes the verdict-missing
  reason; `expect(mirror).toEqual(gate)` green on every scenario; the `toHaveLength(2)`
  exec-time test still passes.
- `pnpm typecheck && pnpm test` green (`0034` invariant test + §15 invariants test still
  green — the socket touches no boundary import).
- With a persisted PASS verdict, the live readout shows the day-before-edge conditions
  green; with no verdict row, it shows the verdict-missing blocker — i.e. **a perfect
  Build #3 result now registers on the gate, and the false-green is closed.**

---

_Cross-refs: `gate.ts` `goLiveGate`/`GateInputs`; `0019_trading_rpcs.sql`
`go_live_gate_inputs`; `0034_lockdown_internal_rpcs.sql` revoke/grant contract +
`web_authenticated` surface; `scripts/check-live-readiness.ts` + `.test.ts` (§15 parity
mirror); `packages/core/src/sim/stats.ts` `ArmEdgeStats`/`armEdgeStats` (Build #3's edge
bundle); `docs/GO-LIVE-CHECKLIST.md`; handoff §6 Build #3/#4a + §9 KILL-GATE 2 →
Phase 3 contract; companion `ADR-22-sdk-seam-verification.md` (Build #4b)._
