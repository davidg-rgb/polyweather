/**
 * scripts/wallet-forensics — reconstruct a Polymarket wallet's TRUE realized performance from public data
 * and prove the edge is REAL, not a /closed-positions top-50 survivorship artifact (WALLET-RECON-HANDOFF.md
 * Build #2, the skill-vs-survivorship KILL-GATE 1).
 *
 * It pulls the wallet's ground-truth cumulative realized-PnL curve (user-pnl-api) AND pages its full
 * /activity history (TRADE + REDEEM), batches market metadata via gamma, then runs the PURE forensics in
 * @weather-edge/core (sim/wallet-forensics.ts — FIFO reconstruction, daily curve, ROI-by-entry-bucket,
 * city/region attribution, Brier-vs-outcomes, PELT-lite regime change) and PRINTS:
 *
 *   - the reconstructed daily/cumulative curve tail
 *   - the RECONCILIATION LINE: reconstructed total vs user-pnl total over the SAME window (the gate; abs % diff)
 *   - ROI by entry-price bucket (the cheap-longshot <0.25 positive / 0.45-0.75 negative signature)
 *   - attribution by city + US-vs-international region
 *   - behavioral-over-time: No vs Yes share + median entry px by week
 *   - the regime breakpoint (the mid-May badatmath inflection)
 *   - the calibration block: Brier ours vs market baseline + the paired bootstrap p
 *
 * FULL LIFETIME CRAWL BY DEFAULT (no silent caps — the prime directive): the plain command pages the FULL
 * /activity history (default --max-pages 1000; badatmath needs ~186). There is NO automatic window fallback:
 * a --from window is used ONLY when the operator explicitly passes --from. If a full crawl still hits the
 * --max-pages cap, the run does NOT silently window — it surfaces the truncation LOUDLY in both modes
 * (`incomplete: true` + pages in the JSON, a stderr warning) and EXITS NON-ZERO. A capped/incomplete crawl
 * must never masquerade as a lifetime reconciliation.
 *
 * --persist writes the daily curve + per-bet calibration to migration 0050's tables (wallet_pnl_daily,
 * wallet_bet_calibration) via its idempotent record RPC. This is ANALYTICS, not trading.
 *
 * Run: pnpm tsx scripts/wallet-forensics.ts <wallet> [--persist] [--json] [--max-pages N] [--from YYYY-MM-DD]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  attribution,
  brierVsOutcomes,
  dailyPnlCurve,
  type RealizedBet,
  reconstructRealizedPnl,
  regimeChange,
  roiBelow025,
  roiByEntryBucket,
  roiMid045to075,
  utcDay,
  winRateCi,
} from '../packages/core/src/index.ts';
import { fetchJson } from '../packages/io/src/index.ts';
import {
  fetchUserPnlSeries,
  SHARP_WALLET_ADDRESS,
  type UserPnlPoint,
  type WalletActivity,
} from '../packages/io/src/polymarket-wallet.ts';
import { loadEnv } from './lib/load-env.ts';
import { crawlActivity, type PagingResult } from './lib/polymarket-crawl.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const usd = (v: number | null): string => (v === null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}`);
const pct = (v: number | null): string => (v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);
const f3 = (v: number | null): string => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(3));

/** Median of a numeric array (NaN on empty). */
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Monday-anchored ISO week-start (UTC) for a unix-seconds timestamp. */
function weekStartUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** user-pnl cumulative value as of (or just before) a given YYYY-MM-DD (UTC). null if no point at/before. */
function userPnlAtDate(series: UserPnlPoint[], date: string): number | null {
  const cutoff = Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000);
  let last: number | null = null;
  for (const p of series) {
    if (p.t <= cutoff) last = p.cumPnlUsd;
    else break;
  }
  return last;
}

/** Final (lifetime) user-pnl cumulative value. */
function userPnlFinal(series: UserPnlPoint[]): number | null {
  return series.length === 0 ? null : series[series.length - 1]!.cumPnlUsd;
}

/**
 * Detect a SILENTLY-TRUNCATED "full" crawl. The /activity offset cap forces a slide-the-window crawl; if a
 * window returns empty or 4xx (e.g. Polymarket rate-limiting under heavy use), the loop can terminate early
 * with mode='full' and exit 0 while having fetched only the most-recent slice — a partial reconstruction
 * that must never be persisted or reported as lifetime. We catch it by cross-checking the crawl's earliest
 * fetched fill against the user-pnl ground-truth curve (a single un-paged call that spans the wallet's whole
 * history): if the earliest fill is more than `toleranceDays` AFTER the wallet's first user-pnl point, the
 * crawl missed history. Pure + testable. Returns false for an explicit --from window (short by design) and
 * when there is no ground-truth curve to compare against.
 */
