/**
 * §15 trading-boundary grep invariants (ADR-10, §11.5):
 *   1. POLY_PRIVATE_KEY is read NOWHERE outside packages/trading.
 *   2. The clob client is imported NOWHERE outside packages/trading.
 *   3. packages/trading is imported only by execute-bet and the web
 *      gate-readout (plus test files, which exercise the boundary).
 *
 * Scans the real source tree on every test run — drift fails CI.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CODE_DIRS = ['packages', 'supabase', 'scripts', 'apps'];
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.sql'];
// .next is web's gitignored build output — the server bundle legitimately
// contains the compiled goLiveGate from the allowed importer; the invariant
// guards the SOURCE tree.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (EXTS.some((e) => name.endsWith(e))) yield full;
  }
}

const files = CODE_DIRS.flatMap((d) => [...walk(join(ROOT, d))]);
const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');
const offenders = (needle: string | RegExp, allowed: (path: string) => boolean): string[] =>
  files
    .filter((f) => {
      const path = rel(f);
      if (allowed(path)) return false;
      const text = readFileSync(f, 'utf8');
      return typeof needle === 'string' ? text.includes(needle) : needle.test(text);
    })
    .map(rel);

describe('trading boundary invariants (§15)', () => {
  it('scans a real tree (sanity: the known-allowed files exist)', () => {
    const paths = files.map(rel);
    expect(paths).toContain('packages/trading/src/live.ts');
    expect(paths).toContain('supabase/functions/execute-bet/handler.ts');
  });

  it('POLY_PRIVATE_KEY is read nowhere outside packages/trading', () => {
    // String split so this file does not flag itself.
    const KEY = 'POLY_' + 'PRIVATE_KEY';
    expect(offenders(KEY, (p) => p.startsWith('packages/trading/'))).toEqual([]);
  });

  it('the clob client is imported nowhere outside packages/trading', () => {
    // Non-executing mentions are allowed: execute-bet/index.ts + buy-table-tick/index.ts +
    // account-snapshot/index.ts (F-032, 2026-07-19 — its credentialed cash read boots the same lazy
    // client) carry LITERAL eszip npm-snapshot hints (the deploy bundler can't see live.ts's
    // non-literal specifiers — hosted incident 2026-06-11), and the ambient
    // npm-specifiers.d.ts declares those literals for tsc. None constructs
    // a client; the runtime boundary stays inside packages/trading.
    // clob-sdk-probe is the ONE constructing exception (C46): a KEYLESS diagnostic that walks the SDK
    // path with a Wallet.createRandom() throwaway — it reads NO POLY_* env (the invariant above still
    // proves the KEY stays inside packages/trading, probe included) and cannot place a fillable order.
    expect(
      offenders(
        '@polymarket/clob-client',
        (p) =>
          p.startsWith('packages/trading/') ||
          p === 'supabase/functions/execute-bet/index.ts' ||
          p === 'supabase/functions/buy-table-tick/index.ts' ||
          p === 'supabase/functions/account-snapshot/index.ts' ||
          p === 'supabase/functions/clob-sdk-probe/index.ts' ||
          p === 'supabase/functions/_shared/npm-specifiers.d.ts',
      ),
    ).toEqual([]);
  });

  it('eszip hints in execute-bet/index.ts stay in lockstep with live.ts + the .d.ts', () => {
    // live.ts hides its npm: specifiers from webpack via non-literal import(),
    // which also hides them from the deploy-time eszip bundler. The literal
    // hints in execute-bet/index.ts are what puts them in the npm snapshot —
    // the runtime resolves live.ts's constraint strings against it, so the
    // strings must match VERBATIM. Every npm: literal must also be declared
    // ambient for tsc.
    const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
    const liveSpecs = [...read('packages/trading/src/live.ts').matchAll(/'(npm:[^']+)'/g)].map(
      (m) => m[1],
    );
    expect(liveSpecs.length).toBeGreaterThanOrEqual(2); // ethers + clob-client
    const hints = read('supabase/functions/execute-bet/index.ts');
    for (const spec of liveSpecs) {
      expect(hints, `execute-bet/index.ts missing eszip hint import('${spec}')`).toContain(
        `import('${spec}')`,
      );
    }
    const declared = read('supabase/functions/_shared/npm-specifiers.d.ts');
    const fnNpmLiterals = files
      .filter((f) => rel(f).startsWith('supabase/functions/') && !rel(f).endsWith('.d.ts'))
      .flatMap((f) => [
        ...readFileSync(f, 'utf8').matchAll(/import\((?:\/\* @vite-ignore \*\/ )?'(npm:[^']+)'\)/g),
      ])
      .map((m) => m[1]);
    expect(fnNpmLiterals.length).toBeGreaterThanOrEqual(3); // supabase-js + the two hints
    for (const spec of new Set(fnNpmLiterals)) {
      expect(declared, `npm-specifiers.d.ts missing declare module '${spec}'`).toContain(
        `declare module '${spec}'`,
      );
    }
  });

  it('packages/trading is imported only by execute-bet, buy-table-tick, the web gate-readout, + the T2 live-rail daemon', () => {
    // The T2 LIVE-RAIL lane adds a LOCAL daemon (scripts/trade-bot.ts) + a credential smoke
    // (scripts/trade-smoke.ts) that DRIVE the T1 MakerExecutor — so they legitimately import
    // packages/trading (the executor, the tradeConfig/gate reads, the createClobClient seam). The 0095
    // BUY-TABLE cloud lane (supabase/functions/buy-table-tick) drives the SAME executor from an Edge tick
    // (the execute-bet precedent). §15's real guarantee is UNCHANGED: the key + the clob client stay
    // inside packages/trading/live.ts (the two grep invariants above still pass — these files never name
    // POLY_PRIVATE_KEY nor import @polymarket/clob-client). trade-bot-decide.ts + city-live-decide.ts
    // (the pure decision spines) + trading-db.ts (the ScriptDb→TradingDb adapter) import only TYPES +
    // redaction/intent-key helpers.
    const importsTrading = /from\s+['"][^'"]*(?:packages\/trading|@weather-edge\/trading)[^'"]*['"]/;
    expect(
      offenders(
        importsTrading,
        (p) =>
          p.startsWith('packages/trading/') ||
          p.startsWith('supabase/functions/execute-bet/') ||
          p.startsWith('supabase/functions/buy-table-tick/') ||
          p.startsWith('apps/web/') ||
          p === 'scripts/trade-bot.ts' ||
          p === 'scripts/trade-smoke.ts' ||
          // C46d identity tool: imports ONLY deriveOwnerIdentity (public-class facts; the key derivation
          // stays inside live.ts — invariant #1 above proves the key is never read in the script itself).
          p === 'scripts/derive-deposit-wallet.ts' ||
          p === 'scripts/lib/trade-bot-decide.ts' ||
          p === 'scripts/lib/city-live-decide.ts' ||
          p === 'scripts/lib/trading-db.ts' ||
          p.endsWith('.test.ts'),
      ),
    ).toEqual([]);
  });
});
