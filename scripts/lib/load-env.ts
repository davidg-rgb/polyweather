/**
 * scripts/lib/load-env — dep-free `.env.local` / `.env` loader for the CLIs (§11.2).
 *
 * The scripts read wiring (DATABASE_URL, OPENMETEO_API_KEY, …) straight from
 * `process.env`, but `tsx` does NOT auto-load dotenv files — so a value sitting
 * in `.env.local` was never picked up (the RUNBOOK assumed it was). This loads
 * `.env.local` then `.env` into `process.env` WITHOUT overriding anything that
 * is already set, so a shell export / CI var always wins and `.env.local` wins
 * over `.env`. Matches the project's dep-light idiom (cf. lib/csv.ts).
 *
 * NB: this is the application reading its OWN config at runtime — it never
 * prints a value. Secrets stay out of stdout (see scripts/check-db.ts).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse a dotenv file body into key/value pairs. Dep-free and intentionally
 * small, but handles the cases this repo's files actually use: `export ` prefix,
 * blank / `#`-comment lines, single/double-quoted values, and inline comments on
 * unquoted values (a `#` at the start or preceded by whitespace). A `#` with no
 * surrounding space is kept verbatim, so an unquoted token may contain one —
 * though a properly percent-encoded URL never does.
 */
export function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    if (!key) continue;
    let value = stripped.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, 1);
      value = close === -1 ? value.slice(1) : value.slice(1, close);
    } else if (value.startsWith('#')) {
      value = '';
    } else {
      const inline = value.search(/\s#/);
      if (inline !== -1) value = value.slice(0, inline).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env.local` then `.env` into `process.env` (existing keys never
 * overwritten, so a shell export / CI var always wins). With no argument it
 * scans `process.cwd()` then the repo root inferred from this module's path;
 * pass an explicit `rootDir` to scan ONLY that directory (used by tests for
 * isolation). Returns the basenames of the files actually applied — non-secret,
 * for "which file did we read" diagnostics.
 */
export function loadEnv(rootDir?: string): string[] {
  const roots: string[] =
    rootDir !== undefined
      ? [rootDir]
      : [process.cwd(), resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')];

  const loaded: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const name of ['.env.local', '.env']) {
      const path = join(root, name);
      if (seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(path)) continue;
      let parsed: Record<string, string>;
      try {
        parsed = parseEnv(readFileSync(path, 'utf8'));
      } catch {
        continue; // best-effort: an unreadable env file must not crash the CLI
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      loaded.push(name);
    }
  }
  return loaded;
}
