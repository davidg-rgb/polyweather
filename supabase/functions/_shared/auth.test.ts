import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, ConfigError } from '../../../packages/core/src/index.ts';
import { getEnv, requireCronAuth } from './auth.ts';

const GOOD_SECRET = 'test-secret-0123456789abcdef-0123456789abcdef';

const reqWith = (secret?: string) =>
  new Request('https://x.functions.supabase.co/poll-markets', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });

describe('requireCronAuth (§6.12, §11.5)', () => {
  beforeEach(() => {
    process.env['CRON_SECRET'] = GOOD_SECRET;
  });
  afterEach(() => {
    delete process.env['CRON_SECRET'];
  });

  it('passes with the exact secret', () => {
    expect(() => requireCronAuth(reqWith(GOOD_SECRET))).not.toThrow();
  });

  it('AuthError (401) on wrong or missing header', () => {
    expect(() => requireCronAuth(reqWith('wrong-secret-wrong-secret-wrong-secret'))).toThrow(AuthError);
    expect(() => requireCronAuth(reqWith())).toThrow(AuthError);
    try {
      requireCronAuth(reqWith());
    } catch (e) {
      expect((e as AuthError).httpStatus).toBe(401);
    }
  });

  it('rejects prefixes and extensions of the real secret', () => {
    expect(() => requireCronAuth(reqWith(GOOD_SECRET.slice(0, -1)))).toThrow(AuthError);
    expect(() => requireCronAuth(reqWith(GOOD_SECRET + 'x'))).toThrow(AuthError);
  });

  it('fails CLOSED when CRON_SECRET is missing or under 32 chars', () => {
    delete process.env['CRON_SECRET'];
    expect(() => requireCronAuth(reqWith(GOOD_SECRET))).toThrow(ConfigError);
    process.env['CRON_SECRET'] = 'short';
    expect(() => requireCronAuth(reqWith('short'))).toThrow(ConfigError);
  });

  it('getEnv reads process.env under Node', () => {
    expect(getEnv('CRON_SECRET')).toBe(GOOD_SECRET);
    expect(getEnv('DEFINITELY_NOT_SET_XYZ')).toBeUndefined();
  });
});
