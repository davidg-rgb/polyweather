-- 0110_buy_table_fill_alert.sql — allowlist the BUY_TABLE_FILLED Slack push (operator directive 2026-07-18).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: the operator ordered continuous buying ON and wants Slack to push every buy — what was bought and at
-- what price. No fill-success alert kind existed (the 0095 kinds are all failure/deadman classes), so the
-- buy-table-tick handler now emits `BUY_TABLE_FILLED` (INFO) on every LIVE fill (city · bucket · shares ·
-- avg fill price · cost · time to close), and this migration appends the kind to the claim_alert allowlist.
--
-- C16 CONTEXT (the global Slack halt, operator order 2026-07-12): prod's alerts_slack_allow_kinds is the
-- EMPTY string — every kind is suppressed unrecorded. The 0095 append idiom below adds to the CURRENT value,
-- so on prod the allowlist becomes exactly 'BUY_TABLE_FILLED' — buy fills push, EVERYTHING ELSE stays dark
-- (the C16 halt is narrowed by exactly one kind on the operator's word, not lifted). On a fresh chain the
-- 0066/0095-seeded list simply gains the new kind.
--
-- No table, no function, no cron change. Rollback: strip 'BUY_TABLE_FILLED' from the config value.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_kinds text := coalesce((select value from config where key = 'alerts_slack_allow_kinds'), '');
  v_kind  text;
begin
  foreach v_kind in array array['BUY_TABLE_FILLED'] loop
    if not (v_kind = any(string_to_array(v_kinds, ','))) then
      v_kinds := case when v_kinds = '' then v_kind else v_kinds || ',' || v_kind end;
    end if;
  end loop;
  insert into config (key, value) values ('alerts_slack_allow_kinds', v_kinds)
    on conflict (key) do update set value = v_kinds, updated_at = now();
end $$;
