/**
 * daily-digest — the operator's morning Slack INFO (ARCHITECTURE.md §6.19).
 * Schedule: 0 7 * * *.
 *
 * Sections: bankroll + Δ24h · yesterday's resolutions (city, winner, our q,
 * market p, bet results) · open recommendations · rolling 30d Brier
 * house-vs-market (top/bottom 5 cities) · hit-rate-by-edge-decile (§11.4
 * fidelity tracking) · breaker states · job health one-liner. The first
 * digest of each month in live mode appends the withdrawal-discipline
 * reminder (F-036) — the same cadence the goLiveGate's ledgerReconciledAt
 * attestation expects.
 */
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface DigestDeps {
  notify: (alert: Alert) => Promise<boolean>;
  now: Date;
}

interface DigestData {
  bankroll: number;
  bankrollPrev: number;
  resolutions: {
    slug: string;
    city: string;
    unit: string;
    resolutionNative: number | null;
    winnerLabel: string | null;
    ourQ: number | null;
    marketP: number | null;
    bets: { status: string; pnl: number | null; stake: number | null }[];
  }[];
  openRecs: { n: number; totalStake: number };
  brierByCity: { city: string; house: number | null; market: number | null; n: number | null; diff: number }[];
  edgeDeciles: { decile: number; n: number; hitRate: number; avgEdge: number; pnl: number | null }[];
  halts: string[];
  jobs24h: { ok: number; failed: number };
  // 0092 additions — the post-pivot forward instruments (null/empty on a pre-0092 DB).
  monitor: {
    asOf: string;
    capturedAt: string;
    s1: {
      label: string | null;
      nMarkets: number | null;
      nCities: number | null;
      nDistinctDays: number | null;
      meanNetReturn: number | null;
      ciLow: number | null;
      ciHigh: number | null;
    };
    s2: { label: string | null; nMarkets: number | null };
  } | null;
  cityLedger: {
    graded24h: { n: number; won: number; pnl: number };
    placedToday: { icao: string; arm: number; ask: number }[];
    lifetime: { n: number; pnl: number };
  } | null;
  whales24h: { n: number; top: { title: string | null; notional: number; side: string | null; slug: string | null }[] } | null;
}