export function crawlMissedHistory(
  pnlSeries: UserPnlPoint[],
  windowFrom: string | null,
  mode: string,
  toleranceDays = 7,
): boolean {
  if (mode === 'window') return false; // a deliberate --from window is short on purpose
  if (pnlSeries.length === 0) return false; // no ground truth to compare against
  if (windowFrom === null) return true; // a non-window crawl that fetched nothing
  const pnlFirstDay = utcDay(pnlSeries[0]!.t);
  const gapDays =
    (Date.parse(`${windowFrom}T00:00:00Z`) - Date.parse(`${pnlFirstDay}T00:00:00Z`)) / 86_400_000;
  return gapDays > toleranceDays;
}

/** TRADE-only fills for behavioral stats (entry px / Yes-No share). */
function tradeFills(fills: WalletActivity[]): WalletActivity[] {
  return fills.filter((f) => f.type === 'TRADE' && f.side === 'BUY');
}

interface ForensicsOutput {
  wallet: string;
  window: string;
  /** TRUE when the crawl hit the --max-pages cap → the reconstruction is INCOMPLETE (not a lifetime number). */
  incomplete: boolean;
  paging: { mode: string; pagesFetched: number; hitCap: boolean; windowFrom: string | null; nFills: number };
  /** TRADING-ONLY reconstructed realized total = Σ(SELL+REDEEM+MERGE) − Σ(BUY). The headline reconciliation. */
  reconstructedTotalUsd: number;
  /** Proceeds decomposition (the like-for-like diagnostic): each component of the trading total + incentives. */
  decomposition: {
    buyCostUsd: number;
    sellProceedsUsd: number;
    redeemProceedsUsd: number;
    mergeProceedsUsd: number;
    incentivesUsd: number;
    tradingOnlyUsd: number;
    tradingPlusIncentivesUsd: number;
  };
  userPnlTotalUsd: number | null;
  /** abs % of the TRADING-ONLY total vs user-pnl (the principled headline). */
  reconciliationPctAbs: number | null;
  /** abs % of the TRADING+INCENTIVES total vs user-pnl (shown for transparency). */
  reconciliationPlusIncentivesPctAbs: number | null;
  volumeUsd: number;
  roiOnVolume: number;
  winRatePct: number;
  winRateCi: { lo: number; hi: number };
  nWins: number;
  nLosses: number;
  roiLt025Pct: number;
  roiMid045to075Pct: number;
  lt025Positive: boolean;
  mid045Negative: boolean;
  /** week-of for the causal onset (the handoff's "week of May 14–21" target). */
  regimeOnsetWeekStart: string | null;
  /** week-of for the best-fit (min-SSE) kink — shown for transparency, NOT the onset. */
  regimeKinkWeekStart: string | null;
  regime: { onsetDate: string | null; breakpointDate: string | null; preSlope: number; postSlope: number };
  brier: { wallet: number; market: number; ece: number; pairedBootstrapP: number; n: number };
  byBucket: ReturnType<typeof roiByEntryBucket>;
  topCities: { key: string; realizedUsd: number; roi: number; nBets: number }[];
  byRegion: { key: string; realizedUsd: number; roi: number; nBets: number }[];
}

