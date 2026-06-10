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
