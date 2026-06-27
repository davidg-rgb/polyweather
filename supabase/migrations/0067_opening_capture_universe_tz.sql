-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0067 · opening-capture CHECK-universe cities.tz correction (PHASE-0.5-VALIDATION-HANDOFF.md §2)
--
-- Phase 0.5 widens the keyless CAPTURE universe from the §9R 10-city TRADE set to the full set of cities we
-- BOTH (a) hold a calibrated forecast for AND (b) Polymarket lists daily-Tmax markets on — ~45 cities. This is
-- pure measurement (broader = more independent weather-days → a better-powered Phase-0.5 spike, ~zero capital
-- risk; trading stays capped to ≈5 concurrent at $20 regardless — "check-many, select-few").
--
-- The BINDING constraint is the timezone, NOT forecasts: auto-discovered cities are stored with a no-DST
-- Etc/GMT±N placeholder (etcZoneForOffset), and the capture layer fail-closes on any non-DST-aware Etc/* tz
-- (isDstAwareIana, C2/C2b / ADR-OC-12) because the bot's local-noon time-stop must be DST-correct. 0066
-- corrected the 10 TRADE cities; this corrects the 35 remaining calibration ∩ Polymarket-listable cities to
-- real IANA names so they too become capturable. Each zone verified against the city's country_code/region and
-- the inverted Etc/GMT offset before authoring (e.g. lucknow Etc/GMT-6 → Asia/Kolkata UTC+5:30 — the half-hour
-- offset a fixed Etc/* zone cannot represent at all).
--
-- The `LIKE 'Etc/%'` guard makes every statement idempotent + non-clobbering (a manual/0066 correction is never
-- overwritten). No-op on a fresh/test DB (cities are discovered at runtime, not seeded) — so this never affects
-- the PGlite migration twin. No table/RPC/cron/grant change; data-only.
--
-- NOTE on the config divergence (intentional, do NOT "fix"): `BOT_DEFAULTS.cities` (core) and the 0066 config
-- mirror stay the narrow 10-city TRADE set; the prod `bot.cities` config row is widened to the ~45-city CHECK
-- set out-of-band (config-only, read live each tick — no redeploy). check-wide vs trade-narrow legitimately
-- differ; the 0066 mirror's `on conflict do nothing` will not clobber the prod override. See BUILD-STATE.md.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
update public.cities set tz = 'Europe/Istanbul',                  updated_at = now() where slug = 'ankara'        and tz like 'Etc/%';
update public.cities set tz = 'America/New_York',                 updated_at = now() where slug = 'atlanta'       and tz like 'Etc/%';
update public.cities set tz = 'America/Chicago',                  updated_at = now() where slug = 'austin'        and tz like 'Etc/%';
update public.cities set tz = 'America/Argentina/Buenos_Aires',   updated_at = now() where slug = 'buenos-aires'  and tz like 'Etc/%';
update public.cities set tz = 'Asia/Seoul',                       updated_at = now() where slug = 'busan'         and tz like 'Etc/%';
update public.cities set tz = 'Africa/Johannesburg',             updated_at = now() where slug = 'cape-town'     and tz like 'Etc/%';
update public.cities set tz = 'America/Chicago',                  updated_at = now() where slug = 'chicago'       and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',                    updated_at = now() where slug = 'chongqing'     and tz like 'Etc/%';
update public.cities set tz = 'America/Chicago',                  updated_at = now() where slug = 'dallas'        and tz like 'Etc/%';
update public.cities set tz = 'America/Denver',                   updated_at = now() where slug = 'denver'        and tz like 'Etc/%';
update public.cities set tz = 'Europe/Helsinki',                  updated_at = now() where slug = 'helsinki'      and tz like 'Etc/%';
update public.cities set tz = 'America/Chicago',                  updated_at = now() where slug = 'houston'       and tz like 'Etc/%';
update public.cities set tz = 'Asia/Riyadh',                      updated_at = now() where slug = 'jeddah'        and tz like 'Etc/%';
update public.cities set tz = 'Asia/Karachi',                     updated_at = now() where slug = 'karachi'       and tz like 'Etc/%';
update public.cities set tz = 'Europe/London',                    updated_at = now() where slug = 'london'        and tz like 'Etc/%';
update public.cities set tz = 'America/Los_Angeles',              updated_at = now() where slug = 'los-angeles'   and tz like 'Etc/%';
update public.cities set tz = 'Asia/Kolkata',                     updated_at = now() where slug = 'lucknow'       and tz like 'Etc/%';
update public.cities set tz = 'America/Mexico_City',              updated_at = now() where slug = 'mexico-city'   and tz like 'Etc/%';
update public.cities set tz = 'America/New_York',                 updated_at = now() where slug = 'miami'         and tz like 'Etc/%';
update public.cities set tz = 'Europe/Rome',                      updated_at = now() where slug = 'milan'         and tz like 'Etc/%';
update public.cities set tz = 'Europe/Berlin',                    updated_at = now() where slug = 'munich'        and tz like 'Etc/%';
update public.cities set tz = 'America/New_York',                 updated_at = now() where slug = 'nyc'           and tz like 'Etc/%';
update public.cities set tz = 'America/Panama',                   updated_at = now() where slug = 'panama-city'   and tz like 'Etc/%';
update public.cities set tz = 'America/Los_Angeles',              updated_at = now() where slug = 'san-francisco' and tz like 'Etc/%';
update public.cities set tz = 'America/Sao_Paulo',                updated_at = now() where slug = 'sao-paulo'     and tz like 'Etc/%';
update public.cities set tz = 'America/Los_Angeles',              updated_at = now() where slug = 'seattle'       and tz like 'Etc/%';
update public.cities set tz = 'Asia/Seoul',                       updated_at = now() where slug = 'seoul'         and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',                    updated_at = now() where slug = 'shenzhen'      and tz like 'Etc/%';
update public.cities set tz = 'Asia/Singapore',                   updated_at = now() where slug = 'singapore'     and tz like 'Etc/%';
update public.cities set tz = 'Asia/Taipei',                      updated_at = now() where slug = 'taipei'        and tz like 'Etc/%';
update public.cities set tz = 'Asia/Tokyo',                       updated_at = now() where slug = 'tokyo'         and tz like 'Etc/%';
update public.cities set tz = 'America/Toronto',                  updated_at = now() where slug = 'toronto'       and tz like 'Etc/%';
update public.cities set tz = 'Europe/Warsaw',                    updated_at = now() where slug = 'warsaw'        and tz like 'Etc/%';
update public.cities set tz = 'Pacific/Auckland',                 updated_at = now() where slug = 'wellington'    and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',                    updated_at = now() where slug = 'wuhan'         and tz like 'Etc/%';
