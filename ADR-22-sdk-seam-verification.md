# ADR-22 — Verifying the dormant CLOB SDK seam without breaching the §15 trading boundary

> **Status: PROPOSED — DESIGN ONLY. NOT executed in this lane.** This ADR resolves
> WALLET-RECON-HANDOFF.md §6 **Build #4b**. It is executed in **Phase 3 ONLY IF
> KILL-GATE 2 (Build #3) passes** (§9 of the handoff). If KILL-GATE 2 fails, the live
> rail stays dormant and this ADR is never carried out — it remains a recorded decision
> for whenever (if ever) new out-of-market information reopens the live track.
>
> Recorded as a delta-decision companion to `ARCHITECTURE.md §3` (the same pattern
> `BLUEPRINT-analytics-buildout.md` uses for ADR-18 — ADR-21). On execution, add a
> one-paragraph **ADR-22** stub to `ARCHITECTURE.md §3` pointing here, mirroring how
> ADR-18 — ADR-21 are stubbed inline.

---

## 1. Context — the problem this decision exists to solve

The live order rail is **built, mock-tested, and dormant** (ADR-10). The pieces that
touch Polymarket's Central Limit Order Book SDK are:

- `packages/trading/src/live.ts` — `createClobClient()` (L1→L2 auth: ethers `Wallet` from
  the wallet key → `ClobClient` → `createOrDeriveApiKey`) and `LiveExecutor.place()`
  (`getTickSize` → `createOrder` → `postOrder('GTC')` → `getOrder` → either record-fill via
  `fill_bet_with_caps` or `note_resting_order`).
- `ClobClientish` — the hand-written structural slice of `@polymarket/clob-client` the
  executor depends on (`getTickSize`, `createOrder`, `postOrder`, `getOrder`,
  `cancelOrder`).

**Two facts make this code impossible to smoke-test out-of-band today:**

1. **It only resolves at runtime, in Deno.** `createClobClient()` imports the SDK through
   **non-literal** dynamic specifiers (`const clobSpec = 'npm:@polymarket/clob-client@4'; await import(clobSpec)`)
   precisely so tsc/Node/webpack never resolve it — nothing is installed until the live
   phase deploys to the Deno Edge runtime. The eszip deploy bundler can't see the
   non-literal specifiers either, so `execute-bet/index.ts` carries **literal** npm-snapshot
   hint imports kept in lockstep by `invariants.test.ts`. There is no Node code path that
   can `new ClobClient(...)` against the real host.

2. **The §15 trading-boundary invariant forbids reaching it from anywhere else.**
   `packages/trading/test/invariants.test.ts` scans the real source tree
   (`packages`, `supabase`, `scripts`, `apps`; `.ts/.tsx/.js/.mjs/.sql`) on every test run.
   Its three load-bearing assertions, quoted verbatim from the test header:

   > ```
   >  * §15 trading-boundary grep invariants (ADR-10, §11.5):
   >  *   1. POLY_PRIVATE_KEY is read NOWHERE outside packages/trading.
   >  *   2. The clob client is imported NOWHERE outside packages/trading.
   >  *   3. packages/trading is imported only by execute-bet and the web
   >  *      gate-readout (plus test files, which exercise the boundary).
   > ```

   Invariant #1 even flags the **literal wallet-key env-var token** anywhere outside
   `packages/trading/` (the test reconstructs the token split, `'POLY_' + 'PRIVATE_KEY'`,
   so it does not flag itself — this ADR refers to it the same way, never spelling the
   literal in prose). Invariant #2's only sanctioned exceptions are two **non-executing**
   mentions: the literal eszip hints in `execute-bet/index.ts` and the ambient
   `declare module` lines in `_shared/npm-specifiers.d.ts`. Invariant #3's allow-list is
   exactly `packages/trading/`, `supabase/functions/execute-bet/`, `apps/web/`, and
   `*.test.ts`.

**Consequence — the gap.** The SDK call surface has **never executed against the live
CLOB.** In particular, `getOrder`'s response fields (`status`, `price`, `size_matched`)
are **mock-guessed** in `ClobClientish` and exercised only by injected mocks. The header
of `live.ts` says so explicitly:

> `getOrder's response fields are mock-verified only — re-verify against the live CLOB at
> P10 go-live (docs/GO-LIVE-CHECKLIST).`

`LiveExecutor.place()` branches on `status?.status === 'matched'` and reads
`status.price` / `status.size_matched` to decide *filled vs resting* and to record the
fill. If the live SDK spells any of these differently (`matched` vs `MATCHED` vs `live`;
`size_matched` vs `sizeMatched`; a nested `order` envelope), the first real order either
mis-records a fill or silently treats a matched order as resting. We must NOT discover
that on the **first real-money order**.

So: we need a way to run a **read-only** slice of the real SDK against the live host
**before** the first order, but every obvious place to do it is walled off by §15 — and
§15 is exactly the safety property we do not want to weaken. Hence an ADR, not a smuggle.

---

## 2. Decision drivers

- **D1 — Re-verify `getOrder` (and tick/book reads) against the live CLOB before any
  first real order.** Non-negotiable; it is the named go-live precondition in both
  `live.ts` and GO-LIVE-CHECKLIST.
- **D2 — Do not create or widen a path that can place a live order.** The whole point of
  the chokepoint (ADR-10) is that exactly one process (`execute-bet`) can execute, behind
  `goLiveGate`. A verification path must be **read-only by construction**, not by
  convention.
- **D3 — Keep §15 provable, not eroded.** Whatever we change, the grep invariants must
  stay *meaningful* — a reader must still be able to trust that the wallet key and the
  order-placing client live only inside `packages/trading`.
- **D4 — Minimal blast radius.** Prefer the change that touches the fewest files and
  leaves the dormant rail's hot path byte-identical.
- **D5 — Auditable run.** The verification must produce a recorded artifact (logged
  field shapes) an operator and a second (adversarial) agent can inspect, since this runs
  immediately before committing real funds.

---

## 3. Options considered

Both options assume the SDK must execute **inside `packages/trading` in the Deno runtime**
(that is the only place it resolves and the only place §15 permits the import). They differ
in *who invokes it* and *how the read-only guarantee is enforced*.

### Option A — Widen the §15 allow-list for a read-only verification path

Add a small **read-only** verification helper inside `packages/trading` that constructs
the client and calls **only** `getTickSize` / `getOrderBook` / `getOrder` (never
`createOrder` / `postOrder` / `cancelOrder`), and expose it through a tiny **new
Edge Function** dedicated to verification, then widen invariant #3's importer allow-list to
admit that one function.

**Files touched**
- `packages/trading/src/live.ts` — add `getTickSize(tokenID)` if not already on the public
  surface, and add a read-only `getOrderBook(tokenID)` to `ClobClientish` + a thin
  `verifyClobReads(tokenIds)` function that constructs the client via `createClobClient()`
  and returns the **raw** `getOrder`/`getOrderBook`/`getTickSize` responses (un-narrowed)
  so their real field shapes are logged verbatim. No method that mutates order state is
  reachable from this function.
- `packages/trading/src/index.ts` — export `verifyClobReads` (+ its result type).
- `supabase/functions/verify-clob/` — **new Edge Function** (cron-secret auth, same
  `requireCronAuth` pattern as `execute-bet`; **never** cron-scheduled — operator-triggered
  on demand). It imports `verifyClobReads` from `packages/trading`, runs it against a known
  resolved-or-open token, and logs the raw field shapes. It does **not** import the bet
  state machine and has **no** `createOrder`/`postOrder` reachable.
- `supabase/functions/verify-clob/index.ts` — must carry the **same literal eszip hint
  imports** (`import('npm:ethers@5')`, `import('npm:@polymarket/clob-client@4')`) as
  `execute-bet/index.ts`, because it pulls in `createClobClient()`'s non-literal specifiers
  too.
- `supabase/functions/_shared/npm-specifiers.d.ts` — unchanged (already declares both).

**How the §15 invariant test changes**
- Invariant #3 (`packages/trading is imported only by execute-bet + the web gate-readout`):
  add `p.startsWith('supabase/functions/verify-clob/')` to the allow-list predicate, and
  add a positive assertion that `verify-clob/handler.ts` exists (mirroring the existing
  `sanity: known-allowed files exist` test).
- Invariant #2's eszip-lockstep test (`eszip hints … stay in lockstep with live.ts`):
  must now check the hints in **both** `execute-bet/index.ts` **and** `verify-clob/index.ts`
  (or be generalized to "every functions file that imports `packages/trading` carries the
  hints"). This is the subtle, easy-to-miss part — the hint-lockstep test is currently
  hard-coded to `execute-bet/index.ts`.
- Invariant #1 (wallet-key token) is **unchanged** — `verify-clob` does not read the key;
  `createClobClient()` (inside `packages/trading`) does, exactly as today.

**Blast radius**
- One new Edge Function + ~2 small additions to `live.ts`/`index.ts` + 2 edits to
  `invariants.test.ts`. The dormant hot path (`LiveExecutor.place`) is **byte-identical**.
- The §15 allow-list grows by one entry — but it grows to admit a function that is
  read-only **by construction** (no order-mutating method is in its import closure).

**Risk of accidentally enabling a live order path**
- **Low–medium.** The new function genuinely cannot place an order (it never imports the
  bet state machine and `verifyClobReads` never calls `createOrder`/`postOrder`). The
  residual risk is **boundary erosion**: invariant #3 now says "trading is imported by
  execute-bet, the web readout, **and verify-clob**", which a future reader could cite to
  justify a third, fourth importer. Mitigate by (a) a comment on the allow-list entry
  ("read-only verification ONLY — see ADR-22; this function MUST NOT import the executor
  or any order-mutating method") and (b) an added invariant that **`createOrder`/
  `postOrder` strings appear nowhere under `supabase/functions/verify-clob/`**.

### Option B — Add a verification/dry-run mode to `execute-bet`

Reuse the **existing** chokepoint: add a third `action` to `execute-bet` (alongside
`place`/`cancel`), e.g. `action: 'verify'`, that constructs the live client and runs the
read-only reads — no allow-list change at all, since `execute-bet` already imports
`packages/trading`.

**Files touched**
- `packages/trading/src/live.ts` — same `verifyClobReads` helper as Option A (read-only).
- `packages/trading/src/index.ts` — export it.
- `supabase/functions/execute-bet/handler.ts` — add the `'verify'` branch to the action
  switch (it currently accepts only `'place'`/`'cancel'` and 400s on anything else). The
  branch must run **before** any bet load / gate / executor construction, take **no**
  `betId`, and return the logged field shapes.
- `apps/web/.../routes.ts` + the bet proxy — optionally surface a verify button, or leave
  it CLI/curl-only against the function with the cron secret.

**How the §15 invariant test changes**
- **No allow-list change** — `execute-bet` is already invariant #3's primary importer.
- Invariant #2's eszip-lockstep test is **unchanged** (the hints already live in
  `execute-bet/index.ts`).
- A **new** invariant is *advisable* but harder: assert that the `'verify'` branch is
  read-only. There is no clean grep for "this code path doesn't call `createOrder`" — the
  verify branch lives in the *same file* as the place branch, so a string scan can't
  distinguish them. This is the core weakness (see risk).

**Blast radius**
- Smaller file count (no new function), but it is **concentrated on the single most
  dangerous file in the system** — the one process that can place a live order. Every edit
  to `execute-bet/handler.ts` is an edit to the order-placement chokepoint.

**Risk of accidentally enabling a live order path**
- **Medium–high.** The verify branch shares a function body, a request entry point, and
  the live-client factory with the real `place` path. A future refactor that, say, hoists
  client construction or "reuses" the verify branch's bet-load could leak the order path
  into a context that skips `goLiveGate`. The read-only guarantee is **by convention**
  (the branch happens not to call `createOrder`), not **by construction** — which directly
  violates D2. It also muddies the §8.1 response contract and the gate semantics
  (`'verify'` must explicitly *not* run `goLiveGate`, which means adding a
  gate-bypassing code path **inside the gated function** — exactly the shape of bug §15
  exists to prevent).

---

## 4. Decision — **Option A** (read-only verification function + one narrow allow-list entry)

**Recommend Option A.** Rationale, against the drivers:

- **D2 (no live-order path) is satisfied by construction, not convention.** Option A's
  verification function physically cannot import an order-mutating method; Option B's
  verify branch shares a body with the order path and can only be argued safe. For a
  change whose entire purpose is the last safety check before real money, "safe by
  construction" wins decisively.
- **D3 (keep §15 provable).** Counter-intuitively, **A keeps the boundary cleaner.**
  Option B avoids touching the *allow-list* but does so by putting a gate-bypassing branch
  **inside the gated chokepoint**, which is a worse erosion of the property §15 protects
  than adding one clearly-labelled, read-only importer. A also lets us *add* an invariant
  (`createOrder`/`postOrder` absent under `verify-clob/`) that makes the read-only claim
  machine-checked — strengthening §15 net.
- **D4 (blast radius).** B touches fewer files but A touches *safer* files; A leaves
  `execute-bet/handler.ts` — the order chokepoint — completely untouched. The marginal
  cost of one tiny Edge Function is worth not editing the most dangerous file in the repo.
- **D5 (auditable run).** Both can log; A's dedicated function gives the operator and the
  adversarial verifier a single, obviously-read-only artifact to inspect.

**The one real cost of A** — remembering that invariant #2's eszip-lockstep test is
hard-pinned to `execute-bet/index.ts` and must be generalized to cover `verify-clob/index.ts`
— is explicitly called out in the implementation checklist below so Phase 3 cannot miss it.

---

## 5. Implementation checklist (Phase 3, only if KILL-GATE 2 passed)

1. **`packages/trading/src/live.ts`**
   - Add `getOrderBook(tokenID: string): Promise<unknown>` to `ClobClientish` (read-only).
   - Add `export async function verifyClobReads(tokenIds: string[]): Promise<VerifyClobResult>`:
     construct via `createClobClient()`; for each token call `getTickSize`, `getOrderBook`,
     and (for at least one **known order id** if available, else skip with a logged note)
     `getOrder`; return the **raw, un-narrowed** responses plus `Object.keys(...)` of each
     so the live field names are captured verbatim. Call **no** mutating method.
2. **`packages/trading/src/index.ts`** — export `verifyClobReads` + `VerifyClobResult`.
3. **`supabase/functions/verify-clob/handler.ts`** + **`index.ts`** — new function:
   `requireCronAuth`; operator-triggered (NOT in `0009_cron.sql` / any cron schedule);
   imports `verifyClobReads`; logs the field shapes; returns them. `index.ts` **must carry
   the literal eszip hints** `import('npm:ethers@5')` and `import('npm:@polymarket/clob-client@4')`
   identical to `execute-bet/index.ts`.
4. **`supabase/config.toml`** — register `verify-clob` with `verify_jwt = false` (cron-secret
   auth, same as `execute-bet`; W11/ADR-10).
5. **`packages/trading/test/invariants.test.ts`** — (a) add
   `p.startsWith('supabase/functions/verify-clob/')` to invariant #3's allow-list with a
   comment citing ADR-22; (b) generalize the eszip-lockstep test to verify the hints in
   **every** `supabase/functions/*/index.ts` that imports `packages/trading`
   (currently only `execute-bet`); (c) **add a new invariant**: the strings `createOrder`
   and `postOrder` appear nowhere under `supabase/functions/verify-clob/` (machine-checks
   the read-only claim).
6. **`docs/GO-LIVE-CHECKLIST.md`** — insert a P10 step **between** "wallet secrets set" and
   "set tradingMode=live": *"Run `verify-clob` against a live token; confirm `getOrder`
   returns `status`/`price`/`size_matched` with the spellings `LiveExecutor.place` reads,
   and `getTickSize` returns a usable tick. Any field-name mismatch → fix `ClobClientish` +
   `LiveExecutor.place` mapping and re-run BEFORE the first order."*
7. **`ARCHITECTURE.md §3`** — add the inline **ADR-22** stub pointing to this file (mirror
   the ADR-18 — ADR-21 stubs).

### The concrete `getOrder` re-verification checklist (D1 — do this before the first real order)

Run `verify-clob` and confirm, against the **live** CLOB response, each field
`LiveExecutor.place` depends on:

| What `place()` reads today (mock-guessed) | Confirm on the live response | If mismatched |
|---|---|---|
| `getOrder(id).status === 'matched'` (the filled-vs-resting branch) | exact string for a fully-matched order (`matched`? `MATCHED`? `FILLED`?), and the string for a still-open/resting order | update the `=== 'matched'` comparison + any resting-state handling |
| `getOrder(id).price` (recorded as the fill price) | field name + type (string vs number) of the matched price | fix `Number(status.price ?? limit)` mapping |
| `getOrder(id).size_matched` (recorded as filled shares) | field name (`size_matched` vs `sizeMatched`) + type; whether it's cumulative or per-fill | fix `Math.floor(Number(status.size_matched ?? bet.recShares))` |
| envelope shape | whether fields are top-level or nested under an `order` / `data` key | adjust `ClobClientish.getOrder`'s return type + the reads |
| `getTickSize(token)` | numeric tick returned (and unit) — `place()` floors the BUY limit to this grid | confirm `tick > 0` path; the rail rounds DOWN, never paying above the ask |
| partial-fill semantics | does `status` ever report `matched` with `size_matched < size`? | the rail currently treats any `matched` as a full record — decide partial-fill handling before live |

Record the raw responses + `Object.keys` in the run log as the auditable artifact (D5);
have the **second (adversarial) agent** confirm the mapping matches `place()` before the
first order is permitted.

---

## 6. Alignment / deviation vs the existing record

- **Aligns with ADR-10** (executor behind one chokepoint, wallet key + client only inside
  `packages/trading`): the live-order path stays exactly one process (`execute-bet`) and
  the verification function is read-only — it does not become a second executor.
- **Strengthens §15** rather than weakening it: the allow-list gains one read-only entry,
  but a new machine-checked invariant (no `createOrder`/`postOrder` under `verify-clob/`)
  makes the read-only property *provable*, and `execute-bet/handler.ts` is left untouched.
- **Satisfies the `live.ts` / GO-LIVE-CHECKLIST precondition** ("re-verify `getOrder`
  fields against the live CLOB at P10") with a concrete, runnable mechanism instead of a
  prose reminder.
- **Recorded as a new ADR (ADR-22)** rather than a silent change because it edits the §15
  invariant — the project's stated rule (cf. ADR-18) is that a change to what an invariant
  *means* gets its own ADR.
