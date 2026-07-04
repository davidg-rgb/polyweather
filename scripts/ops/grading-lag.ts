/**
 * scripts/ops/grading-lag — gate-day helper: resolved-but-ungraded markets in the forward panel window (N5, FASTTRACK-PLAN).
 *
 * READ-ONLY. Support for GATE-DAY-PLAYBOOK.md "Package 3 — INSUFFICIENT at (or near) 7 days", check #1:
 * distinguish GRADING LAG from genuine DATA LOSS. When `n_distinct_days` on `dash_maker_exit()` sits at or
 * drops below the 7-day sufficiency floor, the first question is whether the missing day's markets have actually
 * RESOLVED in the real world (their `target_date` has passed) but have not yet been GRADED into our system
 * (`winning_bucket_idx` / `poly_resolved_winner_idx` still null) — that is lag, and it self-heals on the next
 * tick once fetch-actuals/grading catch up. This script lists exactly those markets and, per distinct day,
 * whether grading them would ADD a distinct day to the panel window ("day N would join at grading") or merely
 * add markets to a day already counted.
 *
 * SCOPE: the panel gate counts only cities in `bot.cities` (the ~45-city capture universe the maker-exit-panel
 * runs over, `parseBotConfig(...).cities` — the exact same source of truth the panel uses). By default this
 * helper scopes to that set, so the distinct-day impact matches what `n_distinct_days` would actually move to.
 * `--all-cities` shows lag across every city regardless of gate scope.
 *
 * WINDOW: the panel look-back is PANEL_DAYS (21). "Passed" = `target_date < current_date` in the DB's tz (UTC),
 * so a station east of UTC can lag up to its offset before its just-ended local day appears here — conservative
 * by design (never flags a day as resolved before UTC agrees it is over). `--days N` overrides the window.
 *
 * This is analytics only — it never writes, never trades, never touches credentials. The bot rail stays DORMANT.
 *
 * Run: pnpm tsx scripts/ops/grading-lag.ts               # scope = bot.cities, window = 21 days (read-only)
 *      pnpm tsx scripts/ops/grading-lag.ts --all-cities  # every city, ignore the gate scope
 *      pnpm tsx scripts/ops/grading-lag.ts --days 30     # widen the look-back window
 *      pnpm tsx scripts/ops/grading-lag.ts --json        # machine-readable report
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';
import { parseBotConfig } from '../../packages/core/src/sim/opening-convergence.ts';

/** the forward maker-exit / convergence panel look-back window (matches PANEL_DAYS in both panel handlers). */
export const PANEL_DAYS = 21;

/** One market_event whose target date falls inside the panel window (passed but within PANEL_DAYS). */
export interface WindowMarket {
  eventId: string;
  polyEventId: string;
  /** cities.slug — the same key `bot.cities` is expressed in. */
  city: string;
  targetDate: string;
  /** set when we mark the event resolved; may be null even for a passed day if grading has not run at all. */
  resolvedAt: string | null;
  closed: boolean;
  /** graded = a winner is known (coalesce(winning_bucket_idx, poly_resolved_winner_idx) is not null). */
  graded: boolean;
}

/** Per-day view of the ungraded markets: how many, which cities, and whether grading them adds a NEW panel day. */
export interface DayImpact {
  targetDate: string;
  nUngraded: number;
  cities: string[];
  /** true → this day has ZERO graded markets in-window, so grading it increments `n_distinct_days` by 1. */
  isNewDay: boolean;
}

export interface GradingLagReport {
  panelDays: number;
  /** the gate scope applied (bot.cities), or null when `--all-cities` / config was unreadable. */
  scopeCities: string[] | null;
  /** the resolved-but-ungraded markets (in scope), the raw listing. */
  ungraded: WindowMarket[];
  /** per distinct ungraded day, sorted ascending. */
  days: DayImpact[];
  /** count of `isNewDay` days — the increment to `n_distinct_days` once grading catches up (the headline number). */
  newDaysAtGrading: number;
}

/**
 * All market_events whose target date has PASSED (`< current_date`) yet is still within the PANEL_DAYS window,
 * graded or not — the pure report builder partitions them. Read-only; ordered for a stable listing.
 */
export async function findWindowMarkets(db: ScriptDb, panelDays = PANEL_DAYS): Promise<WindowMarket[]> {
  return db.query<WindowMarket>(
    `select me.id::text          as "eventId",
            me.poly_event_id     as "polyEventId",
            c.slug               as "city",
            me.target_date::text as "targetDate",
            me.resolved_at::text as "resolvedAt",
            me.closed            as "closed",
            (coalesce(me.winning_bucket_idx, me.poly_resolved_winner_idx) is not null) as "graded"
       from public.market_events me
       join public.cities c on c.id = me.city_id
      where me.target_date >= current_date - $1::int
        and me.target_date <  current_date
      order by me.target_date, c.slug`,
    [panelDays],
  );
}

