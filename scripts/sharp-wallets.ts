/**
 * scripts/sharp-wallets — ingest a sharp Polymarket wallet's revealed bets (+ optionally the WEATHER
 * leaderboard) and report the Amsterdam head-to-head: their bucket vs our forecast vs the market mid.
 *
 * The manual twin of the sharp-wallet-track Edge Function (migration 0049, WALLET-RECON-HANDOFF.md Build
 * #1) — same record RPCs, so a hand-pulled snapshot is byte-identical to a cron one. Default wallet is the
 * verified #1 WEATHER sharp "badatmath." (0x8fbd…a959). This is ANALYTICS, not trading and not a
 * copy-trade (the live-trading thesis stays closed — CLAUDE.md / FORECASTING-RD.md).
 *
 * Run: pnpm tsx scripts/sharp-wallets.ts [--wallet 0x…] [--as-of YYYY-MM-DD] [--leaderboard] [--top-n 5]
 *        [--analyze-only] [--json]
 *   --leaderboard   also snapshot the WEATHER leaderboard + ingest the top-N wallets' positions
 *   --analyze-only  no fetch / no writes — just report what is already persisted
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fetchJson } from '../packages/io/src/index.ts';
import {
  fetchWalletPositions,
  fetchWeatherLeaderboard,
  type LeaderboardEntry,
  SHARP_WALLET_ADDRESS,
  SHARP_WALLET_LABEL,
  type WalletPosition,
} from '../supabase/functions/_shared/polymarket-wallet.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const f2 = (v: unknown, dp = 2): string => {
  const n = num(v);
  return n === null ? '—' : n.toFixed(dp);
};
const usd = (v: unknown): string => {
  const n = num(v);
  return n === null ? '—' : `$${n.toFixed(2)}`;
};

/** Map parsed positions → the record RPC's jsonb row shape (only temperature-market legs). */
function toRecordRows(positions: WalletPosition[]): Record<string, unknown>[] {
  return positions
    .filter((p) => p.citySlug !== null)
    .map((p) => ({
      conditionId: p.conditionId,
      citySlug: p.citySlug,
      targetDate: p.targetDate,
      outcome: p.outcome,
      sizeShares: p.sizeShares,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      curValueUsd: p.currentValueUsd,
      cashPnlUsd: p.cashPnlUsd,
      realizedPnlUsd: p.realizedPnlUsd,
      redeemable: p.redeemable,
      title: p.title,
    }));
}

/** Pull + persist one wallet's positions. Returns {fetched, weather, recorded}. */
async function ingestWallet(
  db: ScriptDb,
  wallet: string,
  label: string | null,
  asOf: string,
): Promise<{ fetched: number; weather: number; recorded: number }> {
  const positions = await fetchWalletPositions(fetchJson, wallet, {
    sizeThreshold: 0.1,
    limit: 500,
    timeoutMs: 60_000,
    retries: 2,
  });
  const rows = toRecordRows(positions);
  let recorded = 0;
  if (rows.length > 0) {
    // Pass the JS array directly (postgres-js encodes it as jsonb) — NOT JSON.stringify, which the driver
    // double-encodes into a jsonb scalar string ("cannot extract elements from a scalar"). Mirrors
    // amsterdam-truth-backfill's amsterdam_truth_upsert($1::jsonb) call.
    const r = await db.query<{ n: number }>(
      `select public.sharp_wallet_record_positions($1, $2, $3::date, $4::jsonb) as n`,
      [wallet, label, asOf, rows],
    );
    recorded = Number(r[0]?.n ?? 0);
  }
  return { fetched: positions.length, weather: rows.length, recorded };
}

/** Snapshot the WEATHER leaderboard. Returns the parsed entries (for top-N position ingest). */
async function ingestLeaderboard(db: ScriptDb, limit: number): Promise<LeaderboardEntry[]> {
  const lb = await fetchWeatherLeaderboard(fetchJson, { timePeriod: 'MONTH', limit, timeoutMs: 60_000, retries: 2 });
  if (lb.length > 0) {
    // raw array (postgres-js → jsonb), not JSON.stringify — see ingestWallet note.
    await db.query(`select public.sharp_wallet_record_leaderboard(now(), 'MONTH', $1::jsonb) as n`, [lb]);
  }
  return lb;
}

