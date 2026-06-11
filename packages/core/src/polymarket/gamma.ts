/**
 * core/polymarket/gamma — Gamma event parsing (ARCHITECTURE.md §6.9). Pure.
 *
 * Shapes are fixture-verified against research/gamma-event-*.json — never
 * assume; every quirk here was observed live (W2 station URLs, C6 Seoul
 * gameStartTime, the yearless-slug 2025 trap, Jinan zombies).
 */
import { z } from 'zod';
import { parseBucketLabel, bucketRange, validateLadder } from '../buckets.ts';
import { GammaShapeError } from '../errors.ts';
import { localDayWindow } from '../time.ts';
import type { BucketDef, Unit } from '../types.ts';

export interface RawGammaMarket {
  id: string;
  conditionId: string;
  question?: string;
  groupItemTitle?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  volume24hr?: number;
  acceptingOrders?: boolean | null;
  gameStartTime?: string | null;
  resolutionSource?: string;
  feeSchedule?: { rate: number } | null;
}

export interface RawGammaEvent {
  id: string;
  slug: string;
  title: string;
  endDate?: string;
  /** Present on closed-event payloads (research gamma-event-nyc-jun9-resolved fixture). */
  closed?: boolean;
  closedTime?: string;
  negRiskMarketID?: string;
  volume24hr?: number;
  liquidity?: number;
  resolutionSource?: string;
  gameStartTime?: string | null;
  markets: RawGammaMarket[];
}

export interface ParsedBucket {
  marketId: string;
  conditionId: string;
  label: string;
  def: BucketDef;
  tokenYes: string;
  tokenNo: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  tickSize: number | null;
  minOrderSize: number | null;
  feeRate: number | null;
  volume24h: number | null;
  outcomePricesResolved: [number, number] | null;
}

export interface ParsedEvent {
  slug: string;
  citySlug: string;
  targetDate: string;
  derivedTzOffset?: number;
  unit: Unit;
  station: { icao: string; countryCode: string } | null;
  negRiskMarketId: string | null;
  kind: 'highest' | 'lowest';
  buckets: ParsedBucket[];
  eventVolume24h: number | null;
  liquidity: number | null;
  acceptingOrders: boolean;
  ladderProblems: string[];
}

/**
 * Decode Polymarket's stringified-JSON fields (outcomes, outcomePrices,
 * clobTokenIds, umaResolutionStatuses): the payload is parsed once as JSON,
 * then these fields are parsed AGAIN as JSON arrays-of-strings.
 * GammaShapeError carries the field name — a shape change here is an
 * upstream-API-change alert.
 */
export function parseStringArray(s: string, field: string = 'unknown'): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new GammaShapeError(`field '${field}' is not valid JSON: ${s.slice(0, 60)}`, { field });
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    throw new GammaShapeError(`field '${field}' is not an array of strings`, { field, parsed });
  }
  return parsed;
}

/**
 * From resolutionSource '…/history/daily/{cc}/…/{ICAO}': cc = FIRST segment
 * after /daily/ (uppercased), icao = TERMINAL segment matching ^[A-Z0-9]{4}$.
 * Segment count between them VARIES — US URLs have two
 * (us/ny/new-york-city/KLGA, live-verified W2), intl have one
 * (gb/london/EGLC, fr/bonneuil-en-france/LFPB); never assume a fixed count.
 * null on non-matching URL (station-unverified path, never a guess).
 */
export function extractStationFromUrl(url: string): { icao: string; countryCode: string } | null {
  const m = /\/history\/daily\/([a-z]{2})\/(?:[^/]+\/)*([A-Z0-9]{4})\/?$/.exec(url);
  if (!m) return null;
  return { icao: m[2]!, countryCode: m[1]!.toUpperCase() };
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Gamma's space-separated UTC format ('2026-06-10 15:00:00+00') → Date. */
function parseGameStartTime(s: string): Date {
  const iso = s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new GammaShapeError(`unparseable gameStartTime: '${s}'`);
  }
  return d;
}

/**
 * Target local date. Primary: parse '…-on-{month}-{day}-{year}' from the slug
 * (a yearless slug is the live-verified 2025-stale-event trap — rejected).
 * ALWAYS cross-check the title's month-day. gameStartTime is local midnight
 * starting the target day expressed in UTC, so its UTC calendar date is the
 * PREVIOUS day for APAC/EMEA cities (Seoul: slug june-11 ↔ 2026-06-10T15:00Z
 * — C6); the strict check gameStartTime == localDayWindow(tz, slugDate).startUtc
 * runs ONLY when tz is known. Mismatch → GammaShapeError (never bet a
 * misdated event).
 */
