/**
 * cheap-early-forward-regression — the handoff §5 "cheap regression check": the FORWARD engine
 * (core/sim/cheap-early-entry-replay → replayCheapEarlyEvent) must AGREE with the offline twin
 * (scripts/research/cheap-entry-realbook.py) on a shared event set.
 *
 * It replays the SAME opening-captures archive the Python read, over the SAME [24,36]h window × 0.20–0.33 ask
 * band, grading each event's house pick by TEMPERATURE (from live-winners.json — the SAME winners the Python
 * grades against, mapped to the winning bucket's idx so the TS engine's winnerIdx→label→temp path reproduces the
 * Python's temp compare), and compares the aggregate n / win-rate / mean net-return against the Python's
 * cheap-entry-realbook.json [24,36]/0.2-0.33 cell.
 *
 * It isolates the STRATEGY MATH (window selection · argmax-houseProb pick · band gate · label grade · net-return
 * formula) from the forward loop's ingest FRESH-universe filter (buildEvents) + its depth gate — both bypassed
 * here (EventReplayInput built directly; stakeUsd tiny so the depth gate is inert) so the comparison is
 * apples-to-apples with the depth-gate-free, fresh-filter-free Python twin. Read-only; prints a PASS/FAIL.
 *
 * Run:  pnpm tsx scripts/research/cheap-early-forward-regression.ts
 */
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';
import {
  replayCheapEarlyEvent,
  cheapEarlyCfg,
  parseTemp,
  type OpeningBucket,
} from '../../packages/core/src/index.ts';
import type { EventReplayInput, ReplayTick } from '../../packages/core/src/sim/opening-bracket-replay.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const ARCHIVE = join(OUT, 'opening-captures-archive');
const WINNERS = join(OUT, 'live-winners.json');
const PY_JSON = join(OUT, 'cheap-entry-realbook.json');
const LIVE = new Set(['ankara', 'helsinki', 'kuala-lumpur', 'wellington']);

interface RawArchiveRow {
  event_id: string | null;
  city: string | null;
  target_date: string | null;
  tz_name: string | null;
  resolves_at: string | null;
  captured_at: string;
  hours_since_listing: number | null;
  buckets: {
    idx: number; label: string | null; loF: number | null; hiF: number | null; mid: number | null;
    bestAsk: number | null; bestBid: number | null; execAsk: number | null; execBid: number | null;
    depthUsd: number | null; houseProb: number | null;
  }[] | null;
}

function toBucket(b: NonNullable<RawArchiveRow['buckets']>[number]): OpeningBucket {
  return {
    idx: b.idx, label: String(b.label ?? ''), loF: b.loF ?? null, hiF: b.hiF ?? null, mid: b.mid ?? null,
    bestAsk: b.bestAsk ?? null, execAsk: b.execAsk ?? null, depthUsd: b.depthUsd ?? 0,
    bestBid: b.bestBid ?? null, sellbackUsd: 0, execBid: b.execBid ?? null, sellbackDepthUsd: 0,
    houseProb: b.houseProb ?? null, tokenYes: '', tokenNo: '', conditionId: '',
  };
}