/** The whole pure analysis from the paged fills + the ground-truth curve. */
function analyze(
  wallet: string,
  fills: WalletActivity[],
  pnlSeries: UserPnlPoint[],
  paging: PagingResult,
): { out: ForensicsOutput; bets: RealizedBet[]; curve: ReturnType<typeof dailyPnlCurve> } {
  // Grade past-resolution markets the wallet only bought (no redeem) as realized total losses — daily-Tmax
  // markets resolve same-day, so any market with targetDate before today (UTC) is resolved. This is what
  // recovers the loss leg the cheap-longshot edge is netted against (and makes the total reconcile).
  const todayUtc = new Date().toISOString().slice(0, 10);
  const recon = reconstructRealizedPnl(fills, { resolvedBefore: todayUtc });
  const curve = dailyPnlCurve(fills);
  // Regime detection runs on the user-pnl GROUND-TRUTH cumulative curve (the canonical realized-PnL curve,
  // which carries the clean mid-May inflection) when available — the reconstructed cash-flow curve dips on
  // buy-days and is noisier. Falls back to the reconstructed curve if the ground-truth series is empty.
  const truthCurve: ReturnType<typeof dailyPnlCurve> =
    pnlSeries.length > 0
      ? pnlSeries.map((p, i) => ({
          date: utcDay(p.t),
          realizedUsd: i === 0 ? p.cumPnlUsd : p.cumPnlUsd - pnlSeries[i - 1]!.cumPnlUsd,
          cumUsd: p.cumPnlUsd,
        }))
      : curve;
  const rc = regimeChange(truthCurve);

  // Detect a silently-truncated "full" crawl (early termination, e.g. rate-limiting) by cross-checking the
  // earliest fetched fill against the user-pnl curve's span — so a partial reconstruction is never persisted
  // or reported as a lifetime number.
  const missedHistory = crawlMissedHistory(pnlSeries, paging.windowFrom, paging.mode);

  // Reconciliation: compare the TRADING-ONLY reconstructed total to the user-pnl curve over the SAME window
  // (the principled like-for-like — user-pnl-api's profile curve reports realized TRADING PnL). A full/capped
  // crawl reconciles against the lifetime final point; an explicit --from window reconciles against the
  // user-pnl DELTA over that window.
  let userPnlTotalUsd: number | null;
  let windowLabel: string;
  if (paging.mode === 'window' && paging.windowFrom) {
    const before = userPnlAtDate(pnlSeries, paging.windowFrom) ?? 0;
    const final = userPnlFinal(pnlSeries);
    userPnlTotalUsd = final === null ? null : final - before;
    windowLabel = `${paging.windowFrom}..present (explicit --from window)`;
  } else {
    userPnlTotalUsd = userPnlFinal(pnlSeries);
    windowLabel =
      paging.mode === 'capped'
        ? 'lifetime (INCOMPLETE — crawl hit the page cap)'
        : missedHistory
          ? 'lifetime (INCOMPLETE — crawl terminated early, likely rate-limited)'
          : 'lifetime';
  }
  const absPct = (recon_: number): number | null =>
    userPnlTotalUsd === null || userPnlTotalUsd === 0
      ? null
      : (Math.abs(recon_ - userPnlTotalUsd) / Math.abs(userPnlTotalUsd)) * 100;
  const reconciliationPctAbs = absPct(recon.realizedTotalUsd);
  const reconciliationPlusIncentivesPctAbs = absPct(recon.tradingPlusIncentivesUsd);

  const cheap = roiBelow025(recon.bets);
  const mid = roiMid045to075(recon.bets);
  const byBucket = roiByEntryBucket(recon.bets);
  const attr = attribution(recon.bets);
  const brier = brierVsOutcomes(recon.bets);
  const ci = winRateCi(recon);
  const weekOf = (d: string | null): string | null =>
    d ? weekStartUtc(Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)) : null;

  const out: ForensicsOutput = {
    wallet,
    window: windowLabel,
    incomplete: paging.mode === 'capped' || missedHistory,
    paging: {
      mode: paging.mode,
      pagesFetched: paging.pagesFetched,
      hitCap: paging.hitCap,
      windowFrom: paging.windowFrom,
      nFills: fills.length,
    },
    reconstructedTotalUsd: recon.realizedTotalUsd,
    decomposition: {
      buyCostUsd: recon.buyCostUsd,
      sellProceedsUsd: recon.sellProceedsUsd,
      redeemProceedsUsd: recon.redeemProceedsUsd,
      mergeProceedsUsd: recon.mergeProceedsUsd,
      incentivesUsd: recon.incentivesUsd,
      tradingOnlyUsd: recon.realizedTotalUsd,
      tradingPlusIncentivesUsd: recon.tradingPlusIncentivesUsd,
    },
    userPnlTotalUsd,
    reconciliationPctAbs,
    reconciliationPlusIncentivesPctAbs,
    volumeUsd: recon.volumeUsd,
    roiOnVolume: recon.roiOnVolume,
    winRatePct: Number.isFinite(recon.winRate) ? recon.winRate * 100 : NaN,
    winRateCi: ci,
    nWins: recon.nWins,
    nLosses: recon.nLosses,
    roiLt025Pct: Number.isFinite(cheap.roi) ? cheap.roi * 100 : NaN,
    roiMid045to075Pct: Number.isFinite(mid.roi) ? mid.roi * 100 : NaN,
    lt025Positive: Number.isFinite(cheap.roi) && cheap.roi > 0,
    mid045Negative: Number.isFinite(mid.roi) && mid.roi < 0,
    regimeOnsetWeekStart: weekOf(rc.onsetDate),
    regimeKinkWeekStart: weekOf(rc.breakpointDate),
    regime: rc,
    brier: { wallet: brier.walletBrier, market: brier.marketBrier, ece: brier.ece, pairedBootstrapP: brier.pairedBootstrapP, n: brier.n },
    byBucket,
    topCities: attr.byCity.slice(0, 12).map((r) => ({ key: r.key, realizedUsd: r.realizedUsd, roi: r.roi, nBets: r.nBets })),
    byRegion: attr.byRegion.map((r) => ({ key: r.key, realizedUsd: r.realizedUsd, roi: r.roi, nBets: r.nBets })),
  };
  return { out, bets: recon.bets, curve };
}