/** Report: the wallet's latest Amsterdam positions + the 3-way disagreement on the soonest market. */
async function report(db: ScriptDb, wallet: string): Promise<void> {
  const cov = (
    await db.query<{ n_pos: number; n_cities: number; as_of: string | null; n_ams: number }>(
      `select count(*) n_pos, count(distinct city_slug) n_cities, max(as_of_date)::text as_of,
              count(*) filter (where city_slug = 'amsterdam') n_ams
       from wallet_positions_daily where address = $1`,
      [wallet],
    )
  )[0]!;
  console.log(
    `\nTracked ${cov.n_pos} position-row(s) across ${cov.n_cities} cities for ${wallet}` +
      ` (latest pull ${cov.as_of ?? '—'}; ${cov.n_ams} Amsterdam).`,
  );
  if (cov.as_of == null) {
    console.log('  (no positions persisted yet — run without --analyze-only first.)');
    return;
  }

  const ams = await db.query<{
    target_date: string;
    label: string | null;
    bucket_idx: number | null;
    outcome: string;
    size_shares: string;
    avg_price: string | null;
    cur_value_usd: string | null;
  }>(
    `select p.target_date::text, mb.label, p.bucket_idx, p.outcome, p.size_shares, p.avg_price, p.cur_value_usd
     from wallet_positions_daily p
     left join market_buckets mb on mb.condition_id = p.condition_id
     where p.address = $1 and p.city_slug = 'amsterdam' and p.as_of_date = $2::date
     order by p.target_date, p.bucket_idx nulls last, p.outcome`,
    [wallet, cov.as_of],
  );
  console.log('\n── Amsterdam positions (the revealed bets) ──');
  console.log('  date         bucket            side   shares      avgPx    value');
  for (const r of ams) {
    console.log(
      `  ${r.target_date}  ${(r.label ?? `idx ${r.bucket_idx ?? '?'}`).padEnd(16)}  ${r.outcome.padEnd(4)}  ` +
        `${f2(r.size_shares, 2).padStart(9)}  ${f2(r.avg_price, 3).padStart(6)}  ${usd(r.cur_value_usd).padStart(8)}`,
    );
  }
  if (ams.length === 0) console.log('  (none on the latest pull)');

  // 3-way disagreement on the soonest upcoming Amsterdam market the wallet holds.
  const dis = (
    await db.query<{
      target_date: string | null;
      sharp_idx: number | null;
      sharp_label: string | null;
      our_idx: number | null;
      our_label: string | null;
      mkt_idx: number | null;
      mkt_label: string | null;
    }>(
      `with focus as (
         -- Amsterdam-local cutoff to match dash_amsterdam_sim's v_today (0049:226/473); current_date (UTC)
         -- drifts a day at the 22:00–24:00 UTC edge, breaking the "byte-identical to the Edge tick" claim.
         select coalesce(
           min(target_date) filter (where target_date >= (now() at time zone 'Etc/GMT-2')::date),
           max(target_date)
         ) as d
         from wallet_positions_daily
         where address = $1 and city_slug = 'amsterdam' and as_of_date = $2::date and target_date is not null
       ),
       ev as (
         select me.id from market_events me join cities c on c.id = me.city_id
         where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = (select d from focus)
         order by me.created_at desc limit 1
       ),
       sharp as (
         select bucket_idx from wallet_positions_daily
         where address = $1 and city_slug = 'amsterdam' and as_of_date = $2::date
           and target_date = (select d from focus) and outcome = 'Yes' and bucket_idx is not null
         order by size_shares desc limit 1
       ),
       ours as (
         select (array_position(bp.probs, (select max(x) from unnest(bp.probs) x)) - 1)::int idx
         from bucket_probabilities bp
         where bp.event_id = (select id from ev) and bp.source = 'house_ensemble'
         order by bp.made_at desc limit 1
       ),
       mkt as (
         select mb.bucket_idx idx from market_buckets mb
         join lateral (
           select ms.mid, ms.best_bid, ms.best_ask from market_snapshots ms
           where ms.bucket_id = mb.id order by ms.captured_at desc limit 1
         ) s on true
         where mb.event_id = (select id from ev)
         order by coalesce(s.mid, (s.best_bid + s.best_ask) / 2, s.best_ask) desc nulls last, mb.bucket_idx limit 1
       )
       select (select d from focus)::text target_date,
              (select bucket_idx from sharp) sharp_idx,
              (select label from market_buckets where event_id = (select id from ev) and bucket_idx = (select bucket_idx from sharp)) sharp_label,
              (select idx from ours) our_idx,
              (select label from market_buckets where event_id = (select id from ev) and bucket_idx = (select idx from ours)) our_label,
              (select idx from mkt) mkt_idx,
              (select label from market_buckets where event_id = (select id from ev) and bucket_idx = (select idx from mkt)) mkt_label`,
      [wallet, cov.as_of],
    )
  )[0]!;

  console.log('\n── 3-way disagreement (soonest upcoming market) ──');
  if (dis.target_date == null) {
    console.log('  (no upcoming Amsterdam market held)');
  } else {
    console.log(`  target ${dis.target_date}`);
    console.log(`    sharp  → ${dis.sharp_label ?? (dis.sharp_idx == null ? '— (no YES leg)' : `idx ${dis.sharp_idx}`)}`);
    console.log(`    ours   → ${dis.our_label ?? (dis.our_idx == null ? '— (no house_ensemble forecast)' : `idx ${dis.our_idx}`)}`);
    console.log(`    market → ${dis.mkt_label ?? (dis.mkt_idx == null ? '— (no live quotes)' : `idx ${dis.mkt_idx}`)}`);
    const distinct = new Set([dis.sharp_idx, dis.our_idx, dis.mkt_idx].filter((x) => x != null));
    console.log(`    distinct calls: ${distinct.size} ${distinct.size >= 2 ? '(disagreement)' : '(aligned)'}`);
  }

  const lb = await db.query<{ rank: number; pnl_usd: string | null; volume_usd: string | null; captured_at: string }>(
    `select rank, pnl_usd, volume_usd, captured_at::date::text captured_at
     from wallet_leaderboard_snapshots where address = $1 order by captured_at desc, time_period limit 1`,
    [wallet],
  );
  if (lb.length > 0) {
    const r = lb[0]!;
    console.log(
      `\nWEATHER leaderboard (as of ${r.captured_at}): rank #${r.rank}, PnL ${usd(r.pnl_usd)}, vol ${usd(r.volume_usd)}.\n`,
    );
  } else {
    console.log('\n(no leaderboard snapshot — pass --leaderboard to capture one.)\n');
  }
}