/**
 * Pure: partition the window markets by grade, apply the gate scope, and compute the distinct-day impact.
 * `scopeCities === null` means "all cities" (no gate scope). A day is `isNewDay` when it currently has NO graded
 * market in-window — grading its ungraded markets would then add a fresh `n_distinct_days`; a day that already
 * has ≥1 graded market only gains markets, not a distinct day.
 */
export function buildGradingLagReport(
  markets: WindowMarket[],
  panelDays: number,
  scopeCities: string[] | null,
): GradingLagReport {
  const scope = scopeCities ? new Set(scopeCities) : null;
  const inScope = scope ? markets.filter((m) => scope.has(m.city)) : markets;
  const gradedDays = new Set(inScope.filter((m) => m.graded).map((m) => m.targetDate));
  const ungraded = inScope.filter((m) => !m.graded);

  const byDay = new Map<string, WindowMarket[]>();
  for (const m of ungraded) {
    const arr = byDay.get(m.targetDate);
    if (arr) arr.push(m);
    else byDay.set(m.targetDate, [m]);
  }
  const days: DayImpact[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([targetDate, ms]) => ({
      targetDate,
      nUngraded: ms.length,
      cities: [...new Set(ms.map((m) => m.city))].sort(),
      isNewDay: !gradedDays.has(targetDate),
    }));

  return {
    panelDays,
    scopeCities,
    ungraded,
    days,
    newDaysAtGrading: days.filter((d) => d.isNewDay).length,
  };
}

/** bot.cities via the panel's own parser (falls back to code defaults when the row is absent); null on read failure. */
async function loadScopeCities(db: ScriptDb): Promise<string[] | null> {
  try {
    const rows = await db.query<{ key: string; value: string | null }>('select key, value from config');
    const cities = parseBotConfig(rows).cities;
    return Array.isArray(cities) && cities.length > 0 ? cities : null;
  } catch {
    return null;
  }
}

function printReport(r: GradingLagReport): void {
  const scopeLabel =
    r.scopeCities === null ? 'ALL cities (no gate scope)' : `bot.cities (${r.scopeCities.length} cities)`;
  console.log(`grading-lag — resolved-but-ungraded markets in the forward panel window (PANEL_DAYS=${r.panelDays}):`);
  console.log(`scope: ${scopeLabel}\n`);

  if (r.ungraded.length === 0) {
    console.log('  (none) — every passed-target_date market in the window is graded. No grading lag.');
    return;
  }
  for (const m of r.ungraded) {
    console.log(
      `  ${m.targetDate}  ${m.city.padEnd(16)} closed=${m.closed ? 't' : 'f'}  ` +
        `resolved_at=${(m.resolvedAt ?? '(null)').padEnd(26)}  ${m.polyEventId}`,
    );
  }

  console.log('\nDISTINCT-DAY IMPACT (what grading these would do to n_distinct_days):');
  for (const d of r.days) {
    const mkt = `${d.nUngraded} ungraded market${d.nUngraded === 1 ? '' : 's'}`;
    const city = `${d.cities.length} cit${d.cities.length === 1 ? 'y' : 'ies'}`;
    const verdict = d.isNewDay
      ? 'NEW DAY (not yet in panel) ← would +1 distinct day at grading'
      : 'already graded in panel (grading adds markets only)';
    console.log(`  ${d.targetDate}  ${mkt.padEnd(20)} · ${city.padEnd(9)} · ${verdict}`);
  }
  console.log(
    `\nTOTAL: ${r.ungraded.length} ungraded market${r.ungraded.length === 1 ? '' : 's'} across ` +
      `${r.days.length} distinct day${r.days.length === 1 ? '' : 's'} · newDaysAtGrading = ${r.newDaysAtGrading}`,
  );
  console.log('(newDaysAtGrading is the increment n_distinct_days would take once grading catches up — GATE-DAY-PLAYBOOK.md Package 3 #1.)');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      'all-cities': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const panelDays = values.days !== undefined ? Math.max(1, Math.floor(Number(values.days))) : PANEL_DAYS;
  if (!Number.isFinite(panelDays)) throw new Error(`--days must be a number (got "${values.days}")`);

  loadEnv();
  const db = makeScriptDb();
  try {
    const scopeCities = values['all-cities'] ? null : await loadScopeCities(db);
    const markets = await findWindowMarkets(db, panelDays);
    const report = buildGradingLagReport(markets, panelDays, scopeCities);
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
