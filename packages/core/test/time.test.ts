import { describe, expect, it } from 'vitest';
import { InvalidTimezoneError, ValidationError } from '../src/errors.ts';
import { isLocalDayOver, leadDays, localDateAt, localDayWindow, localHour } from '../src/time.ts';

const iso = (s: string) => new Date(s);

describe('localDayWindow (§6.1)', () => {
  it('Asia/Seoul 2026-06-11 — matches the Seoul fixture gameStartTime (C6)', () => {
    const w = localDayWindow('Asia/Seoul', '2026-06-11');
    // research/gamma-event-temperature-seoul-jun11.json: gameStartTime 2026-06-10 15:00:00+00
    expect(w.startUtc.toISOString()).toBe('2026-06-10T15:00:00.000Z');
    expect(w.endUtc.toISOString()).toBe('2026-06-11T15:00:00.000Z');
  });

  it('America/New_York 2026-06-11 — matches the NYC fixture gameStartTime', () => {
    const w = localDayWindow('America/New_York', '2026-06-11');
    // research/gamma-event-temperature-nyc-jun11.json: gameStartTime 2026-06-11 04:00:00+00
    expect(w.startUtc.toISOString()).toBe('2026-06-11T04:00:00.000Z');
    expect(w.endUtc.toISOString()).toBe('2026-06-12T04:00:00.000Z');
  });

  it('Europe/London 2026-06-11 (BST) — UTC bounds at 23:00Z', () => {
    const w = localDayWindow('Europe/London', '2026-06-11');
    expect(w.startUtc.toISOString()).toBe('2026-06-10T23:00:00.000Z');
    expect(w.endUtc.toISOString()).toBe('2026-06-11T23:00:00.000Z');
  });

  it('America/Chicago 2026-06-11 (CDT) — UTC bounds at 05:00Z', () => {
    const w = localDayWindow('America/Chicago', '2026-06-11');
    expect(w.startUtc.toISOString()).toBe('2026-06-11T05:00:00.000Z');
    expect(w.endUtc.toISOString()).toBe('2026-06-12T05:00:00.000Z');
  });

  it('DST spring-forward: America/Chicago 2026-03-08 is a 23h day', () => {
    const w = localDayWindow('America/Chicago', '2026-03-08');
    expect(w.startUtc.toISOString()).toBe('2026-03-08T06:00:00.000Z'); // CST midnight
    expect(w.endUtc.toISOString()).toBe('2026-03-09T05:00:00.000Z'); // CDT midnight
    expect(w.endUtc.getTime() - w.startUtc.getTime()).toBe(23 * 3_600_000);
  });

  it('DST fall-back: America/Chicago 2026-11-01 is a 25h day', () => {
    const w = localDayWindow('America/Chicago', '2026-11-01');
    expect(w.startUtc.toISOString()).toBe('2026-11-01T05:00:00.000Z'); // CDT midnight
    expect(w.endUtc.toISOString()).toBe('2026-11-02T06:00:00.000Z'); // CST midnight
    expect(w.endUtc.getTime() - w.startUtc.getTime()).toBe(25 * 3_600_000);
  });

  it('DST fall-back: Europe/London 2026-10-25 is a 25h day', () => {
    const w = localDayWindow('Europe/London', '2026-10-25');
    expect(w.startUtc.toISOString()).toBe('2026-10-24T23:00:00.000Z'); // BST midnight
    expect(w.endUtc.toISOString()).toBe('2026-10-26T00:00:00.000Z'); // GMT midnight
    expect(w.endUtc.getTime() - w.startUtc.getTime()).toBe(25 * 3_600_000);
  });

  it('DST spring-forward: Europe/London 2026-03-29 is a 23h day', () => {
    const w = localDayWindow('Europe/London', '2026-03-29');
    expect(w.startUtc.toISOString()).toBe('2026-03-29T00:00:00.000Z'); // GMT midnight
    expect(w.endUtc.toISOString()).toBe('2026-03-29T23:00:00.000Z'); // BST midnight
    expect(w.endUtc.getTime() - w.startUtc.getTime()).toBe(23 * 3_600_000);
  });

  it('handles month/year rollover on the end bound', () => {
    const w = localDayWindow('Asia/Seoul', '2026-12-31');
    expect(w.endUtc.toISOString()).toBe('2026-12-31T15:00:00.000Z'); // local 2027-01-01 00:00
  });

  it('throws InvalidTimezoneError on unknown tz, ValidationError on malformed date', () => {
    expect(() => localDayWindow('Mars/Olympus', '2026-06-11')).toThrow(InvalidTimezoneError);
    expect(() => localDayWindow('Asia/Seoul', '11-06-2026')).toThrow(ValidationError);
    expect(() => localDayWindow('Asia/Seoul', '2026-13-01')).toThrow(ValidationError);
  });
});