export function targetDateFromEvent(
  ev: { slug: string; title: string; gameStartTime: string | null },
  tz?: string,
): string {
  const slugMatch = /-on-([a-z]+)-(\d{1,2})-(\d{4})$/.exec(ev.slug);
  if (!slugMatch) {
    throw new GammaShapeError(
      `slug has no '-on-{month}-{day}-{year}' suffix (yearless = stale-event trap): '${ev.slug}'`,
      { slug: ev.slug },
    );
  }
  const month = MONTHS[slugMatch[1]!];
  if (!month) throw new GammaShapeError(`unknown month '${slugMatch[1]}' in slug '${ev.slug}'`);
  const day = Number(slugMatch[2]);
  const year = Number(slugMatch[3]);
  const pad = (n: number) => String(n).padStart(2, '0');
  const targetDate = `${year}-${pad(month)}-${pad(day)}`;

  const titleMatch = new RegExp(`on\\s+(${Object.keys(MONTHS).join('|')})\\s+(\\d{1,2})`, 'i').exec(ev.title);
  if (!titleMatch) {
    throw new GammaShapeError(`title carries no 'on {Month} {day}' to cross-check: '${ev.title}'`);
  }
  if (MONTHS[titleMatch[1]!.toLowerCase()] !== month || Number(titleMatch[2]) !== day) {
    throw new GammaShapeError(
      `slug/title date mismatch: slug says ${targetDate}, title says '${titleMatch[0]}'`,
      { slug: ev.slug, title: ev.title },
    );
  }

  if (tz && ev.gameStartTime) {
    const start = parseGameStartTime(ev.gameStartTime);
    const expected = localDayWindow(tz, targetDate).startUtc;
    if (start.getTime() !== expected.getTime()) {
      throw new GammaShapeError(
        `gameStartTime ${ev.gameStartTime} != local midnight of ${targetDate} in ${tz} (${expected.toISOString()})`,
        { slug: ev.slug, tz },
      );
    }
  }

  return targetDate;
}

/** UTC-hour offset implied by slugDate↔gameStartTime — provisional tz for brand-new cities. */
function deriveTzOffsetHours(targetDate: string, gameStartTime: string): number {
  const localMidnightAsUtc = Date.parse(`${targetDate}T00:00:00Z`);
  return (localMidnightAsUtc - parseGameStartTime(gameStartTime).getTime()) / 3_600_000;
}

/**
 * One raw Gamma event → typed ParsedEvent. Propagates BucketParseError /
 * GammaShapeError; validateLadder problems are attached as ladderProblems
 * (event stored but flagged unbettable).
 */
