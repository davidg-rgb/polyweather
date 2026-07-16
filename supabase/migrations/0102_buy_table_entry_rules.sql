-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0102 · BUY-TABLE ENTRY RULES — config defaults for the operator's verification-day rule set (2026-07-16 C18c)
--
-- Two handler-side rules (supabase/functions/buy-table-tick/handler.ts · deriveEntryGate), both config-gated
-- with defaults that reproduce the ORIGINAL one-attempt-EVER behavior exactly:
--
--   buy_table.max_entry_attempts   (default '1')     Rule 1 — "if trade fails → reset and get the next entry".
--     Total placement attempts allowed per market (ledger rows per intent key). >1 lets a PROVABLY-dead
--     attempt be retried on a later tick: ONLY status 'failed' (clean venue rejection — the executor freed
--     the key because the venue verifiably holds no order) or a zero-fill 'canceled'. Unknown-state rows
--     (stuck 'intent', unfilled 'placed' — the ORDER_NEEDS_RECONCILE classes) ALWAYS block their market:
--     a blind retry could double-place. The ledger's (mode, intent_key) partial-unique index already
--     re-admits reservation after terminal rows — this rule only opens the handler's code-side gate.
--
--   buy_table.stop_after_first_success  (default 'false')   Rule 2 — "if trade successful → no further trials".
--     Once ANY entry in the current mode carries a REAL fill (size_matched > 0, incl. partial — money is
--     deployed), the lane opens NO new entries, including later candidates within the same tick. Halts until
--     the operator flips this back to 'false' (or the fill rows leave the mode's history).
--
-- DML-only (config rows; on-conflict-do-nothing so live operator values survive re-apply). No DDL, no RPCs.
-- The handler must be REDEPLOYED (supabase functions deploy buy-table-tick --no-verify-jwt) to read these.
--
-- ROLLBACK: delete from public.config where key in ('buy_table.max_entry_attempts',
--           'buy_table.stop_after_first_success');   -- handler defaults then apply (1 / false = original).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════

insert into public.config (key, value) values
  ('buy_table.max_entry_attempts',      '1'),
  ('buy_table.stop_after_first_success', 'false')
on conflict (key) do nothing;