/** Behavioral-over-time: per-week No/Yes share + median entry px (the No→Yes drift across the inflection). */
function behavioralByWeek(fills: WalletActivity[]): void {
  const buys = tradeFills(fills);
  const byWeek = new Map<string, { yes: number; no: number; px: number[] }>();
  for (const f of buys) {
    const wk = weekStartUtc(f.timestamp);
    let b = byWeek.get(wk);
    if (!b) {
      b = { yes: 0, no: 0, px: [] };
      byWeek.set(wk, b);
    }
    if (f.outcome.toLowerCase() === 'yes') b.yes++;
    else if (f.outcome.toLowerCase() === 'no') b.no++;
    if (Number.isFinite(f.price) && f.price > 0) b.px.push(f.price);
  }
  const weeks = [...byWeek.keys()].sort();
  console.log('\n── Behavioral over time (per week) ──');
  console.log('  wk-start     nBuys   %Yes   %No   medianEntryPx');
  for (const wk of weeks) {
    const b = byWeek.get(wk)!;
    const n = b.yes + b.no;
    console.log(
      `  ${wk}   ${String(n).padStart(5)}   ${pct(n ? b.yes / n : null).padStart(5)}  ` +
        `${pct(n ? b.no / n : null).padStart(5)}   ${f3(median(b.px))}`,
    );
  }
}

