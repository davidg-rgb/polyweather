# Architecture Review — Polyweather Analytics Buildout

> Reviewed: 2026-06-13
> Source: BLUEPRINT-analytics-buildout.md (932 lines)
> Reviewers: Integrity (Phase 9 **Lite** — single pass, per operator cost-gate choice)

## Summary
- **0 CRITICAL**
- **0 WARNING**
- **2 INFO** (both fixed inline)

## CRITICAL findings
None.

## WARNING findings
None.

## INFO observations (both resolved inline)
- `[INFO] §6.A:174` — C1 target cited `snapshot-ensembles/handler.ts:26-34` while the C1 prose + §13 checklist cited `:28-31`. → **FIXED** to `:28-31`.
- `[INFO] §3:94 / §3:104` — two ADR blocks were unnumbered (`ADR-decision:`) while siblings were ADR-18/ADR-19. → **FIXED**: numbered **ADR-20** (widen edge cadence) and **ADR-21** (dashboard surfacing).

## Verification dimensions (all clean)
1. **In-doc cross-ref integrity** (Called by ↔ Calls among defined changes) — clean (HD-1↔HD-2, DF-2↔DF-3, WEB-1↔WEB-2↔WEB-3↔WEB-4, WEB-6↔EventPage all matched; edges to existing symbols correctly excluded).
2. **§8 contracts → §6 changes** — clean (13/13 map).
3. **§9 data-flow steps → real functions** — clean.
4. **§13 checklist ↔ §6/§7/§8/§9 definitions** (both directions) — clean; all 16 changes have ≥1 checklist item, every item carries a `(→ §X)` trace.
5. **No in-doc orphans** — clean (page/cron entry points documented).
6. **Findings coverage** — all 7 findings (#1–#7) addressed.

Light sweep — all clean: migration numbering (0028/0029/0030, collision-free vs applied 0027), phase labels (§2 ↔ §6 ↔ §12), prose counts (7→8 pages; nav 5→6 links), ADR cross-refs. Source-citation spot-checks verified accurate: `0016:12` (verified gate), `0005:27` (the existing index — the doc's self-correction is right), `0005:113-114` (edge natural key), `poll-markets:512` (clock gate) / `:302-305` (bettable), ensembles RPC anchors.

## Recommended next steps
The blueprint is internally airtight and build-ready as a reference instrument. The only remaining opens are **operator product decisions**, not consistency defects:
1. **ADR-18 sign-off** — decoupling `verified` from analytics reverses the original ADR-03/ADR-10 trading-first framing (changes what `verified` means). Foundational; confirm before building.
2. **ADR-20 sub-choice** — reliable-hourly edge cadence (one-line predicate change) vs sub-hour densification (multi-touch: key + retention + read filter).
3. **ADR-21** — does the new `/events` page become the default landing? (Y/N)
4. **§6.16 prose amendment** — "verified station" → "open, ladder-ok event".

Then proceed per the §12 roadmap: **Phase 1 (surface data) ∥ Phase 2a (capture bug)**; Phase 2a is the critical-path gating unknown. Also pending: rotate the `wuApiKey` surfaced during investigation (R-SEC).
