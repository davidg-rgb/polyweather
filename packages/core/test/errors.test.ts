import { describe, expect, it } from 'vitest';
import {
  AppError,
  AuthError,
  BucketParseError,
  ClobShapeError,
  ConfigError,
  ConflictError,
  DataIntegrityError,
  DistributionError,
  ExecutionError,
  FillRejected,
  GammaShapeError,
  GateError,
  KellyDomainError,
  LadderGapError,
  NotFoundError,
  OpenMeteoShapeError,
  UpstreamError,
  ValidationError,
  WuShapeError,
} from '../src/errors.ts';

describe('error taxonomy (§11.1)', () => {
  it('every error is an AppError and a native Error with name/code/message', () => {
    const e = new ConfigError('bad keys', { keys: ['maxSpread'] });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
    expect(e.name).toBe('ConfigError');
    expect(e.code).toBe('ERR_CONFIG');
    expect(e.message).toBe('bad keys');
    expect(e.details).toEqual({ keys: ['maxSpread'] });
  });

  it('HTTP-mapped errors carry their status', () => {
    expect(new ValidationError('x').httpStatus).toBe(400);
    expect(new AuthError('x').httpStatus).toBe(401);
    expect(new NotFoundError('x').httpStatus).toBe(404);
    expect(new ConflictError('ERR_ALREADY_RAN', 'x').httpStatus).toBe(409);
    expect(new UpstreamError('x', { source: 'gamma', status: 500, retryable: true }).httpStatus).toBe(502);
    expect(new ConfigError('x').httpStatus).toBeUndefined();
  });

  it('ConflictError carries the idempotency code variants', () => {
    expect(new ConflictError('ERR_ALREADY_RAN', 'dup period').code).toBe('ERR_ALREADY_RAN');
    expect(new ConflictError('ERR_BAD_STATUS', 'not recommended').code).toBe('ERR_BAD_STATUS');
  });

  it('UpstreamError exposes source, status, retryable as fields and in details', () => {
    const e = new UpstreamError('gamma 503', { source: 'gamma', status: 503, retryable: true });
    expect(e.source).toBe('gamma');
    expect(e.status).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.details).toMatchObject({ source: 'gamma', status: 503, retryable: true });
  });

  it('DataIntegrityError subtypes chain instanceof and use distinct codes', () => {
    const cases: Array<[DataIntegrityError, string]> = [
      [new GammaShapeError('x'), 'ERR_GAMMA_SHAPE'],
      [new ClobShapeError('x'), 'ERR_CLOB_SHAPE'],
      [new OpenMeteoShapeError('x'), 'ERR_OPENMETEO_SHAPE'],
      [new WuShapeError('x'), 'ERR_WU_SHAPE'],
      [new BucketParseError('x'), 'ERR_BUCKET_PARSE'],
      [new LadderGapError('x'), 'ERR_LADDER_GAP'],
      [new KellyDomainError('x'), 'ERR_KELLY_DOMAIN'],
      [new DistributionError('x'), 'ERR_DISTRIBUTION'],
    ];
    const codes = new Set<string>();
    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(DataIntegrityError);
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe(code);
      codes.add(code);
    }
    expect(codes.size).toBe(cases.length);
  });

  it("FillRejected('stale_book') is an ExecutionError on the 422 path with the reason recorded", () => {
    const e = new FillRejected('stale_book');
    expect(e).toBeInstanceOf(ExecutionError);
    expect(e.code).toBe('ERR_FILL_REJECTED');
    expect(e.reason).toBe('stale_book');
    expect(e.httpStatus).toBe(422);
    expect(e.details).toMatchObject({ reason: 'stale_book' });
    expect(e.message).toContain('stale_book');
  });

  it('GateError carries reasons verbatim on the 503 path', () => {
    const reasons = ['out-of-sample days 41 < 60', 'pooled bootstrap p 0.21 ≥ 0.05'];
    const e = new GateError(reasons);
    expect(e).toBeInstanceOf(ExecutionError);
    expect(e.code).toBe('ERR_GATE');
    expect(e.reasons).toEqual(reasons);
    expect(e.httpStatus).toBe(503);
    expect(e.message).toContain(reasons[0]);
    expect(e.message).toContain(reasons[1]);
  });
});
