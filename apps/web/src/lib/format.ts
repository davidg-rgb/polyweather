/**
 * Display helpers (§6.21) — every loader payload arrives through jsonb, so
 * numerics may be JS numbers OR numeric-column strings; everything here
 * coerces defensively and renders '—' for absent values.
 */

/** Loose → number | null (null/undefined/'' stay null; NaN → null). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function fmtUsd(v: unknown, dp = 2): string {
  const n = num(v);
  if (n === null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

/** Fraction → percent: fmtPct(0.0735) = '7.35%'. */
export function fmtPct(v: unknown, dp = 2): string {
  const n = num(v);
  return n === null ? '—' : `${(n * 100).toFixed(dp)}%`;
}

/** Probability/price at 3 decimals: fmtProb(0.55) = '0.550'. */
export function fmtProb(v: unknown): string {
  const n = num(v);
  return n === null ? '—' : n.toFixed(3);
}

export function fmtTemp(v: unknown, unit: string): string {
  const n = num(v);
  return n === null ? '—' : `${n}°${unit}`;
}

/** ISO/date-ish → 'YYYY-MM-DD'. */
export function fmtDate(v: unknown): string {
  if (!v) return '—';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.slice(0, 10);
}

/** ISO → compact UTC stamp 'MM-DD HH:mmZ'. */
export function fmtDateTime(v: unknown): string {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '—';
  const iso = d.toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

/** Relative age: fmtAgo(iso, now) = '4h 12m ago' | '3d ago' | 'just now'. */
export function fmtAgo(v: unknown, now: Date = new Date()): string {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '—';
  const ms = now.getTime() - d.getTime();
  if (ms < 0) return fmtDateTime(d);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}
