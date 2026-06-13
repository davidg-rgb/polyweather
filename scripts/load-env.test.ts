/**
 * Tests for the dep-free .env loader (scripts/lib/load-env.ts).
 * parseEnv is pure; loadEnv is exercised against an isolated temp dir so it
 * never touches the repo's real .env.local.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv, loadEnv } from './lib/load-env.ts';

describe('parseEnv (§11.2 dotenv-lite)', () => {
  it('parses a bare KEY=VALUE and trims surrounding whitespace', () => {
    expect(parseEnv('FOO=bar')).toEqual({ FOO: 'bar' });
    expect(parseEnv('  FOO =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('keeps every char after the FIRST = (URLs with ?sslmode=require survive)', () => {
    const url = 'postgresql://postgres.abc:p%40ss@aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require';
    expect(parseEnv(`DATABASE_URL=${url}`)).toEqual({ DATABASE_URL: url });
  });

  it('strips double and single quotes without touching the inner value', () => {
    expect(parseEnv('A="b c"')).toEqual({ A: 'b c' });
    expect(parseEnv("A='b c'")).toEqual({ A: 'b c' });
    // a # inside quotes is part of the value, not a comment
    expect(parseEnv('PW="se#cret"')).toEqual({ PW: 'se#cret' });
  });

  it('skips blank lines and #-comment lines; honours an `export ` prefix', () => {
    const body = '\n# a comment\n\nexport FOO=bar\n   # indented comment\nBAZ=qux\n';
    expect(parseEnv(body)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips an inline comment only when the # is preceded by whitespace', () => {
    expect(parseEnv('FOO=bar # trailing comment')).toEqual({ FOO: 'bar' });
    expect(parseEnv('FOO=a#b')).toEqual({ FOO: 'a#b' }); // no space → kept verbatim
    expect(parseEnv('FOO=   # only a comment')).toEqual({ FOO: '' }); // empty value
  });

  it('handles CRLF line endings', () => {
    expect(parseEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('loadEnv (no-override + precedence)', () => {
  const created: string[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const k of created.splice(0)) delete process.env[k];
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmp(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'weather-edge-env-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it('sets a key only present in the file', () => {
    created.push('LOADENV_ONLY_FILE');
    delete process.env['LOADENV_ONLY_FILE'];
    const dir = tmp({ '.env.local': 'LOADENV_ONLY_FILE=fromfile' });
    const loaded = loadEnv(dir);
    expect(loaded).toEqual(['.env.local']);
    expect(process.env['LOADENV_ONLY_FILE']).toBe('fromfile');
  });

  it('never overrides a key already set in process.env (shell wins)', () => {
    created.push('LOADENV_SHELL_WINS');
    process.env['LOADENV_SHELL_WINS'] = 'fromshell';
    const dir = tmp({ '.env.local': 'LOADENV_SHELL_WINS=fromfile' });
    loadEnv(dir);
    expect(process.env['LOADENV_SHELL_WINS']).toBe('fromshell');
  });

  it('.env.local wins over .env for the same key', () => {
    created.push('LOADENV_PREC', 'LOADENV_BASE_ONLY');
    delete process.env['LOADENV_PREC'];
    delete process.env['LOADENV_BASE_ONLY'];
    const dir = tmp({
      '.env.local': 'LOADENV_PREC=local',
      '.env': 'LOADENV_PREC=base\nLOADENV_BASE_ONLY=base2',
    });
    const loaded = loadEnv(dir);
    expect(loaded).toEqual(['.env.local', '.env']);
    expect(process.env['LOADENV_PREC']).toBe('local');
    expect(process.env['LOADENV_BASE_ONLY']).toBe('base2');
  });

  it('returns an empty list when neither file exists', () => {
    const dir = tmp({});
    expect(loadEnv(dir)).toEqual([]);
  });
});
