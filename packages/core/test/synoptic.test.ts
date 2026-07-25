import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WuShapeError } from '../src/errors.ts';
import { metarRunningMax } from '../src/weather/metar.ts';
import { parseSynopticTimeseries } from '../src/weather/synoptic.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', '..', 'research');
const fixture = JSON.parse(
  readFileSync(join(RESEARCH, 'synoptic_timeseries_mixed.json'), 'utf8'),
);

describe('parseSynopticTimeseries', () => {
  it('parses the live-captured fixture (KHOU+KORD, 5-min cadence)', () => {
    const obs = parseSynopticTimeseries(fixture);
    const byStation = new Set(obs.map((o) => o.icaoId));
    expect(byStation).toEqual(new Set(['KHOU', 'KORD']));
    // Fixture ground truth: 25 KHOU + 26 KORD obs over the 120-min window.
    expect(obs.filter((o) => o.icaoId === 'KHOU').length).toBe(25);
    expect(obs.filter((o) => o.icaoId === 'KORD').length).toBe(26);
    // First KHOU ob: 31°C @ 2026-07-25T15:40:00Z (unix seconds, tenths-capable °C).
    const first = obs.find((o) => o.icaoId === 'KHOU');
    expect(first?.obsTimeUtc).toBe(Date.parse('2026-07-25T15:40:00Z') / 1000);
    expect(first?.tempTenthsC).toBe(31);
    // Tenths survive verbatim (30.6 exists in the fixture).
    expect(obs.some((o) => o.tempTenthsC === 30.6)).toBe(true);
  });

  it('feeds metarRunningMax verbatim (same MetarOb shape)', () => {
    const obs = parseSynopticTimeseries(fixture);
    const khou = obs.filter((o) => o.icaoId === 'KHOU');
    const max = metarRunningMax(khou, 'America/Chicago', '2026-07-25');
    expect(max).toBe(Math.max(...khou.map((o) => o.tempTenthsC)));
  });

  it('RESPONSE_CODE 2 (no stations / out-of-tier) is a valid EMPTY result', () => {
    expect(
      parseSynopticTimeseries({ SUMMARY: { RESPONSE_CODE: 2, RESPONSE_MESSAGE: 'No stations found' } }),
    ).toEqual([]);
  });

  it('skips null temps and unparsable timestamps', () => {
    const obs = parseSynopticTimeseries({
      SUMMARY: { RESPONSE_CODE: 1 },
      STATION: [
        {
          STID: 'KORD',
          OBSERVATIONS: {
            date_time: ['2026-07-25T15:40:00Z', '2026-07-25T15:45:00Z', 'not-a-date'],
            air_temp_set_1: [24, null, 25],
          },
        },
      ],
    });
    expect(obs).toEqual([
      { icaoId: 'KORD', obsTimeUtc: Date.parse('2026-07-25T15:40:00Z') / 1000, tempTenthsC: 24 },
    ]);
  });

  it('throws WuShapeError on date_time/air_temp length mismatch', () => {
    expect(() =>
      parseSynopticTimeseries({
        SUMMARY: { RESPONSE_CODE: 1 },
        STATION: [
          { STID: 'KORD', OBSERVATIONS: { date_time: ['2026-07-25T15:40:00Z'], air_temp_set_1: [24, 25] } },
        ],
      }),
    ).toThrow(WuShapeError);
  });

  it('throws WuShapeError on a non-Synoptic payload', () => {
    expect(() => parseSynopticTimeseries([{ icaoId: 'KORD' }])).toThrow(WuShapeError);
  });
});
