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
    expect(offenders('@polymarket/clob-client', (p) => p.startsWith('packages/trading/'))).toEqual([]);
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
