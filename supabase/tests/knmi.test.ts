/**
 * _shared/knmi — the KNMI daggegevens client for floor "truth accuracy" (migration 0043). Pure unit test
 * (no DB, no network): the parser against the real payload shape, and the fetch wrapper against a stubbed
 * fetchJson (asserting the POST it builds + the tenths→°C conversion).
 */
import { describe, expect, it } from 'vitest';
import {
  fetchKnmiTx,
  KNMI_DAGGEGEVENS_URL,
  KNMI_SCHIPHOL_STATION,
  parseKnmiTx,
} from '../functions/_shared/knmi.ts';

describe('parseKnmiTx — KNMI daggegevens JSON → {dateLocal, txTenthsC}', () => {
  it('converts TX tenths to °C and slices the date', () => {
    const payload = [
      { station_code: 240, date: '2024-06-01T00:00:00.000Z', TX: 161 },
      { station_code: 240, date: '2024-06-04T00:00:00.000Z', TX: 215 },
    ];
    expect(parseKnmiTx(payload)).toEqual([
      { dateLocal: '2024-06-01', txTenthsC: 16.1 },
      { dateLocal: '2024-06-04', txTenthsC: 21.5 },
    ]);
  });

  it('handles negative (winter) highs', () => {
    expect(parseKnmiTx([{ station_code: 240, date: '2025-01-08T00:00:00.000Z', TX: -53 }])).toEqual([
      { dateLocal: '2025-01-08', txTenthsC: -5.3 },
    ]);
  });

  it('drops null/absent/non-finite TX and malformed rows; total on a non-array', () => {
    const payload = [
      { station_code: 240, date: '2024-06-02T00:00:00.000Z', TX: null },
      { station_code: 240, date: '2024-06-03T00:00:00.000Z' },
      { station_code: 240, TX: 200 }, // no date
      { station_code: 240, date: '2024-06-05T00:00:00.000Z', TX: 152 },
    ];
    expect(parseKnmiTx(payload)).toEqual([{ dateLocal: '2024-06-05', txTenthsC: 15.2 }]);
    expect(parseKnmiTx(null)).toEqual([]);
    expect(parseKnmiTx({})).toEqual([]);
  });
});

describe('fetchKnmiTx — the POST it builds + parsing the response', () => {
  it('POSTs vars=TX for the Schiphol station over the compacted range, returns parsed °C', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const stub = async (url: string, init?: RequestInit): Promise<unknown> => {
      seenUrl = url;
      seenInit = init;
      return [{ station_code: 240, date: '2026-06-10T00:00:00.000Z', TX: 224 }];
    };
    const rows = await fetchKnmiTx(stub, '2026-06-01', '2026-06-10');
    expect(rows).toEqual([{ dateLocal: '2026-06-10', txTenthsC: 22.4 }]);
    expect(seenUrl).toBe(KNMI_DAGGEGEVENS_URL);
    expect(seenInit?.method).toBe('POST');
    expect(String(seenInit?.body)).toBe(`start=20260601&end=20260610&vars=TX&stns=${KNMI_SCHIPHOL_STATION}&fmt=json`);
  });
});
