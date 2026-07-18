/**
 * sortCityRows (the /cities sortable open-markets table) — pure unit tests for the client sorter:
 * ascending/descending per key, and the null-sinks-LAST rule in BOTH directions (a missing ask/rate/
 * upside/clock must never rank as "cheapest" or "best"). The render test covers the headers/cells;
 * this covers the ordering semantics a static render cannot exercise.
 */
import { describe, expect, it } from 'vitest';
import { sortCityRows, type CitiesTableRow } from '../src/components/CitiesTable.tsx';

const row = (over: Partial<CitiesTableRow>): CitiesTableRow => ({
  city: 'x',
  displayName: 'X',
  marketUrl: 'https://polymarket.com/event/highest-temperature-in-x-on-july-18-2026',
  targetDate: '2026-07-18',
  dayOffset: 0,
  hoursToClose: 5,
  captureAgeMin: 1,
  predLabel: '31°C',
  predProb: 0.4,
  ask: 0.3,
  rate: 0.5,
  n: 10,
  pLb: 0.3,
  evLb: 0.0,
  evPoint: 0.1,
  inWindow: false,
  ...over,
});

describe('sortCityRows', () => {
  const rows = [
    row({ city: 'a', ask: 0.4, rate: 0.3, evLb: -0.2, hoursToClose: 20 }),
    row({ city: 'b', ask: 0.1, rate: 0.7, evLb: 0.5, hoursToClose: 5 }),
    row({ city: 'c', ask: null, rate: null, evLb: null, hoursToClose: null }),
    row({ city: 'd', ask: 0.25, rate: 0.5, evLb: 0.1, hoursToClose: 12 }),
  ];
  const order = (rs: CitiesTableRow[]): string[] => rs.map((r) => r.city);

  it('sorts by ask ascending (cheapest first), nulls last', () => {
    expect(order(sortCityRows(rows, 'ask', 'asc'))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('sorts by ask descending, nulls STILL last (a missing price is never "most expensive")', () => {
    expect(order(sortCityRows(rows, 'ask', 'desc'))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('sorts by historic success descending (best first), nulls last', () => {
    expect(order(sortCityRows(rows, 'rate', 'desc'))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('sorts by conservative upside descending (best first), nulls last', () => {
    expect(order(sortCityRows(rows, 'upside', 'desc'))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('sorts by time to close ascending (the default), null clock last', () => {
    expect(order(sortCityRows(rows, 'close', 'asc'))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const before = order(rows);
    sortCityRows(rows, 'ask', 'desc');
    expect(order(rows)).toEqual(before);
  });
});