const usd = (x: number): string => `$${x.toFixed(2)}`;
const pct = (x: number | null): string => (x === null ? '—' : `${(Number(x) * 100).toFixed(1)}%`);
/** Compact USD for whale notionals: $1.25M / $255k. */
const usdShort = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}k` : `$${Math.round(n)}`;
/** Signed percent with 2 decimals for monitor net-returns (fractions in, e.g. −0.0017 → "−0.17%"). */
const spct = (x: number | null): string => (x === null ? '—' : `${(Number(x) * 100).toFixed(2)}%`);

export async function dailyDigest(ctx: JobCtx, deps: DigestDeps): Promise<JobStats> {
  const { db, config: cfg, log } = ctx;
  const dateISO = deps.now.toISOString().slice(0, 10);

  const [row] = await db.rpc<{ digest_data: DigestData }>('digest_data', {
    p_mode: cfg.tradingMode,
    p_champion: cfg.championSource,
  });
  const d = row!.digest_data;

  const lines: string[] = [];

  const delta = Number(d.bankroll) - Number(d.bankrollPrev);
  lines.push(
    `*Bankroll (${cfg.tradingMode})*: ${usd(Number(d.bankroll))} (${delta >= 0 ? '+' : '−'}${usd(Math.abs(delta))} 24h)`,
  );

  // 0092: the post-pivot forward instruments lead the digest — they are the live analytics product; the
  // trading-era sections below mostly render empty while the rail is DORMANT.
  if (d.monitor) {
    const s1 = d.monitor.s1;
    const s1Line =
      s1.label === null
        ? 'S1 —'
        : `S1 ${s1.label} — n=${s1.nMarkets}/${s1.nCities}c/${s1.nDistinctDays}d, mean ${spct(s1.meanNetReturn)} CI [${spct(s1.ciLow)}, ${spct(s1.ciHigh)}]`;
    const s2Line = d.monitor.s2.label === null ? 'S2 —' : `S2 ${d.monitor.s2.label} (n=${d.monitor.s2.nMarkets})`;
    lines.push(`*Efficiency monitor* (as-of ${d.monitor.asOf}): ${s1Line} · ${s2Line}`);
  } else {
    lines.push(`*Efficiency monitor*: no snapshot yet`);
  }

  if (d.cityLedger) {
    const cl = d.cityLedger;
    const placed =
      cl.placedToday.length === 0
        ? 'none'
        : cl.placedToday.map((p) => `${p.icao}@${p.arm} (${Math.round(Number(p.ask) * 100)}¢)`).join(', ');
    lines.push(
      `*City paper ledger*: graded 24h ${cl.graded24h.n} (won ${cl.graded24h.won}, P&L ${usd(Number(cl.graded24h.pnl))}) · ` +
        `placed today: ${placed} · lifetime ${usd(Number(cl.lifetime.pnl))} over ${cl.lifetime.n} bets`,
    );
  }

  if (d.resolutions.length > 0) {
    lines.push(`*Yesterday's resolutions* (${d.resolutions.length}):`);
    for (const r of d.resolutions) {
      const betBits =
        r.bets.length === 0
          ? 'no bets'
          : r.bets
              .map((b) => `${b.status === 'resolved_win' ? 'WIN' : 'LOSS'} ${b.pnl === null ? '' : usd(Number(b.pnl))}`)
              .join(', ');
      lines.push(
        `• ${r.city}: ${r.winnerLabel ?? '?'} (actual ${r.resolutionNative ?? '?'}°${r.unit}) — our q ${pct(r.ourQ)} vs market ${pct(r.marketP)} — ${betBits}`,
      );
    }
  } else {
    lines.push(`*Yesterday's resolutions*: none in the last 24h`);
  }

  lines.push(`*Open recommendations*: ${d.openRecs.n} (proposed ${usd(Number(d.openRecs.totalStake))})`);

  if (d.brierByCity.length > 0) {
    // rows arrive sorted by diff ascending (house − market: negative = we beat the market)
    const top = d.brierByCity.slice(0, 5);
    const bottom = d.brierByCity.slice(-5).reverse();
    lines.push(`*30d Brier house vs market* (best 5):`);
    for (const c of top) lines.push(`• ${c.city}: ${c.house ?? '—'} vs ${c.market ?? '—'} (n=${c.n ?? 0})`);
    lines.push(`(worst 5):`);
    for (const c of bottom) lines.push(`• ${c.city}: ${c.house ?? '—'} vs ${c.market ?? '—'} (n=${c.n ?? 0})`);
  }

  if (d.edgeDeciles.length > 0) {
    lines.push(`*Hit rate by edge decile* (§11.4 adverse-selection tracker):`);
    for (const e of d.edgeDeciles) {
      lines.push(
        `• decile ${e.decile}: n=${e.n} hit ${pct(e.hitRate)} avg edge ${Number(e.avgEdge).toFixed(3)} pnl ${e.pnl === null ? '—' : usd(Number(e.pnl))}`,
      );
    }
  }

  // 0092: whales are DIGEST-ONLY — WHALE_TRADE per-print pushes retired 2026-07-10 (no actionable
  // signature at the $100k floor per the 06-24 insider scan; ~42 pushes/day of noise). Data still records.
  if (d.whales24h) {
    const w = d.whales24h;
    if (w.n > 0) {
      const top = w.top
        .map((t) => `${usdShort(Number(t.notional))} ${t.side ?? ''} _${t.title ?? t.slug ?? 'a market'}_`)
        .join(' · ');
      lines.push(`*Whales 24h*: ${w.n} large prints — top: ${top}`);
    } else {
      lines.push(`*Whales 24h*: none`);
    }
  }

  lines.push(
    d.halts.length > 0 ? `*Breakers ACTIVE*: ${d.halts.join(', ')}` : `*Breakers*: none active`,
  );
  lines.push(`*Jobs 24h*: ${d.jobs24h.ok} ok / ${d.jobs24h.failed} failed`);

  // F-036: first digest of each month in live mode — withdrawal discipline.
  const monthly = cfg.tradingMode === 'live' && deps.now.getUTCDate() === 1;
  if (monthly) {
    lines.push(
      `*Monthly reminder (F-036)*: reconcile bankroll_ledger against actual balances, ` +
        `withdraw profits above the bankroll target, and update the 'ledgerReconciledAt' config row ` +
        `(the go-live gate reads it).`,
    );
  }

  await deps.notify({
    kind: 'DAILY_DIGEST',
    severity: 'INFO',
    title: `Daily digest — ${dateISO}`,
    body: lines.join('\n'),
    dedupeKey: `digest:${dateISO}`,
  });

  const stats = {
    resolutions: d.resolutions.length,
    openRecs: Number(d.openRecs.n),
    brierCities: d.brierByCity.length,
    deciles: d.edgeDeciles.length,
    halts: d.halts.length,
    monthlyReminder: monthly,
    monitorS1: d.monitor?.s1.label ?? null,
    whales24h: d.whales24h ? Number(d.whales24h.n) : 0,
  };
  log('digest sent', stats);
  return stats;
}
