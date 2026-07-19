/**
 * scripts/diag-buy-lane — the BUY-TABLE LIVE lane verification tool (READ-ONLY).
 *
 * Answers, end-to-end, "why are no buys happening?" — the question a phone can't see the answer to,
 * because the deciding facts live in two invisible places: the live interlock verdict and the tick's
 * per-market SKIP reasons (which only ever go to Edge logs). This tool pulls both from prod and prints a
 * plain-English CAN-A-BUY-HAPPEN-NOW verdict.
 *
 * It re-uses the tick's OWN pure selection logic (selectBuyTableCandidates / parseBuyTableConfig imported
 * from the handler), so the candidate funnel it reports can NEVER drift from what the live tick actually does.
 *
 * SAFE BY CONSTRUCTION: SELECTs + STABLE RPCs only (the same reads the tick does). It never places an order,
 * never constructs the CLOB client, never reads or prints the wallet key, and never prints the DB password.
 * Run it as often as you like — it changes nothing.
 *
 * Run: pnpm tsx scripts/diag-buy-lane.ts   [--json]   [--cities a,b,c]
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { loadEnv } from './lib/load-env.ts';
import { parseBotConfig, type RawCaptureRow, type RawResolution } from '../packages/core/src/index.ts';
import {
  deriveEntryGate,
  parseBuyTableConfig,
  selectBuyTableCandidates,
  type BuyTableCandidate,
  type BuyTableCfg,
  type BuyTableEntryRow,
  type BuyTableSkip,
} from '../supabase/functions/buy-table-tick/handler.ts';

// ── pure, unit-tested helpers ────────────────────────────────────────────────────────────────────────

/** A skip reason string is `"<tag> (<detail>)"` or `"<tag> — …"`; the tag before the first ' (' / ' —' / ':'. */
export function skipTag(reason: string): string {
  const m = /^([a-z_]+)/i.exec(reason.trim());
  return m?.[1] ?? 'other';
}