async function main(): Promise<void> {
  loadEnv();
  const { values } = parseArgs({
    options: {
      wallet: { type: 'string' },
      'as-of': { type: 'string' },
      leaderboard: { type: 'boolean', default: false },
      'top-n': { type: 'string' },
      'analyze-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const wallet = (values.wallet ?? SHARP_WALLET_ADDRESS).toLowerCase();
  const asOf = values['as-of'] ?? new Date().toISOString().slice(0, 10);
  const topN = Number(values['top-n'] ?? 5);
  const db = makeScriptDb();
  try {
    if (values['analyze-only'] !== true) {
      let label: string | null = wallet === SHARP_WALLET_ADDRESS ? SHARP_WALLET_LABEL : null;
      const labelByAddr = new Map<string, string>();
      if (values.leaderboard === true) {
        const lb = await ingestLeaderboard(db, 50);
        for (const e of lb) labelByAddr.set(e.address.toLowerCase(), e.label);
        console.log(`Snapshotted the WEATHER leaderboard (${lb.length} wallets).`);
        // ingest the top-N wallets' positions too
        for (const e of lb.slice(0, topN)) {
          const r = await ingestWallet(db, e.address.toLowerCase(), e.label, asOf);
          console.log(`  #${e.rank} ${e.label}: ${r.weather}/${r.fetched} weather legs (${r.recorded} written).`);
        }
      }
      label = labelByAddr.get(wallet) ?? label;
      const r = await ingestWallet(db, wallet, label, asOf);
      console.log(
        `Ingested ${wallet}: ${r.fetched} positions, ${r.weather} on temperature markets (${r.recorded} written) as of ${asOf}.`,
      );
    } else {
      console.log('Sharp-wallets — analysis only (no fetch, no writes).');
    }
    await report(db, wallet);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('sharp-wallets crashed:', err?.message ?? err);
    process.exit(1);
  });
}