/** Print the human-readable forensics block. */
function printReadout(out: ForensicsOutput, curve: ReturnType<typeof dailyPnlCurve>, fills: WalletActivity[]): void {
  console.log(`\n══════════ WALLET FORENSICS — ${out.wallet} ══════════`);
  console.log(
    `Paging: mode=${out.paging.mode}, pages=${out.paging.pagesFetched}, hitCap=${out.paging.hitCap}, ` +
      `fills=${out.paging.nFills}` +
      (out.paging.windowFrom ? `, earliestFill=${out.paging.windowFrom}` : ''),
  );

  console.log('\n── Reconstructed cumulative curve (tail) ──');
  const tail = curve.slice(-8);
  for (const p of tail) {
    console.log(`  ${p.date}   day ${usd(p.realizedUsd).padStart(11)}   cum ${usd(p.cumUsd).padStart(12)}`);
  }
  if (curve.length === 0) console.log('  (no settling fills in the fetched window)');

  console.log('\n──────── RECONCILIATION (the survivorship gate) ────────');
  console.log(`  window:               ${out.window}`);
  if (out.incomplete) {
    console.log(
      out.paging.hitCap
        ? '  ⚠ INCOMPLETE: the crawl hit the --max-pages cap — this is NOT a lifetime reconciliation.'
        : '  ⚠ INCOMPLETE: the crawl terminated early (likely rate-limited) — this is NOT a lifetime reconciliation.',
    );
  }
  const d = out.decomposition;
  console.log('  ── proceeds decomposition (the like-for-like diagnostic) ──');
  console.log(`    Σ BUY cost:         ${usd(d.buyCostUsd).padStart(13)}`);
  console.log(`    Σ SELL proceeds:    ${usd(d.sellProceedsUsd).padStart(13)}`);
  console.log(`    Σ REDEEM proceeds:  ${usd(d.redeemProceedsUsd).padStart(13)}`);
  console.log(`    Σ MERGE proceeds:   ${usd(d.mergeProceedsUsd).padStart(13)}`);
  console.log(`    Σ incentives (rebate+reward): ${usd(d.incentivesUsd)}`);
  console.log(`  user-pnl ground truth:${usd(out.userPnlTotalUsd).padStart(13)}`);
  console.log(
    `  TRADING-ONLY total:   ${usd(d.tradingOnlyUsd).padStart(13)}   ` +
      `abs vs user-pnl: ${out.reconciliationPctAbs === null ? '—' : `${out.reconciliationPctAbs.toFixed(2)}%`}` +
      '   ← HEADLINE (gate target ≤ 2%)',
  );
  console.log(
    `  trading+incentives:   ${usd(d.tradingPlusIncentivesUsd).padStart(13)}   ` +
      `abs vs user-pnl: ${out.reconciliationPlusIncentivesPctAbs === null ? '—' : `${out.reconciliationPlusIncentivesPctAbs.toFixed(2)}%`}` +
      '   (shown for transparency)',
  );

  console.log('\n── ROI by entry-price bucket ──');
  console.log('  bucket          nBets  nWins   realized      staked     ROI');
  for (const b of out.byBucket) {
    console.log(
      `  ${b.label.padEnd(13)} ${String(b.nBets).padStart(5)}  ${String(b.nWins).padStart(5)}  ` +
        `${usd(b.realizedUsd).padStart(11)}  ${usd(b.stakedUsd).padStart(10)}  ${pct(b.roi).padStart(7)}`,
    );
  }
  console.log(
    `  → <0.25 cut ROI: ${pct(out.roiLt025Pct / 100)} (${out.lt025Positive ? 'POSITIVE ✓' : 'not positive'});  ` +
      `[0.45,0.75) ROI: ${pct(out.roiMid045to075Pct / 100)} (${out.mid045Negative ? 'NEGATIVE ✓' : 'not negative'})`,
  );

  console.log('\n── Attribution: top cities ──');
  console.log('  city                  nBets   realized      ROI');
  for (const c of out.topCities) {
    console.log(`  ${c.key.padEnd(20)}  ${String(c.nBets).padStart(4)}   ${usd(c.realizedUsd).padStart(11)}   ${pct(c.roi).padStart(7)}`);
  }
  console.log('\n── Attribution: US vs international ──');
  for (const r of out.byRegion) {
    console.log(`  ${r.key.padEnd(8)}  nBets ${String(r.nBets).padStart(4)}   realized ${usd(r.realizedUsd).padStart(11)}   ROI ${pct(r.roi)}`);
  }

  behavioralByWeek(fills);

  console.log('\n── Regime change ──');
  console.log(
    `  onset (causal, final trough crossing): ${out.regime.onsetDate ?? '— (no durable rise)'}` +
      (out.regimeOnsetWeekStart ? `  (week of ${out.regimeOnsetWeekStart})` : '') +
      '   ← the ONSET (handoff target: week of May 14–21)',
  );
  console.log(
    `  best-fit kink (min-SSE two-segment split): ${out.regime.breakpointDate ?? '— (no qualifying break)'}` +
      (out.regimeKinkWeekStart ? `  (week of ${out.regimeKinkWeekStart})` : '') +
      '   (endpoint-unstable; shown for transparency)',
  );
  console.log(`  kink pre-slope:  ${usd(out.regime.preSlope)}/day    kink post-slope: ${usd(out.regime.postSlope)}/day`);

  console.log('\n── Calibration (Brier vs the 0.5 market baseline) ──');
  console.log(`  n decisive bets:   ${out.brier.n}`);
  console.log(`  wallet Brier:      ${f3(out.brier.wallet)}   (lower = sharper)`);
  console.log(`  baseline Brier:    ${f3(out.brier.market)}   (uninformative 0.5/side prior)`);
  console.log(`  ECE:               ${f3(out.brier.ece)}`);
  console.log(`  paired bootstrap p:${f3(out.brier.pairedBootstrapP).padStart(8)}  (small ⇒ wallet reliably sharper than baseline)`);

  console.log('\n── Win rate ──');
  console.log(
    `  win rate: ${pct(out.winRatePct / 100)} (${out.nWins}W / ${out.nLosses}L);  ` +
      `Wilson 95% CI [${pct(out.winRateCi.lo)}, ${pct(out.winRateCi.hi)}];  ROI-on-vol ${pct(out.roiOnVolume)}\n`,
  );
}

