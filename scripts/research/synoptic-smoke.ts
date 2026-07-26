/**
 * synoptic-smoke — live API verification for the Synoptic Data integration (2026-07-25).
 *
 * Read-only against api.synopticdata.com. Verifies, on the operator's new account:
 *   1. auth works (SYNOPTIC_PUBLIC_TOKEN — loaded in-process, NEVER printed),
 *   2. the open-access tier serves our stations (US + international METAR),
 *   3. sub-hourly cadence: hfmetars=1 five-minute obs on US ASOS vs intl cadence,
 *   4. response shapes for the parser fixtures (written token-free to research/).
 *
 * Usage: pnpm tsx scripts/research/synoptic-smoke.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../lib/load-env';

const BASE = 'https://api.synopticdata.com/v2';
// Mixed probe: US HF-ASOS candidates + the four live-lane intl cities + a °F city.
const STATIONS = ['KORD', 'KHOU', 'LTAC', 'WSSS', 'EFHK', 'WMKK', 'NZWN'];

function redact(text: string, token: string): string {
  return text.split(token).join('TOKEN_REDACTED');
}

async function get(path: string, params: Record<string, string>, token: string): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams({ ...params, token });
  const url = `${BASE}${path}?${qs}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'polyweather-smoke/1.0' } });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: redact(text.slice(0, 400), token) };
    }
    return { status: res.status, body };
  } catch (err) {
    throw new Error(redact(String(err), token));
  }
}

function cadence(times: string[]): string {
  if (times.length < 2) return 'n/a';
  const ms = times.map((t) => Date.parse(t)).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ms.length; i++) gaps.push(((ms[i] ?? 0) - (ms[i - 1] ?? 0)) / 60000);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)] ?? 0;
  return `median ${med.toFixed(1)} min (min ${(gaps[0] ?? 0).toFixed(1)}, n=${times.length})`;
}

async function main() {
  loadEnv();
  const token = process.env.SYNOPTIC_PUBLIC_TOKEN ?? '';
  if (!token) {
    console.error('SYNOPTIC_PUBLIC_TOKEN not found in env — aborting.');
    process.exit(1);
  }
  console.log(`token present (${token.length} chars, not printed)`);

  // ── 1. metadata: does the tier see our stations? ─────────────────────────
  const meta = await get('/stations/metadata', { stid: STATIONS.join(',') }, token);
  const metaSummary = meta.body?.SUMMARY ?? {};
  console.log(`\n[metadata] http ${meta.status} · RESPONSE_CODE ${metaSummary.RESPONSE_CODE} · ${metaSummary.RESPONSE_MESSAGE ?? ''}`);
  const stations: any[] = meta.body?.STATION ?? [];
  for (const s of stations) {
    console.log(`  ${s.STID}  ${s.NAME}  (${s.COUNTRY ?? '?'}, tz ${s.TIMEZONE ?? '?'}, active ${s.STATUS ?? '?'})`);
  }
  const missing = STATIONS.filter((id) => !stations.some((s) => s.STID === id));
  if (missing.length) console.log(`  MISSING from tier: ${missing.join(', ')}`);

  // ── 2. latest obs ────────────────────────────────────────────────────────
  const latest = await get('/stations/latest', { stid: STATIONS.join(','), vars: 'air_temp', units: 'metric' }, token);
  console.log(`\n[latest] http ${latest.status} · RESPONSE_CODE ${latest.body?.SUMMARY?.RESPONSE_CODE}`);
  for (const s of latest.body?.STATION ?? []) {
    const t = s.OBSERVATIONS?.air_temp_value_1;
    console.log(`  ${s.STID}  air_temp ${t?.value ?? '—'}°C @ ${t?.date_time ?? '—'}`);
  }

  // ── 3. timeseries cadence: hfmetars on vs off, US vs intl ────────────────
  for (const [label, params] of [
    ['hf-on', { hfmetars: '1' }],
    ['hf-off', { hfmetars: '0' }],
  ] as const) {
    const ts = await get('/stations/timeseries', {
      stid: STATIONS.join(','),
      recent: '120',
      vars: 'air_temp',
      units: 'metric',
      ...params,
    }, token);
    console.log(`\n[timeseries ${label}] http ${ts.status} · RESPONSE_CODE ${ts.body?.SUMMARY?.RESPONSE_CODE} · DATA_QUERY_TIME ${ts.body?.SUMMARY?.DATA_QUERY_TIME ?? '?'}`);
    for (const s of ts.body?.STATION ?? []) {
      const times: string[] = s.OBSERVATIONS?.date_time ?? [];
      const temps: number[] = s.OBSERVATIONS?.air_temp_set_1 ?? [];
      console.log(`  ${s.STID}  obs ${times.length} in 120min · cadence ${cadence(times)} · last ${temps.at(-1) ?? '—'}°C`);
    }
    if (label === 'hf-on' && ts.status === 200) {
      mkdirSync('research', { recursive: true });
      writeFileSync('research/synoptic_timeseries_mixed.json', JSON.stringify(ts.body, null, 2));
      console.log('  fixture → research/synoptic_timeseries_mixed.json');
    }
  }

  console.log('\nDone. (Free tier: 5,000 requests + 5M service units / month — this run used 4 requests.)');
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
// (probe-intl appended 2026-07-25: run with --intl to test international coverage forms)
