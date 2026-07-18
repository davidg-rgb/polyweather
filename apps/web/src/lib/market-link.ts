/**
 * market-link — the live Polymarket book permalink for a /cities open-market row.
 *
 * The authoritative source is market_events.slug delivered by dash_city_predictions (0107):
 * https://polymarket.com/event/{slug}, e.g. …/highest-temperature-in-chongqing-on-july-18-2026.
 * Until 0107 is applied the RPC omits the slug, so the URL is reconstructed from city + targetDate —
 * faithful by construction: the gamma parser only admits full-month
 * 'highest-temperature-in-{city}-on-{month}-{day}-{year}' events (yearless/abbreviated forms are rejected
 * on the live path), opening-capture keeps kind='highest' only, and the capture's city IS the slug's city
 * segment (it was parsed out of the event slug in the first place).
 */

const MONTHS_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

export function polymarketEventUrl(
  slug: string | null | undefined,
  city: string,
  targetDate: string,
): string | null {
  if (slug) return `https://polymarket.com/event/${slug}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate);
  if (!m || !city) return null;
  const month = MONTHS_FULL[Number(m[2]) - 1];
  if (!month) return null;
  return `https://polymarket.com/event/highest-temperature-in-${city}-on-${month}-${Number(m[3])}-${m[1]}`;
}