/** Persist the daily curve + per-bet calibration via the 0050 record RPC (idempotent). */
async function persist(
  db: ScriptDb,
  wallet: string,
  out: ForensicsOutput,
  curve: ReturnType<typeof dailyPnlCurve>,
  bets: RealizedBet[],
): Promise<{ daily: number; cal: number }> {
  const dailyRows = curve.map((p) => ({ date: p.date, realizedUsd: p.realizedUsd, cumUsd: p.cumUsd }));
  const calRows = bets.map((b) => ({
    conditionId: b.conditionId,
    outcome: b.outcome,
    entryPrice: b.entryPrice,
    won: b.won,
    realizedUsd: b.realizedUsd,
    stakedUsd: b.stakedUsd,
    citySlug: b.citySlug,
    targetDate: b.targetDate,
    region: b.region,
  }));
  const r = await db.query<{ daily: number; cal: number }>(
    `select * from public.wallet_forensics_record($1, $2::jsonb, $3::jsonb)`,
    [wallet, dailyRows, calRows],
  );
  return { daily: Number(r[0]?.daily ?? 0), cal: Number(r[0]?.cal ?? 0) };
}

async function main(): Promise<void> {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      persist: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'max-pages': { type: 'string' },
      from: { type: 'string' },
    },
  });
  const wallet = (positionals[0] ?? SHARP_WALLET_ADDRESS).toLowerCase();
  // Default to a FULL lifetime crawl: 1000 pages × 500 = 500k fills ceiling (badatmath needs ~186 pages).
  // The plain command (no flags) must reproduce the full-history crawl. A smaller cap is opt-in via --max-pages.
  const maxPages = Number(values['max-pages'] ?? 1000);
  const from = values.from;

  if (!values.json) {
    console.log(`Fetching forensics for ${wallet} (maxPages=${maxPages}${from ? `, from=${from}` : ''}) …`);
    console.log('Pulling user-pnl ground-truth curve + paging /activity …');
  }

  // 1) ground-truth curve
  const pnlSeries = await fetchUserPnlSeries(fetchJson, wallet, { timeoutMs: 60_000, retries: 2 });

  // 2) page /activity — a FULL crawl by default, or windowed ONLY when the operator explicitly passes --from.
  // There is NO automatic window fallback: if the full crawl hits the page cap we surface it loudly (below)
  // and exit non-zero rather than silently windowing and presenting a partial number as lifetime.
  const paging = await crawlActivity(wallet, { maxPages, from });

  const { out, bets, curve } = analyze(wallet, paging.fills, pnlSeries, paging);

  if (values.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    printReadout(out, curve, paging.fills);
  }

  // LOUD failure on an incomplete crawl, BEFORE any persist: a partial reconstruction must never masquerade
  // as a lifetime reconciliation, and must never be written to the persist tables. `incomplete` is true when
  // the crawl hit the page cap OR terminated early (missed history vs the user-pnl span — e.g. Polymarket
  // rate-limiting). The JSON already carries `incomplete: true` + the page count.
  if (out.incomplete) {
    const reason = out.paging.hitCap
      ? `hit the ${maxPages}-page cap after ${out.paging.pagesFetched} pages`
      : `terminated early after ${out.paging.pagesFetched} pages — earliest fill ${out.paging.windowFrom ?? 'none'}, ` +
        `but the user-pnl curve starts earlier (likely Polymarket rate-limiting)`;
    process.stderr.write(
      `\n✗ INCOMPLETE CRAWL: ${reason} (${out.paging.nFills} fills). The reconstruction is NOT a full lifetime ` +
        `reconciliation` +
        (values.persist ? ' — refusing to --persist a partial snapshot' : '') +
        `. Re-run when the API is healthy (raise --max-pages only if truly capped). Exiting non-zero.\n`,
    );
    process.exit(2);
  }

  if (values.persist) {
    const db = makeScriptDb();
    try {
      const { daily, cal } = await persist(db, wallet, out, curve, bets);
      console.log(`Persisted ${daily} daily-curve row(s) + ${cal} per-bet calibration row(s) (migration 0050).`);
    } finally {
      await db.end();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('wallet-forensics crashed:', err?.message ?? err);
    process.exit(1);
  });
}
