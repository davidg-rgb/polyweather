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
    // Two non-executing mentions are allowed: execute-bet/index.ts carries
    // LITERAL eszip npm-snapshot hints (the deploy bundler can't see live.ts's
    // non-literal specifiers — hosted incident 2026-06-11), and the ambient
    // npm-specifiers.d.ts declares those literals for tsc. Neither constructs
    // a client; the runtime boundary stays inside packages/trading.
    expect(
      offenders(
        '@polymarket/clob-client',
        (p) =>
          p.startsWith('packages/trading/') ||
          p === 'supabase/functions/execute-bet/index.ts' ||
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

  it('packages/trading is imported only by execute-bet + the web gate-readout', () => {
    const importsTrading = /from\s+['"][^'"]*(?:packages\/trading|@weather-edge\/trading)[^'"]*['"]/;
    expect(
      offenders(
        importsTrading,
        (p) =>
          p.startsWith('packages/trading/') ||
          p.startsWith('supabase/functions/execute-bet/') ||
          p.startsWith('apps/web/') ||
          p.endsWith('.test.ts'),
      ),
    ).toEqual([]);
  });
});