/** Histogram of skip reasons by tag, most-common first — the funnel's "why nothing qualified". */
export function summarizeSkips(skips: BuyTableSkip[]): Array<{ tag: string; n: number }> {
  const counts = new Map<string, number>();
  for (const s of Array.isArray(skips) ? skips : []) {
    const t = skipTag(s.reason);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

/**
 * The soonest UTC instant a currently-too-far market (hoursToClose > leadMax) enters the [leadMin, leadMax]
 * buy window — i.e. resolvesAt − leadMax. Returns null if no future opening is computable. Markets already
 * inside or past the window are ignored (they are handled by the candidate pass itself).
 */
export function nextWindowOpen(
  markets: Array<{ resolvesAtMs: number; hoursToClose: number }>,
  cfg: { leadMinH: number; leadMaxH: number },
  nowMs: number,
): number | null {
  let soonest: number | null = null;
  for (const m of markets) {
    if (!(m.hoursToClose > cfg.leadMaxH)) continue; // only the "too far" ones will open later
    const openAt = m.resolvesAtMs - cfg.leadMaxH * 3_600_000;
    if (openAt > nowMs && (soonest == null || openAt < soonest)) soonest = openAt;
  }
  return soonest;
}

export interface LaneVerdict {
  canBuyNow: boolean;
  blockers: string[];
  notes: string[];
}

/**
 * Combine the three independent gates into one verdict:
 *   config mode → interlock preflight → is there a candidate this tick.
 * `preflightOk` is the trade_live_preflight('buy-table').ok the live tick reads; `preflightReasons` its reasons.
 */
export function buyLaneVerdict(args: {
  mode: string;
  tickEnabled: boolean;
  preflightOk: boolean;
  preflightReasons: string[];
  candidateCount: number;
  topSkips: Array<{ tag: string; n: number }>;
  nextWindowOpenIso: string | null;
  /** 0102 rule 2: a real fill exists and stop_after_first_success is on — by-design halt, not a fault. */
  laneHalted?: boolean;
}): LaneVerdict {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (!args.tickEnabled) blockers.push("config buy_table.tick_enabled='false' — the tick no-ops entirely");
  if (args.laneHalted) {
    blockers.push(
      'lane halted BY RULE — a successful buy exists and buy_table.stop_after_first_success is on ' +
        '(the verification goal is met; flip the flag to false to buy again)',
    );
  }
  if (args.mode !== 'live') blockers.push(`trade_config.mode='${args.mode}' — needs 'live' (else dry-run/off: never posts)`);
  if (args.mode === 'live' && !args.preflightOk) {
    for (const r of args.preflightReasons.length ? args.preflightReasons : ['preflight not ok'])
      blockers.push(`interlock: ${r}`);
  }
  if (args.candidateCount === 0) {
    const top = args.topSkips[0];
    const why = top ? `${top.tag} (${top.n} markets)` : 'no markets in the capture stream';
    const when = args.nextWindowOpenIso ? `; next buy-window opens ~${args.nextWindowOpenIso}` : '';
    blockers.push(`no candidate this tick — dominant skip: ${why}${when}`);
  }

  // TRADE_MODE is an EDGE secret this local tool cannot read — name it so a green DB state is not misread as "will post".
  notes.push(
    'The Edge secret TRADE_MODE must also be "live" for a REAL post (a separate gate from trade_config.mode; ' +
      'dry-run records the intent but never posts). This tool cannot read Edge secrets — verify via a successful live post or the smoke test.',
  );

  const canBuyNow =
    args.tickEnabled && !args.laneHalted && args.mode === 'live' && args.preflightOk && args.candidateCount > 0;
  return { canBuyNow, blockers, notes };
}

// ── prod reads + report ──────────────────────────────────────────────────────────────────────────────

const fmt = (v: unknown) => JSON.stringify(v, null, 2);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString().replace('.000Z', 'Z'));

interface Report {
  now: string;
  config: Record<string, unknown>;
  buyTableCfg: BuyTableCfg;
  interlock: { ok: boolean; reasons: string[]; checks: Record<string, unknown> };
  gate: { override: unknown; latestForwardGate: unknown };
  funnel: {
    captures: number;
    events: number;
    candidateCount: number;
    candidates: BuyTableCandidate[];
    skipHistogram: Array<{ tag: string; n: number }>;
    perMarket: Array<{ ref: string; hoursToClose: number | null; skip: string }>;
    nextWindowOpenIso: string | null;
  };
  tick: { recentRuns: unknown[] };
  ledger: { openLive: unknown[]; danglingLiveIntents: unknown[]; recentBuyTable: unknown[] };
  verdict: LaneVerdict;
}

export async function buildReport(sql: ReturnType<typeof postgres>, citiesOverride: string[] | null): Promise<Report> {
  const nowRow = (await sql`select now() as n`)[0] as { n: Date };
  const now = new Date(nowRow.n);

  // config + parsed cfg (the tick's own parsers)
  const configRows = (await sql`select key, value from config`) as unknown as { key: string; value: string }[];
  const buyTableCfg = parseBuyTableConfig(configRows);
  const botCfg = parseBotConfig(configRows);

  const tc = (await sql`select mode, active_until, stake_per_buy_usd, per_position_cap_usd, city_allowlist, updated_at
                        from trade_config where id = 1`)[0] as Record<string, unknown>;
  const mode = String(tc.mode ?? 'off');
  const allowlist =
    citiesOverride && citiesOverride.length
      ? citiesOverride
      : Array.isArray(tc.city_allowlist) && (tc.city_allowlist as string[]).length
        ? (tc.city_allowlist as string[])
        : botCfg.cities;
  const stakeUsd = Number(tc.stake_per_buy_usd ?? 5);

  // interlock verdict — exactly what the tick reads
  const pfRow = (await sql`select public.trade_live_preflight('buy-table') as pf`)[0] as { pf: any };
  const interlock = {
    ok: pfRow.pf?.ok === true,
    reasons: Array.isArray(pfRow.pf?.reasons) ? pfRow.pf.reasons : [],
    checks: pfRow.pf?.checks ?? {},
  };

  const override = (await sql`select reason, created_at, expires_at, (expires_at > now()) as active
                              from trade_gate_override order by created_at desc, id desc limit 1`)[0] ?? null;
  const latestForwardGate = (await sql`select label, computed_at from bot_gate_snapshot
                                       where mode='paper' and source='forward'
                                       order by computed_at desc, id desc limit 1`)[0] ?? null;

  // discovery + entries — the SAME RPCs the tick calls
  const capRow = (await sql`select public.convergence_capture_inputs(2, ${allowlist}::text[]) as env`)[0] as {
    env: { captures?: RawCaptureRow[]; resolutions?: RawResolution[] } | null;
  };
  const captures: RawCaptureRow[] = Array.isArray(capRow.env?.captures) ? capRow.env!.captures! : [];
  const resolutions: RawResolution[] = Array.isArray(capRow.env?.resolutions) ? capRow.env!.resolutions! : [];

  const entRow = (await sql`select public.buy_table_entries('live') as env`)[0] as {
    env: { rows?: BuyTableEntryRow[] } | null;
  };
  const entries: BuyTableEntryRow[] = entRow.env?.rows ?? [];

  // 0111: the dead-bucket floor read — the SAME RPC + keying the tick uses (fail-open on absence/error).
  const floors: Record<string, number> = {};
  try {
    const cities = [...new Set(captures.map((r) => String(r.city ?? '').trim().toLowerCase()).filter((s) => s !== ''))];
    const dates = [...new Set(captures.map((r) => r.targetDate).filter((d): d is string => d != null))];
    if (cities.length > 0 && dates.length > 0) {
      const fRow = (await sql`select public.buy_table_intraday_floor(${cities}::text[], ${dates}::date[]) as env`)[0] as {
        env: { floors?: Array<{ city?: string; targetDate?: string; maxTenthsC?: unknown }> } | null;
      };
      for (const f of fRow.env?.floors ?? []) {
        const max = Number(f.maxTenthsC);
        if (typeof f.city === 'string' && typeof f.targetDate === 'string' && Number.isFinite(max)) {
          floors[`${f.city.trim().toLowerCase()}|${f.targetDate}`] = max;
        }
      }
    }
  } catch {
    /* pre-0111 or transient — the gate is off, exactly like the tick */
  }

  // the funnel — the tick's OWN pure gate + selector, byte-for-byte (0102 entry rules included)
  const gate = deriveEntryGate(entries, buyTableCfg);
  const { candidates, skips } = selectBuyTableCandidates({
    captures,
    resolutions,
    existingIntentKeys: gate.blockedIntentKeys,
    cfg: buyTableCfg,
    stakeUsd,
    minOrderSizeShares: botCfg.minOrderSizeShares,
    now,
    floors,
  });

  // per-market close-time view (for the window-open estimate + human read)
  const latest = new Map<string, RawCaptureRow>();
  for (const r of captures) {
    if (r?.eventId == null) continue;
    const prev = latest.get(r.eventId);
    if (!prev || Date.parse(r.capturedAt ?? '') > Date.parse(prev.capturedAt ?? '')) latest.set(r.eventId, r);
  }
  const skipByRef = new Map(skips.map((s) => [s.ref, s.reason]));
  const candByRef = new Set(candidates.map((c) => `${c.city}/${c.tradeDate}`));
  const marketRows = [...latest.values()].map((r) => {
    const resolvesAtMs = Date.parse(r.resolvesAt ?? '');
    const htc = Number.isFinite(resolvesAtMs) ? (resolvesAtMs - now.getTime()) / 3_600_000 : NaN;
    const ref = `${r.city ?? '?'}/${r.targetDate ?? '?'}`;
    return {
      ref,
      resolvesAtMs,
      hoursToClose: Number.isFinite(htc) ? Number(htc.toFixed(1)) : null,
      skip: candByRef.has(ref) ? '✅ CANDIDATE' : (skipByRef.get(ref) ?? '(no skip recorded)'),
    };
  });
  marketRows.sort((a, b) => (a.hoursToClose ?? 1e9) - (b.hoursToClose ?? 1e9));

  const nextOpenMs = nextWindowOpen(
    marketRows.filter((m) => Number.isFinite(m.resolvesAtMs)).map((m) => ({ resolvesAtMs: m.resolvesAtMs, hoursToClose: m.hoursToClose ?? -1 })),
    buyTableCfg,
    now.getTime(),
  );
  const skipHistogram = summarizeSkips(skips);

  // tick health + ledger
  const recentRuns = (await sql`select period_key, status, started_at, stats
                                from job_runs where job='buy-table-tick' order by started_at desc limit 6`) as unknown as unknown[];
  const openLive = (await sql`select mode, status, side, market_id, price, size, size_matched, order_id, created_at
                              from live_orders where mode='live' and status in ('intent','placed','partial')
                              order by created_at desc`) as unknown as unknown[];
  const danglingLiveIntents = (await sql`select client_order_id, market_id, price, size, created_at, reason
                                         from live_orders
                                         where mode='live' and status='intent' and order_id is null
                                         order by created_at desc`) as unknown as unknown[];
  const recentBuyTable = (await sql`select mode, status, market_id, price, size, size_matched, created_at
                                    from live_orders where strategy='buy-table' order by created_at desc limit 10`) as unknown as unknown[];

  const verdict = buyLaneVerdict({
    mode,
    tickEnabled: buyTableCfg.tickEnabled,
    preflightOk: interlock.ok,
    preflightReasons: interlock.reasons,
    candidateCount: candidates.length,
    topSkips: skipHistogram,
    nextWindowOpenIso: iso(nextOpenMs),
    laneHalted: gate.laneHalted,
  });

  return {
    now: now.toISOString(),
    config: {
      mode,
      active_until: tc.active_until,
      stake_per_buy_usd: tc.stake_per_buy_usd,
      city_allowlist: tc.city_allowlist,
      allowlist_used: allowlist,
      priceCap: buyTableCfg.priceCap,
      leadWindowH: [buyTableCfg.leadMinH, buyTableCfg.leadMaxH],
      tick_enabled: buyTableCfg.tickEnabled,
      maxEntryAttempts: buyTableCfg.maxEntryAttempts,
      stopAfterFirstSuccess: buyTableCfg.stopAfterFirstSuccess,
      laneHalted: gate.laneHalted,
      updated_at: tc.updated_at,
    },
    buyTableCfg,
    interlock,
    gate: { override, latestForwardGate },
    funnel: {
      captures: captures.length,
      events: latest.size,
      candidateCount: candidates.length,
      candidates,
      skipHistogram,
      perMarket: marketRows.map(({ resolvesAtMs, ...rest }) => rest),
      nextWindowOpenIso: iso(nextOpenMs),
    },
    tick: { recentRuns },
    ledger: { openLive, danglingLiveIntents, recentBuyTable },
    verdict,
  };
}

function printHuman(rep: Report): void {
  const H = (t: string) => console.log(`\n═══ ${t} ═══`);
  console.log(`buy-table LIVE lane — verification  ·  ${rep.now}`);

  H('1 · CAN A LIVE BUY HAPPEN RIGHT NOW?');
  console.log(rep.verdict.canBuyNow ? '✅ YES — every gate is open and a candidate exists this tick.' : '⛔ NO — blocked by:');
  for (const b of rep.verdict.blockers) console.log(`   • ${b}`);
  for (const n of rep.verdict.notes) console.log(`   ⓘ ${n}`);

  H('2 · CONFIG');
  console.log(fmt(rep.config));

  H('3 · INTERLOCK — trade_live_preflight(buy-table)');
  console.log(`ok: ${rep.interlock.ok}`);
  if (rep.interlock.reasons.length) console.log('reasons:', fmt(rep.interlock.reasons));
  console.log('gate override:', fmt(rep.gate.override));
  console.log('latest forward paper gate:', fmt(rep.gate.latestForwardGate));

  H('4 · CANDIDATE FUNNEL (the tick\'s own selection logic)');
  console.log(`captures=${rep.funnel.captures}  events=${rep.funnel.events}  candidates=${rep.funnel.candidateCount}`);
  console.log('skip histogram:', fmt(rep.funnel.skipHistogram));
  if (rep.funnel.nextWindowOpenIso) console.log(`next buy-window opens ~${rep.funnel.nextWindowOpenIso}`);
  console.log('per-market:');
  for (const m of rep.funnel.perMarket) console.log(`   ${m.ref.padEnd(24)} ${String(m.hoursToClose).padStart(6)}h  ${m.skip}`);

  H('5 · TICK HEALTH (job_runs, last 6)');
  console.log(fmt(rep.tick.recentRuns));

  H('6 · LEDGER — open live + dangling intents');
  console.log('open live orders:', fmt(rep.ledger.openLive));
  console.log('dangling live intents (order_id null — never confirmed at venue):', fmt(rep.ledger.danglingLiveIntents));
}

async function main(): Promise<number> {
  loadEnv();
  const { values } = parseArgs({ args: process.argv.slice(2), options: { json: { type: 'boolean', default: false }, cities: { type: 'string' } }, strict: false });
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL not set (add it to .env.local — see scripts/check-db.ts).');
    return 1;
  }
  const cities = typeof values.cities === 'string' ? values.cities.split(',').map((c) => c.trim()).filter(Boolean) : null;
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20, idle_timeout: 3 });
  try {
    const rep = await buildReport(sql, cities);
    if (values.json) console.log(JSON.stringify(rep, null, 2));
    else printHuman(rep);
    return 0;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('diag-buy-lane crashed:', e?.message ?? e);
      process.exit(1);
    });
}
