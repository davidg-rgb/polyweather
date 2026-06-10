/**
 * discover-markets — market & city ingestion (ARCHITECTURE.md §6.13).
 *
 * Paginate Gamma tag 104596 until a short page; for each non-zombie event:
 * parse (strict tz check for known cities, derived offset for new ones),
 * upsert city (new ⇒ betting disabled + WARN), handle the ADR-03 station
 * mapping ('changed' ⇒ suspend + CRITICAL), upsert event + ladder, then close
 * events Gamma stopped returning. First-seen events are handed to the
 * distribution seeder (§6.16) so a house row exists before the earliest
 * ADR-16 cutoff (C7).
 */
import {
  GammaShapeError,
  etcZoneForOffset,
  isZombieEvent,
  parseGammaEvent,
  regionForCity,
  type RawGammaEvent,
} from '../../../packages/core/src/index.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface DiscoverDeps {
  /** One Gamma page at the given offset (production: fetchJson on the tag URL). */
  fetchPage: (offset: number) => Promise<unknown>;
  notify: (alert: Alert) => Promise<boolean>;
  /** §6.16 buildDistributionForEvent for first-seen events; absent until P4 wires it. */
  seedDistribution?: (eventId: string) => Promise<boolean>;
  /** UTC calendar date for the zombie filter. */
  todayUtcISO: string;
}

const PAGE_SIZE = 100;

const slugCityRe = /^(?:highest|lowest)-temperature-in-(.+)-on-[a-z]+-\d{1,2}-\d{4}$/;
const titleCityRe = /temperature in (.+?) on /i;

interface CityState {
  city_id: string;
  tz: string;
  betting_enabled: boolean;
  current_icao: string | null;
}

export async function discoverMarkets(ctx: JobCtx, deps: DiscoverDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const stats = {
    eventsSeen: 0,
    eventsNew: 0,
    bucketsUpserted: 0,
    stationsChanged: 0,
    zombies: 0,
    parseFailures: 0,
    distributionsSeeded: 0,
    closedByUs: 0,
  };

  const events: RawGammaEvent[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await deps.fetchPage(offset);
    if (!Array.isArray(page)) {
      throw new GammaShapeError(`events page at offset ${offset} is not an array`);
    }
    events.push(...(page as RawGammaEvent[]));
    if (page.length < PAGE_SIZE) break;
  }

  const seenPolyIds: string[] = [];
  for (const ev of events) {
    stats.eventsSeen++;
    if (isZombieEvent(ev, deps.todayUtcISO)) {
      stats.zombies++;
      continue;
    }

    const citySlug = slugCityRe.exec(ev.slug)?.[1];
    const states = citySlug
      ? await db.rpc<CityState>('get_city_state', { p_slug: citySlug })
      : [];
    const cityState = states[0];

    let parsed;
    try {
      parsed = parseGammaEvent(ev, cityState?.tz);
    } catch (e) {
      stats.parseFailures++;
      log('event parse failed — flagged unbettable', { slug: ev.slug, error: String(e) });
      await deps.notify({
        kind: 'EVENT_UNPARSEABLE',
        severity: 'WARN',
        title: `Unparseable Gamma event: ${ev.slug}`,
        body: String(e),
        dedupeKey: `unparseable:${ev.slug}`,
      });
      continue;
    }

    const offsetHours = parsed.derivedTzOffset ?? 0;
    const tz = cityState?.tz ?? etcZoneForOffset(offsetHours);
    const cc = parsed.station?.countryCode ?? 'ZZ';
    const displayName = titleCityRe.exec(ev.title)?.[1] ?? parsed.citySlug;

    const [city] = await db.rpc<{ city_id: string; is_new: boolean }>('upsert_city', {
      p_slug: parsed.citySlug,
      p_display_name: displayName,
      p_country_code: cc,
      p_unit: parsed.unit,
      p_tz: tz,
      p_region: regionForCity(cc, offsetHours),
    });
    if (city!.is_new) {
      await deps.notify({
        kind: 'NEW_CITY',
        severity: 'WARN',
        title: `New city discovered: ${displayName}`,
        body: `slug \`${parsed.citySlug}\` unit ${parsed.unit} tz ${tz} — betting disabled until the station is verified`,
        dedupeKey: `new-city:${parsed.citySlug}`,
      });
    }

    if (parsed.station) {
      await db.rpc('ensure_station', {
        p_icao: parsed.station.icao,
        p_country_code: parsed.station.countryCode,
        p_tz: tz,
      });
      const sourceUrl = ev.resolutionSource ?? ev.markets.find((m) => m.resolutionSource)?.resolutionSource ?? null;
      const [swap] = await db.rpc<{ swap_station: string }>('swap_station', {
        p_city_id: city!.city_id,
        p_icao: parsed.station.icao,
        p_wu_cc: parsed.station.countryCode,
        p_source_url: sourceUrl,
      });
      if (swap!.swap_station === 'changed') {
        stats.stationsChanged++;
        await deps.notify({
          kind: 'STATION_CHANGE',
          severity: 'CRITICAL',
          title: `Resolution station changed for ${displayName}`,
          body: `now \`${parsed.station.icao}\` (${sourceUrl ?? 'no source url'}) — betting SUSPENDED until /admin verify`,
          dedupeKey: `station-change:${parsed.citySlug}:${parsed.station.icao}`,
        });
      }
    }

    const [eventRow] = await db.rpc<{ event_id: string; is_new: boolean }>('upsert_event', {
      p_poly_event_id: ev.id,
      p_slug: parsed.slug,
      p_kind: parsed.kind,
      p_city_id: city!.city_id,
      p_icao: parsed.station?.icao ?? null,
      p_target_date: parsed.targetDate,
      p_unit: parsed.unit,
      p_neg_risk_market_id: parsed.negRiskMarketId,
      p_accepting: parsed.acceptingOrders,
      p_volume24h: parsed.eventVolume24h,
      p_liquidity: parsed.liquidity,
      p_ladder_ok: parsed.ladderProblems.length === 0,
      p_ladder_problems: parsed.ladderProblems,
    });
    seenPolyIds.push(ev.id);
    if (eventRow!.is_new) {
      stats.eventsNew++;
      if (deps.seedDistribution) {
        if (await deps.seedDistribution(eventRow!.event_id)) stats.distributionsSeeded++;
      }
    }

    for (let i = 0; i < parsed.buckets.length; i++) {
      const b = parsed.buckets[i]!;
      await db.rpc('upsert_bucket', {
        p_event_id: eventRow!.event_id,
        p_bucket_idx: i,
        p_label: b.label,
        p_low: b.def.low,
        p_high: b.def.high,
        p_poly_market_id: b.marketId,
        p_condition_id: b.conditionId,
        p_token_yes: b.tokenYes,
        p_token_no: b.tokenNo,
        p_tick: b.tickSize,
        p_min_order: b.minOrderSize,
        p_fee_rate: b.feeRate,
      });
      stats.bucketsUpserted++;
    }
  }

  const [closed] = await db.rpc<{ close_stale_events: number }>('close_stale_events', {
    p_seen_poly_ids: seenPolyIds,
  });
  stats.closedByUs = closed?.close_stale_events ?? 0;

  log('discovery complete', stats);
  return stats;
}