async function main(): Promise<void> {
  if (!existsSync(ARCHIVE) || !existsSync(WINNERS) || !existsSync(PY_JSON)) {
    console.error('missing archive / winners / cheap-entry-realbook.json — run cheap-entry-realbook.py first');
    process.exit(2);
  }
  const winners: Record<string, number> = JSON.parse(readFileSync(WINNERS, 'utf8'));

  // group archive rows into per-event tick series (LIVE cities + events present in winners) — NO fresh filter.
  const byEvent = new Map<string, RawArchiveRow[]>();
  const files: string[] = [];
  for await (const f of glob(join(ARCHIVE, 'part-*.ndjson.gz'))) files.push(f);
  files.sort();
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const r = JSON.parse(line) as RawArchiveRow;
      if (!r.city || !LIVE.has(r.city) || !r.event_id) continue;
      const key = `${r.city}|${r.target_date}`;
      if (!(key in winners)) continue;
      const arr = byEvent.get(r.event_id) ?? [];
      arr.push(r);
      byEvent.set(r.event_id, arr);
    }
  }

  // build EventReplayInput per event; winnerIdx = the idx of the bucket whose temp == the winner temp.
  const cfg = cheapEarlyCfg([...LIVE], { stakeUsd: 0.001 }); // tiny stake ⇒ the depth gate is inert (Python has none)
  const nets: number[] = [];
  let wins = 0;
  let n = 0;
  let zeroDepthInBand = 0;
  for (const [eventId, rs] of byEvent) {
    rs.sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime());
    const meta = rs[0]!;
    const winnerTemp = winners[`${meta.city}|${meta.target_date}`]!;
    const ticks: ReplayTick[] = rs.map((r) => ({
      capturedAt: r.captured_at,
      buckets: (r.buckets ?? []).map(toBucket),
      tz: String(r.tz_name ?? ''),
      targetDate: String(r.target_date ?? ''),
      hoursSinceListing: r.hours_since_listing ?? NaN,
    }));
    // winnerIdx: find any bucket across ticks whose parsed temp == the winner temp.
    let winnerIdx: number | null = null;
    for (const t of ticks) {
      for (const b of t.buckets) if (parseTemp(b.label) === winnerTemp) { winnerIdx = b.idx; break; }
      if (winnerIdx != null) break;
    }
    const resolvesAtMs = meta.resolves_at ? Date.parse(meta.resolves_at) : NaN;
    const input: EventReplayInput = {
      eventId, city: String(meta.city), targetDate: String(meta.target_date), tz: String(meta.tz_name ?? ''),
      ticks, resolution: { winnerIdx, gradingMismatch: false },
    };
    const t = replayCheapEarlyEvent(input, cfg, Number.isFinite(resolvesAtMs) ? resolvesAtMs : null);
    if (!t.entered) {
      if (t.reason === 'thin_depth') zeroDepthInBand++; // an in-band pick the (tiny) depth gate still dropped
      continue;
    }
    if (!Number.isFinite(t.netReturn)) continue;
    n++;
    nets.push(t.netReturn);
    if (t.won) wins++;
  }

  const mean = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : NaN;
  const winRate = n ? wins / n : NaN;

  // the Python's [24,36] / 0.2-0.33 cell.
  const py: { window: string; band: string; n: number; win: number; net: number }[] = JSON.parse(readFileSync(PY_JSON, 'utf8'));
  const cell = py.find((r) => r.window === '24-36' && r.band === '0.2-0.33');
  if (!cell) {
    console.error('no [24,36]/0.2-0.33 cell in cheap-entry-realbook.json');
    process.exit(2);
  }

  console.log('── cheap-early forward-engine vs. Python twin ([24,36]h × 0.20–0.33) ─────────────');
  console.log(`  events grouped (LIVE ∩ winners): ${byEvent.size}`);
  console.log(`  TS engine :  n=${n}  win=${(winRate * 100).toFixed(0)}%  meanNet=${(mean * 100).toFixed(1)}%  (in-band zero-depth dropped: ${zeroDepthInBand})`);
  console.log(`  Python    :  n=${cell.n}  win=${(cell.win * 100).toFixed(0)}%  meanNet=${(cell.net * 100).toFixed(1)}%`);

  // agreement: n matches within the count of in-band zero-depth picks (which the tiny depth gate still drops but
  // the Python keeps), and win-rate / mean net-return match to a tight tolerance.
  const nOk = Math.abs(n - cell.n) <= zeroDepthInBand + 1;
  const winOk = Number.isFinite(winRate) && Number.isFinite(cell.win) && Math.abs(winRate - cell.win) <= 0.02;
  const netOk = Number.isFinite(mean) && Number.isFinite(cell.net) && Math.abs(mean - cell.net) <= 0.03;
  const pass = nOk && winOk && netOk;
  console.log(`  agreement :  n ${nOk ? '✓' : '✗'} · win ${winOk ? '✓' : '✗'} · net ${netOk ? '✓' : '✗'}`);
  console.log(pass ? '  RESULT: PASS — the forward engine reproduces the offline twin.' : '  RESULT: FAIL — engines diverge (investigate).');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