describe('localDateAt (§6.1)', () => {
  it('boundary instants classify correctly (23:59:59.9 / 00:00:00 local)', () => {
    // Asia/Seoul local midnight = 15:00Z
    expect(localDateAt('Asia/Seoul', iso('2026-06-10T14:59:59.900Z'))).toBe('2026-06-10');
    expect(localDateAt('Asia/Seoul', iso('2026-06-10T15:00:00.000Z'))).toBe('2026-06-11');
    // America/Chicago on the spring-forward boundary
    expect(localDateAt('America/Chicago', iso('2026-03-09T04:59:59.900Z'))).toBe('2026-03-08');
    expect(localDateAt('America/Chicago', iso('2026-03-09T05:00:00.000Z'))).toBe('2026-03-09');
  });

  it('throws InvalidTimezoneError on unknown tz', () => {
    expect(() => localDateAt('Not/AZone', new Date())).toThrow(InvalidTimezoneError);
  });
});

describe('leadDays (§6.1)', () => {
  const seoulMidnight = iso('2026-06-10T15:00:00.000Z'); // = 2026-06-11 00:00 KST (fixture gameStartTime)

  it('0 on the target day locally — from the exact fixture gameStartTime instant', () => {
    expect(leadDays(seoulMidnight, '2026-06-11', 'Asia/Seoul')).toBe(0);
  });

  it('1 just before local midnight of the target day', () => {
    expect(leadDays(iso('2026-06-10T14:59:59.999Z'), '2026-06-11', 'Asia/Seoul')).toBe(1);
  });

  it('−1 after the target day ends locally (all past days collapse to −1)', () => {
    expect(leadDays(iso('2026-06-11T15:00:00.000Z'), '2026-06-11', 'Asia/Seoul')).toBe(-1);
    expect(leadDays(iso('2026-09-01T00:00:00.000Z'), '2026-06-11', 'Asia/Seoul')).toBe(-1);
  });

  it('whole-day leads count local calendar days', () => {
    expect(leadDays(seoulMidnight, '2026-06-14', 'Asia/Seoul')).toBe(3);
    expect(leadDays(seoulMidnight, '2026-06-12', 'Asia/Seoul')).toBe(1);
    // Same UTC instant is still June 10 in Chicago → June 11 is lead 1 there.
    expect(leadDays(seoulMidnight, '2026-06-11', 'America/Chicago')).toBe(1);
  });

  it('throws InvalidTimezoneError on unknown tz', () => {
    expect(() => leadDays(new Date(), '2026-06-11', 'Fake/Zone')).toThrow(InvalidTimezoneError);
  });
});

describe('isLocalDayOver / localHour — consistent with localDayWindow (§6.1)', () => {
  it('flips exactly at endUtc', () => {
    const { endUtc } = localDayWindow('Europe/London', '2026-06-11');
    expect(isLocalDayOver('Europe/London', '2026-06-11', new Date(endUtc.getTime() - 1))).toBe(false);
    expect(isLocalDayOver('Europe/London', '2026-06-11', endUtc)).toBe(true);
  });

  it('localHour is 0 at startUtc and 23 the millisecond before', () => {
    const { startUtc } = localDayWindow('America/Chicago', '2026-11-01');
    expect(localHour('America/Chicago', startUtc)).toBe(0);
    expect(localHour('America/Chicago', new Date(startUtc.getTime() - 1))).toBe(23);
  });

  it('localHour tracks the wall clock through the fall-back repeat hour', () => {
    // America/Chicago 2026-11-01: 06:00Z = 1am CDT, 07:00Z = 1am CST (repeated wall hour)
    expect(localHour('America/Chicago', iso('2026-11-01T06:30:00Z'))).toBe(1);
    expect(localHour('America/Chicago', iso('2026-11-01T07:30:00Z'))).toBe(1);
    expect(localHour('America/Chicago', iso('2026-11-01T08:30:00Z'))).toBe(2);
  });

  it('throws InvalidTimezoneError on unknown tz', () => {
    expect(() => isLocalDayOver('Bad/Zone', '2026-06-11', new Date())).toThrow(InvalidTimezoneError);
    expect(() => localHour('Bad/Zone', new Date())).toThrow(InvalidTimezoneError);
  });
});