export function parseGammaEvent(ev: RawGammaEvent, knownTz?: string): ParsedEvent {
  const slugKind = /^(highest|lowest)-temperature-in-(.+)-on-[a-z]+-\d{1,2}-\d{4}$/.exec(ev.slug);
  if (!slugKind) {
    throw new GammaShapeError(`slug does not match the temperature-event pattern: '${ev.slug}'`, {
      slug: ev.slug,
    });
  }
  const kind = slugKind[1] as 'highest' | 'lowest';
  const citySlug = slugKind[2]!;

  if (!Array.isArray(ev.markets) || ev.markets.length === 0) {
    throw new GammaShapeError(`event '${ev.slug}' has no markets array`);
  }

  const gameStartTime = ev.gameStartTime ?? ev.markets.find((m) => m.gameStartTime)?.gameStartTime ?? null;
  const targetDate = targetDateFromEvent({ slug: ev.slug, title: ev.title, gameStartTime }, knownTz);

  const resolutionSource = ev.resolutionSource ?? ev.markets.find((m) => m.resolutionSource)?.resolutionSource;
  const station = resolutionSource ? extractStationFromUrl(resolutionSource) : null;

  const buckets: ParsedBucket[] = ev.markets.map((m) => {
    if (!m.groupItemTitle) {
      throw new GammaShapeError(`market ${m.id} of '${ev.slug}' has no groupItemTitle`);
    }
    const def = parseBucketLabel(m.groupItemTitle);
    const tokens = m.clobTokenIds ? parseStringArray(m.clobTokenIds, 'clobTokenIds') : null;
    if (!tokens || tokens.length !== 2) {
      throw new GammaShapeError(`market ${m.id} of '${ev.slug}' lacks a [yes, no] clobTokenIds pair`);
    }
    let resolved: [number, number] | null = null;
    if (m.outcomePrices) {
      const prices = parseStringArray(m.outcomePrices, 'outcomePrices').map(Number);
      if (prices.length === 2 && prices.every(Number.isFinite)) {
        resolved = [prices[0]!, prices[1]!];
      }
    }
    return {
      marketId: m.id,
      conditionId: m.conditionId,
      label: m.groupItemTitle,
      def,
      tokenYes: tokens[0]!,
      tokenNo: tokens[1]!,
      bestBid: m.bestBid ?? null,
      bestAsk: m.bestAsk ?? null,
      spread: m.spread ?? null,
      tickSize: m.orderPriceMinTickSize ?? null,
      minOrderSize: m.orderMinSize ?? null,
      feeRate: m.feeSchedule?.rate ?? null,
      volume24h: m.volume24hr ?? null,
      outcomePricesResolved: resolved,
    };
  });

  buckets.sort((a, b) => bucketRange(a.def).lo - bucketRange(b.def).lo);
  const ladder = validateLadder(buckets.map((b) => b.def));
  const unit = buckets[0]!.def.unit;

  const parsed: ParsedEvent = {
    slug: ev.slug,
    citySlug,
    targetDate,
    unit,
    station,
    negRiskMarketId: ev.negRiskMarketID ?? null,
    kind,
    buckets,
    eventVolume24h: ev.volume24hr ?? null,
    liquidity: ev.liquidity ?? null,
    acceptingOrders: ev.markets.some((m) => m.acceptingOrders === true),
    ladderProblems: ladder.problems,
  };
  if (!knownTz && gameStartTime) {
    parsed.derivedTzOffset = deriveTzOffsetHours(targetDate, gameStartTime);
  }
  return parsed;
}

/**
 * endDate < today OR no market accepting orders with degenerate quotes
 * (bid 0 / ask 1) across the board — the live-verified stale-Jinan failure mode.
 */
export function isZombieEvent(ev: RawGammaEvent, todayUtcISO: string): boolean {
  if (ev.endDate && Date.parse(ev.endDate) < Date.parse(`${todayUtcISO}T00:00:00Z`)) {
    return true;
  }
  const markets = ev.markets ?? [];
  if (markets.length === 0) return false;
  const noneAccepting = markets.every((m) => m.acceptingOrders == null || m.acceptingOrders === false);
  const allDegenerate = markets.every((m) => (m.bestBid ?? 0) === 0 && (m.bestAsk ?? 1) === 1);
  return noneAccepting && allDegenerate;
}

// --- W15 sampled deep validation ---------------------------------------------

const RawGammaMarketSchema = z
  .object({
    id: z.string(),
    conditionId: z.string(),
    question: z.string().optional(),
    groupItemTitle: z.string().optional(),
    outcomes: z.string().optional(),
    outcomePrices: z.string().optional(),
    clobTokenIds: z.string().optional(),
    bestBid: z.number().nullable().optional(),
    bestAsk: z.number().nullable().optional(),
    spread: z.number().nullable().optional(),
    orderPriceMinTickSize: z.number().optional(),
    orderMinSize: z.number().optional(),
    volume24hr: z.number().optional(),
    acceptingOrders: z.boolean().nullable().optional(),
    gameStartTime: z.string().nullable().optional(),
    resolutionSource: z.string().optional(),
    feeSchedule: z.object({ rate: z.number() }).nullable().optional(),
  })
  .passthrough();

const RawGammaEventSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    endDate: z.string().optional(),
    negRiskMarketID: z.string().optional(),
    volume24hr: z.number().optional(),
    liquidity: z.number().optional(),
    resolutionSource: z.string().optional(),
    gameStartTime: z.string().nullable().optional(),
    markets: z.array(RawGammaMarketSchema),
  })
  .passthrough();

/**
 * FULL zod validation of one raw Gamma event — the W15 per-run sample (deep
 * validation of every event in a ~7 MB payload would blow the 2s CPU budget;
 * cheap structural guards cover the rest). GammaShapeError on drift.
 */
export function validateRawGammaEvent(ev: unknown): void {
  const r = RawGammaEventSchema.safeParse(ev);
  if (!r.success) {
    throw new GammaShapeError('sampled event failed deep shape validation (upstream drift?)', {
      issues: r.error.issues.slice(0, 10),
    });
  }
}
