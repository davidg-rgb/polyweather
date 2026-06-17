/**
 * _shared/knmi — the KNMI daggegevens client for the Amsterdam floor "truth accuracy" (migration 0043).
 *
 * Free public API (no auth, no key): the official Dutch met service's daily climate endpoint. For
 * Schiphol (EHAM = KNMI station 240) the variable TX is the day's maximum temperature in 0.1°C — the
 * decimal true high that floor "truth accuracy" scores our whole-°C call against (distinct from WU's
 * rounded integer, which resolves the market). Verified 2024-01-01→ with zero gaps / zero nulls.
 *
 * SHARED by the amsterdam-paper-trade Edge Function (daily currency) and scripts/amsterdam-truth-backfill.ts
 * (the ~880-day backfill) — the same module so the two never drift, the source-capture.ts idiom. The parser
 * is pure (unit-tested); the fetch wrapper takes the injected fetchJson (packages/io — timeout/retry/JSON).
 */

export const KNMI_DAGGEGEVENS_URL = 'https://www.daggegevens.knmi.nl/klimatologie/daggegevens';
/** Schiphol (EHAM) — KNMI station 240. */
export const KNMI_SCHIPHOL_STATION = 240;
/** The provenance tag stored in amsterdam_truth.source. */
export const KNMI_TRUTH_SOURCE = 'knmi-240';

export interface KnmiTxRow {
  /** Station-local day, YYYY-MM-DD. */
  dateLocal: string;
  /** Daily max in °C at 0.1° resolution (KNMI TX tenths ÷ 10): TX 215 → 21.5. */
  txTenthsC: number;
}

/** Raw KNMI daggegevens row (fmt=json): { station_code, date: ISO, TX: tenths°C | null }. */
interface KnmiRawRow {
  station_code?: number;
  date?: string;
  TX?: number | null;
}

/**
 * Parse a KNMI daggegevens JSON payload into {dateLocal, txTenthsC}. Drops rows with a null/absent TX
 * (KNMI returns null for an unmeasured day) and malformed rows. Pure + total — `[]` on a non-array payload.
 */
export function parseKnmiTx(payload: unknown): KnmiTxRow[] {
  if (!Array.isArray(payload)) return [];
  const out: KnmiTxRow[] = [];
  for (const raw of payload as KnmiRawRow[]) {
    if (!raw || typeof raw.date !== 'string') continue;
    const tx = raw.TX;
    if (tx == null || !Number.isFinite(tx)) continue;
    out.push({ dateLocal: raw.date.slice(0, 10), txTenthsC: tx / 10 });
  }
  return out;
}

/** YYYY-MM-DD → YYYYMMDD (the KNMI start/end param format). */
function compact(date: string): string {
  return date.replace(/-/g, '');
}

export type FetchJsonLike = (
  url: string,
  init?: RequestInit,
  opts?: { timeoutMs?: number; retries?: number; backoffMs?: number },
) => Promise<unknown>;

/**
 * Fetch KNMI daily-max (TX) for Schiphol over [from, to] inclusive (YYYY-MM-DD). One POST returns the whole
 * range as a JSON array; the endpoint handled ~900 days in a single call in testing. Throws (via fetchJson)
 * on an exhausted/!ok upstream — callers in the cron path catch it as non-fatal.
 */
export async function fetchKnmiTx(
  fetchJson: FetchJsonLike,
  from: string,
  to: string,
  opts: { station?: number; timeoutMs?: number; retries?: number } = {},
): Promise<KnmiTxRow[]> {
  const station = opts.station ?? KNMI_SCHIPHOL_STATION;
  const body = `start=${compact(from)}&end=${compact(to)}&vars=TX&stns=${station}&fmt=json`;
  const payload = await fetchJson(
    KNMI_DAGGEGEVENS_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    { timeoutMs: opts.timeoutMs, retries: opts.retries },
  );
  return parseKnmiTx(payload);
}
