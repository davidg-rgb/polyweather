/**
 * scripts/_audit-forward-capture — READ-ONLY prod measurement (probe v2): isolate
 * the FRESH (<=7-day, full-density) tier from the downsampled tail so the cadence
 * number reflects what Build #3 actually reads going forward. NO WRITES.
 */
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    // FRESH tier: resolved events whose target_date is within the last 7 days
    // (snapshots NOT yet downsampled by ops_downsample's >7d hourly collapse).
    const freshCadence = await db.query<{
      n_events: number;
      n_buckets: number;
      total_snaps: number;
      avg_snaps_per_bucket: number | null;
      median_snaps_per_bucket: number | null;
      median_gap_min: number | null;
      p90_gap_min: number | null;
    }>(
      `with ev as (
         select id, target_date from market_events
         where closed and resolved_at is not null
           and target_date >= current_date - 7 and ladder_ok
       ),
       snaps as (
         select mb.id bucket_id, ms.captured_at,
                lag(ms.captured_at) over (partition by mb.id order by ms.captured_at) prev
         from ev e
         join market_buckets mb on mb.event_id = e.id
         join market_snapshots ms on ms.bucket_id = mb.id
         where ms.captured_at >= (e.target_date - 1)::timestamptz
           and ms.captured_at <  (e.target_date)::timestamptz
       ),
       per_bucket as (select bucket_id, count(*) n from snaps group by bucket_id),
       gaps as (select extract(epoch from (captured_at - prev))/60.0 g from snaps where prev is not null)
       select (select count(*) from ev) n_events,
              (select count(*) from per_bucket) n_buckets,
              (select count(*) from snaps) total_snaps,
              (select round(avg(n),1) from per_bucket) avg_snaps_per_bucket,
              (select percentile_cont(0.5) within group (order by n) from per_bucket) median_snaps_per_bucket,
              (select round(percentile_cont(0.5) within group (order by g)::numeric,1) from gaps) median_gap_min,
              (select round(percentile_cont(0.9) within group (order by g)::numeric,1) from gaps) p90_gap_min`,
    );
    console.log('=== FRESH-TIER (<=7d, full-density) DAY-BEFORE CADENCE ===');
    console.log(JSON.stringify(freshCadence[0], null, 2));

    // How recoverable is mid? rows where mid is null but bid+ask both present.
    const midRecover = await db.query<{ null_mid: number; null_mid_recoverable: number; null_both: number }>(
      `with ev as (
         select id, target_date from market_events
         where closed and resolved_at is not null and ladder_ok and target_date >= current_date - 7
       ),
       s as (
         select ms.best_bid, ms.best_ask, ms.mid
         from ev e join market_buckets mb on mb.event_id=e.id
         join market_snapshots ms on ms.bucket_id=mb.id
         where ms.captured_at >= (e.target_date-1)::timestamptz and ms.captured_at < e.target_date::timestamptz
       )
       select count(*) filter (where mid is null) null_mid,
              count(*) filter (where mid is null and best_bid is not null and best_ask is not null) null_mid_recoverable,
              count(*) filter (where best_bid is null and best_ask is null) null_both
       from s`,
    );
    console.log('\n=== MID RECOVERABILITY (fresh tier) ===');
    console.log(JSON.stringify(midRecover[0], null, 2));

    // Confirm coverage spans the full tracked universe (not just US cities) in the fresh tier.
    const byRegion = await db.query<{ region: string; n_events: number; avg_snaps_per_bucket: number | null }>(
      `with ev as (
         select me.id, me.target_date, c.region from market_events me join cities c on c.id = me.city_id
         where me.closed and me.resolved_at is not null and me.ladder_ok and me.target_date >= current_date - 7
       ),
       pb as (
         select e.region, mb.id bucket_id, count(ms.id) n
         from ev e join market_buckets mb on mb.event_id=e.id
         left join market_snapshots ms on ms.bucket_id=mb.id
           and ms.captured_at >= (e.target_date-1)::timestamptz and ms.captured_at < e.target_date::timestamptz
         group by e.region, mb.id
       )
       select region, count(distinct bucket_id) filter (where n>0) n_buckets_covered,
              round(avg(n),1) avg_snaps_per_bucket
       from pb group by region order by region`,
    );
    console.log('\n=== FRESH-TIER COVERAGE BY REGION ===');
    console.table(byRegion);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error('audit probe v2 crashed:', e?.message ?? e);
  process.exit(1);
});
