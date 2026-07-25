/** synoptic-history-boundary — find how many days back the trial serves. 7 requests. */
import { loadEnv } from '../lib/load-env';

async function main() {
  loadEnv();
  const token = process.env.SYNOPTIC_PUBLIC_TOKEN ?? '';
  if (!token) throw new Error('token missing');
  const red = (s: string) => s.split(token).join('TOKEN_REDACTED');
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  for (const n of [1, 2, 3, 5, 7, 14, 30]) {
    const d = day(n);
    const qs = new URLSearchParams({
      stid: 'KORD',
      start: d.replace(/-/g, '') + '0000',
      end: d.replace(/-/g, '') + '0600',
      vars: 'air_temp',
      units: 'metric',
      hfmetars: '1',
      token,
    });
    try {
      const res = await fetch(`https://api.synopticdata.com/v2/stations/timeseries?${qs}`, {
        signal: AbortSignal.timeout(25000),
      });
      const b: any = await res.json().catch(() => ({}));
      const nObs = b.STATION?.[0]?.OBSERVATIONS?.date_time?.length ?? 0;
      console.log(
        `${d} (${n}d back) → code ${b.SUMMARY?.RESPONSE_CODE} · obs ${nObs}` +
          (nObs === 0 ? ` · ${red(String(b.SUMMARY?.RESPONSE_MESSAGE ?? '')).slice(0, 70)}` : ''),
      );
    } catch (err) {
      console.log(`${d} (${n}d back) → ERROR ${red(String(err)).slice(0, 80)}`);
    }
  }
}

main();
