/** synoptic-probe-intl — is the missing-intl result a tier wall or a station-id issue? */
import { loadEnv } from '../lib/load-env';

async function main() {
  loadEnv();
  const token = process.env.SYNOPTIC_PUBLIC_TOKEN ?? '';
  const red = (s: string) => s.split(token).join('TOKEN_REDACTED');
  const probe = async (label: string, params: Record<string, string>) => {
    const qs = new URLSearchParams({ ...params, token });
    const ctrl = AbortSignal.timeout(20000);
    try {
      const res = await fetch(`https://api.synopticdata.com/v2/stations/metadata?${qs}`, { signal: ctrl });
      const b: any = await res.json().catch(() => ({}));
      const st = (b.STATION ?? []).map((s: any) => `${s.STID}:${s.COUNTRY ?? '?'}`);
      console.log(label, '→ http', res.status, '· code', b.SUMMARY?.RESPONSE_CODE, '·',
        red(String(b.SUMMARY?.RESPONSE_MESSAGE ?? '')), '·', st.length ? st.join(' ') : 'NO STATIONS');
    } catch (err) {
      console.log(label, '→ ERROR', red(String(err)));
    }
  };
  await probe('intl majors (EGLL,LTAC,YSSY,RJTT)', { stid: 'EGLL,LTAC,YSSY,RJTT' });
  await probe('EGLL alone', { stid: 'EGLL' });
  await probe('CYYZ (Canada)', { stid: 'CYYZ' });
}

main();
