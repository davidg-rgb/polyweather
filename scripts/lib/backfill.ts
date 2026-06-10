/**
 * scripts/lib/backfill — shared progress + budget machinery for the §6.22
 * backfill CLIs. All backfills are resumable via backfill_progress (§7.20:
 * PK (script, scope), cursor = last COMPLETED unit) and budget-aware via a
 * persisted per-UTC-day weighted-call counter (scope '_budget:{day}') with a
 * sleep-until-midnight budgeter (the free-tier "sleeps & resumes" behavior).
 */
import type { ScriptDb } from './script-db.ts';

export type Db = Pick<ScriptDb, 'query'>;

// --- date helpers (UTC-date ISO strings throughout) --------------------------

export const todayUTC = (now: Date): string => now.toISOString().slice(0, 10);

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function listDatesISO(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysISO(d, 1)) out.push(d);
  return out;
}

/** Split [start, end] into ≤spanDays chunks (inclusive bounds). */
export function chunkRanges(start: string, end: string, spanDays: number): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let s = start;
  while (s <= end) {
    const e = addDaysISO(s, spanDays - 1);
    out.push({ start: s, end: e <= end ? e : end });
    s = addDaysISO(s, spanDays);
  }
  return out;
}

// --- backfill_progress (§7.20) ----------------------------------------------

export interface Progress {
  cursor: string | null;
  status: string | null;
  weighted: number;
}

export async function getProgress(db: Db, script: string, scope: string): Promise<Progress> {
  const [row] = await db.query<{ cursor: string | Date | null; status: string | null; weighted_calls_used: string | null }>(
    `select cursor, status, weighted_calls_used from backfill_progress where script = $1 and scope = $2`,
    [script, scope],
  );
  if (!row) return { cursor: null, status: null, weighted: 0 };
  const cursor =
    row.cursor === null ? null : row.cursor instanceof Date ? row.cursor.toISOString().slice(0, 10) : String(row.cursor).slice(0, 10);
  return { cursor, status: row.status, weighted: Number(row.weighted_calls_used ?? 0) };
}

export async function setProgress(
  db: Db,
  script: string,
  scope: string,
  cursor: string | null,
  status: string,
  addWeight: number = 0,
): Promise<void> {
  await db.query(
    `insert into backfill_progress (script, scope, cursor, status, weighted_calls_used)
     values ($1, $2, $3, $4, $5)
     on conflict (script, scope) do update
       set cursor = excluded.cursor, status = excluded.status,
           weighted_calls_used = backfill_progress.weighted_calls_used + $5,
           updated_at = now()`,
    [script, scope, cursor, status, addWeight],
  );
}

// --- the budgeter -------------------------------------------------------------

export interface BudgetDeps {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Per-UTC-day weighted-call budget, persisted to backfill_progress
 * (scope '_budget:{day}') so a killed run never double-spends. spend() blocks
 * (sleeps to the next UTC midnight) when the day's budget would be exceeded —
 * the §6.22 "the budgeter sleeps & resumes" semantics.
 */
export class DayBudget {
  private loadedDay: string | null = null;
  private spent = 0;

  constructor(
    private readonly db: Db,
    private readonly script: string,
    private readonly limit: number,
    private readonly deps: BudgetDeps,
  ) {
    if (limit <= 0) throw new Error(`--budget must be positive, got ${limit}`);
  }

  private async load(day: string): Promise<void> {
    const p = await getProgress(this.db, this.script, `_budget:${day}`);
    this.spent = p.weighted;
    this.loadedDay = day;
  }

  async spend(weight: number): Promise<void> {
    if (weight > this.limit) {
      throw new Error(`single call weight ${weight} exceeds the daily budget ${this.limit} — raise --budget`);
    }
    let day = todayUTC(this.deps.now());
    if (this.loadedDay !== day) await this.load(day);

    while (this.spent + weight > this.limit) {
      const now = this.deps.now();
      const nextMidnight = new Date(`${addDaysISO(todayUTC(now), 1)}T00:00:00Z`);
      const ms = nextMidnight.getTime() - now.getTime() + 1_000;
      this.deps.log(
        `budget: ${this.spent.toFixed(1)}/${this.limit} weighted calls used for ${day} — sleeping ${(ms / 60_000).toFixed(0)} min until the next UTC day`,
      );
      await this.deps.sleep(ms);
      day = todayUTC(this.deps.now());
      await this.load(day);
    }

    this.spent += weight;
    await setProgress(this.db, this.script, `_budget:${day}`, null, 'budget', weight);
  }
}

// --- tiny CLI arg helpers -------------------------------------------------------

export function splitList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
