/**
 * synoptic-history-probe — how far back does the trial serve (5-min) history?
 * One station (KORD), four sample days across the price-archive span. Read-only,
 * 4 requests. Token never printed.
 *
 * Usage: pnpm tsx scripts/research/synoptic-history-probe.ts
 */
import { loadEnv } from '../lib/load-env';

async function main() {
  loadEnv();
  const token = process.env.SYNOPTIC_PUBLIC_TOKEN ?? '';
  if (!token) throw new Error('SYNOPTIC_PUBLIC_TOKEN missing');
  const red = (s: string) => s.split(token).join('TOKEN_REDACTED');

  // Sample days: deep 2025, late 2025, early 2026, recent 2026.
  const days = ['2025-02-01', '2025-08-01', '2026-01-15', '2026-06-01'];
  for (const day of days) {
    const start = day.replace(/-/g, '') + '0000';
    const end = day.replace(/-/g, '') + '2359';
    const qs = new URLSearchParams({
      stid: 'KORD',
      start,
      end,
      vars: 'air_temp',
      units: 'metric',
      hfmetars: '1',
      obtimezone: 'utc',
      token,
    });
    try {
      const res = await fetch(`https://api.synopticdata.com/v2/stations/timeseries?${qs}`, {
        signal: AbortSignal.timeout(30000),
      });
      const b: any = await res.json().catch(() => ({}));
      const st = b.STATION?.[0];
      const times: string[] = st?.OBSERVATIONS?.date_time ?? [];
      const gaps: number[] = [];
      const ms = times.map((t: string) => Date.parse(t)).sort((a: number, b2: number) => a - b2);
      for (let i = 1; i < ms.length; i++) gaps.push(((ms[i] ?? 0) - (ms[i - 1] ?? 0)) / 60000);
      gaps.sort((a, b2) => a - b2);
      const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
      console.log(
        `${day} → http ${res.status} · code ${b.SUMMARY?.RESPONSE_CODE} · obs ${times.length}` +
          ` · median gap ${med === null || med === undefined ? 'n/a' : med.toFixed(1) + ' min'}` +
          (times.length === 0 ? ` · msg: ${red(String(b.SUMMARY?.RESPONSE_MESSAGE ?? ''))}` : ''),
      );
    } catch (err) {
      console.log(`${day} → ERROR ${red(String(err))}`);
    }
  }
}

main();
