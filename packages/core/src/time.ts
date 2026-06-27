/**
 * core/time — local-day & lead arithmetic (ARCHITECTURE.md §6.1).
 *
 * The single authority for "what local day is it at this station". Every other
 * module that touches dates calls this; nothing else may do timezone math
 * (§11.3 time law: no toLocaleString/manual offset arithmetic anywhere else).
 */
import { TZDate } from '@date-fns/tz';
import { InvalidTimezoneError, ValidationError } from './errors.ts';

const DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Cache of validated IANA zone names — Intl lookup is not free and tz strings repeat heavily. */
const knownZones = new Set<string>();

function assertTimezone(tz: string): void {
  if (knownZones.has(tz)) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new InvalidTimezoneError(`unknown IANA timezone: '${tz}'`, { tz });
  }
  knownZones.add(tz);
}

function parseDateISO(dateISO: string): { y: number; m: number; d: number } {
  if (!DATE_ISO_RE.test(dateISO)) {
    throw new ValidationError(`dateISO must be 'YYYY-MM-DD', got '${dateISO}'`, { dateISO });
  }
  const y = Number(dateISO.slice(0, 4));
  const m = Number(dateISO.slice(5, 7));
  const d = Number(dateISO.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new ValidationError(`dateISO out of range: '${dateISO}'`, { dateISO });
  }
  return { y, m, d };
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

/**
 * UTC half-open interval [00:00, 24:00) of the local calendar day — the
 * WU/Polymarket window. Correct across DST transitions (23h/25h days).
 */
export function localDayWindow(tz: string, dateISO: string): { startUtc: Date; endUtc: Date } {
  assertTimezone(tz);
  const { y, m, d } = parseDateISO(dateISO);
  const startUtc = new Date(new TZDate(y, m - 1, d, 0, 0, 0, 0, tz).getTime());
  // Normalize day+1 through Date.UTC so month/year overflow is handled before
  // the wall-clock → instant mapping.
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const endUtc = new Date(
    new TZDate(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), 0, 0, 0, 0, tz).getTime(),
  );
  return { startUtc, endUtc };
}

/** The local calendar date ('YYYY-MM-DD') at a given instant — decides "is this obs part of day D". */
export function localDateAt(tz: string, instant: Date): string {
  assertTimezone(tz);
  const local = new TZDate(instant.getTime(), tz);
  return `${pad(local.getFullYear(), 4)}-${pad(local.getMonth() + 1, 2)}-${pad(local.getDate(), 2)}`;
}

/**
 * Whole-day lead time relative to the station's local calendar:
 * 0 = target day in progress locally; 1 = locally tomorrow; … ; −1 = target
 * day already over locally (all past days collapse to −1).
 */
export function leadDays(nowUtc: Date, targetDateISO: string, tz: string): number {
  const target = parseDateISO(targetDateISO);
  const today = parseDateISO(localDateAt(tz, nowUtc));
  const diffDays = Math.round(
    (Date.UTC(target.y, target.m - 1, target.d) - Date.UTC(today.y, today.m - 1, today.d)) / 86_400_000,
  );
  return diffDays < 0 ? -1 : diffDays;
}

/** Gate for actuals fetching: true once nowUtc ≥ endUtc of the local day. */
export function isLocalDayOver(tz: string, dateISO: string, nowUtc: Date): boolean {
  return nowUtc.getTime() >= localDayWindow(tz, dateISO).endUtc.getTime();
}

/** 0–23 local hour — daytime station selection for METAR polling; lift-table row index. */
export function localHour(tz: string, instant: Date): number {
  assertTimezone(tz);
  return new TZDate(instant.getTime(), tz).getHours();
}

/**
 * Is `tz` a real, DST-aware IANA zone name (NOT a fixed-offset `Etc/GMT±N` zone, NOT junk)?
 *
 * The discovery seam stores auto-found cities as `etcZoneForOffset(offset)` = a no-DST `Etc/GMT±N`
 * (risk.ts) — which `assertTimezone` ACCEPTS (Intl-valid) but which DST-skews a local-wall-clock
 * instant by ≤1h on the two transition days/yr (the 2026-06-22 trap; ADR-OC-12 / C2b). The
 * opening-convergence bot's time-stop must be DST-correct, so its tz read fail-closes on anything
 * that is not a real IANA name: a capture whose `cities.tz` is absent or `Etc/*` stores `no_tz` and
 * is never entered. Pure + total — never throws (the no-throw twin of `localHourInstant`'s guard).
 */
export function isDstAwareIana(tz: string | null | undefined): boolean {
  if (!tz || tz.startsWith('Etc/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return false;
  }
  return true;
}

/**
 * The UTC instant of local wall-clock `hour:00:00` on the station-local calendar day `dateISO`,
 * in the real IANA zone `tz` — DST-correct by the same `TZDate(y, m−1, d, hour, …, tz)` mechanism
 * `localDayWindow`'s `startUtc` uses (time.ts:48), NOT `localDayWindow(...).startUtc + hour×3600s`
 * (adding a fixed offset to local MIDNIGHT is DST-wrong by ±1h on the two transition days/yr — F11).
 *
 * This is the opening-convergence bracket time-stop's "flatten by local noon" instant. It REJECTS
 * fixed-offset `Etc/*` zones AND non-IANA strings (throws `InvalidTimezoneError`) so the bot never
 * computes a DST-skewed flatten time — bracketDecision catches the throw and fails toward a
 * conservative time_stop (ADR-OC-12 fail-closed), though such positions are never entered because
 * the capture-side `isDstAwareIana` gate already excludes them.
 */
export function localHourInstant(tz: string, dateISO: string, hour: number): Date {
  if (tz.startsWith('Etc/')) {
    throw new InvalidTimezoneError(`fixed-offset zone not allowed for DST-sensitive math: '${tz}'`, { tz });
  }
  assertTimezone(tz);
  if (hour < 0 || hour > 23 || !Number.isInteger(hour)) {
    throw new ValidationError(`hour must be an integer 0–23, got '${hour}'`, { hour });
  }
  const { y, m, d } = parseDateISO(dateISO);
  return new Date(new TZDate(y, m - 1, d, hour, 0, 0, 0, tz).getTime());
}
