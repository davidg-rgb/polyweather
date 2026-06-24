# Whale-Watch — Polymarket large-trade alarm + global Slack-alert pause

> Operator ask (2026-06-24): *"set up a signal for unusual high bets — if any one bet above $100,000 is made
> on anything, notify me"*, and *"put every other Slack notification on pause starting now."*

A read-only monitor that alerts on **single Polymarket trades ≥ $100k of cash notional, across ALL markets**
(not just our weather universe). Built from the migration `0055` schema + the `whale-watch` Edge Function,
reusing the existing Polymarket data client and the Slack/`notifySlack` machinery. **It places no trades** —
the live-trading rail stays DORMANT (`FINDINGS.md`). It is pure market-microstructure analytics, a sibling of
the `0049` sharp-wallet tracker.

---

## 1. How it works

```
pg_cron (*/10 * * * *)
   → Edge: whale-watch  (supabase/functions/whale-watch)
       1. whale_settings()                    → minUsd (config whale_min_usd, default $100k)
       2. fetchTrades(filterType=CASH,         → the GLOBAL /trades feed, server-side filtered
                      filterAmount=minUsd)        to fills whose USDC notional ≥ minUsd
       3. whale_record_trades(rows)            → idempotent insert into whale_trades (PK trade_key)
       4. whale_pending_alerts(limit)          → the durable, crash-safe alert queue (alerted=false)
       5. notifySlack(WHALE_TRADE, …) per row  → posts "who bet what, which side, $, link" to Slack
       6. whale_mark_alerted(deliveredKeys)    → flips alerted=true ONLY on a 2xx Slack post
```

**Why it's cheap:** the Data API `/trades` endpoint is public, keyless, and supports a **server-side cash
floor** (`?filterType=CASH&filterAmount=N`). So each poll returns only the handful of whales, nowhere near
the 200-req/10s `/trades` budget. Notional = `size × price` (live-verified — the filter thresholds on
`size × price`). One returned row = one taker order = one "bet".

**Crash-safe, at-least-once:** alerts are dispatched off the `whale_pending_alerts` queue and a row is only
marked `alerted` after a delivered Slack post, so a tick that records then dies re-alerts on the next run.
`notifySlack`'s own per-trade `dedupeKey` (the `trade_key`) prevents a same-day duplicate post.

**The alert** (Block-Kit) names the trade and links to it:

```
🎯 [ACTION] $255k BUY — Will England win on 2026-06-23?
Iconicsoundsdk BUY Yes on _Will England win on 2026-06-23?_
Notional $255,224  ·  255,480 shares @ 0.999 (100% implied)
<https://polymarket.com/event/…|View the bet on Polymarket →>
<https://polygonscan.com/tx/0x…|tx on Polygonscan>
```

Severity scales with size: `≥$100k → ACTION`, `≥$250k → WARN`, `≥$1M → CRITICAL`.

---

## 2. The global Slack-alert pause gate

A single config-driven chokepoint, `slack_alert_suppressed(kind)`, consulted by **both** `claim_alert`
(suppress at record time → no resend on resume) and `list_unsent_alerts` (don't leak queued kinds via the
ADR-11 resend sweep). When paused, every alert kind **not** in the allowlist is dropped.

| config key | default | meaning |
|---|---|---|
| `alerts_slack_paused` | `false` | master switch; `true` suppresses all non-allowlisted kinds |
| `alerts_slack_allow_kinds` | `WHALE_TRADE` | comma-separated kinds that survive the pause |
| `whale_min_usd` | `100000` | single-trade USDC-notional floor for an alert (DB-tunable, no redeploy) |

> ⚠ **While paused, CRITICAL `JOB_FAIL` (and every other) alert is silenced too** — a job can fail without
> pinging you. This is intentional per the operator ask. The whale alarm still gets through.

**Pause is LIVE on prod as of 2026-06-24** (applied via a minimal, idempotent, ledger-free `execute_sql` — the
exact gate functions + flag from `0055`; superseded as a no-op when `0055` is deployed normally). Before the
pause, prod was emitting ~173 Slack alerts/day across 15 kinds.

- **Pause everything but whales:** `update config set value='true'  where key='alerts_slack_paused';`
- **Resume all alerts:**          `update config set value='false' where key='alerts_slack_paused';`
- **Also let, say, DEAD_MAN through while paused:** `update config set value='WHALE_TRADE,DEAD_MAN' where key='alerts_slack_allow_kinds';`
- **Change the whale threshold (e.g. $50k):** `update config set value='50000' where key='whale_min_usd';`

---

## 3. Files

| Layer | Path |
|---|---|
| Data client (Node + Deno twins) | `packages/io/src/polymarket-wallet.ts` · `supabase/functions/_shared/polymarket-wallet.ts` — `parseTrades` / `fetchTrades` |
| Migration | `supabase/migrations/0055_whale_watch.sql` — `whale_trades`, `whale_record_trades`/`_pending_alerts`/`_mark_alerted`/`whale_settings`, `dash_whale_watch`, the pause gate, the cron |
| Edge Function | `supabase/functions/whale-watch/{index,handler}.ts` |
| Ops read | `dash_whale_watch(limit)` (operator-only) |
| Tests | `supabase/tests/whale-watch.test.ts`, `…/polymarket-wallet-seam-parity.test.ts`, `packages/io/test/polymarket-wallet.test.ts` |
| Fixture | `research/dataapi-trades-whales-sample.json` (frozen live whales) |

---

## 4. Operator deploy (to make the alarm itself go live)

The pause is already live. The **alarm** needs the normal operator deploy (prod is currently applied through
`0053`; `0054` + `0055` are pending):

1. **Set the Slack webhook** (if not already): the whale alerts post to `SLACK_WEBHOOK_URL` (same secret the
   rest of the system uses). Create an incoming-webhook URL for the channel you want and set it as an Edge
   secret: `supabase secrets set SLACK_WEBHOOK_URL=…`. (With the pause on, ONLY whale alerts use it.)
2. **Apply migrations** `0054` then `0055` (`supabase db push`, or the project's deploy flow). `0055` is
   idempotent w.r.t. the live pause patch (same `create or replace` bodies).
3. **Deploy the Edge Function:** `supabase functions deploy whale-watch`.
4. The `*/10 * * * *` cron registers automatically on `0055` apply. First poll within 10 min surfaces any
   live ≥$100k trade; verify with `select public.dash_whale_watch(20);` (operator role) or watch Slack.

Tune the threshold anytime via `whale_min_usd` (no redeploy). To stop the alarm, mute it with
`update config set value='OTHER_KIND' where key='alerts_slack_allow_kinds';` or pause `whale-watch` in cron.
