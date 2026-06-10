/**
 * Error taxonomy (ARCHITECTURE.md §11.1).
 *
 * Policy: recorded gap ≠ error. A missing model horizon day, an unfinalized
 * observation, or a skipped unbettable event is DATA (flags/columns), not an
 * exception. Exceptions are for "the world changed shape" and "the math went
 * impossible," and they always reach job_runs + Slack.
 */

export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: string;
  readonly details: ErrorDetails | undefined;
  /** HTTP status this error maps to when it crosses an HTTP boundary; undefined for internal-only errors. */
  readonly httpStatus: number | undefined;

  constructor(code: string, message: string, details?: ErrorDetails, httpStatus?: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

/** Invalid config rows; fail-fast at job start. Lists every invalid key in details. */
export class ConfigError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_CONFIG', message, details);
  }
}

/** Bad operator API input (400). */
export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_VALIDATION', message, details, 400);
  }
}

/** Session/cron-secret failures (401). */
export class AuthError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_AUTH', message, details, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_NOT_FOUND', message, details, 404);
  }
}

export type ConflictCode = 'ERR_ALREADY_RAN' | 'ERR_BAD_STATUS';

/** Idempotency conflicts (409): ERR_ALREADY_RAN (job period), ERR_BAD_STATUS (bet state machine). */
export class ConflictError extends AppError {
  constructor(code: ConflictCode, message: string, details?: ErrorDetails) {
    super(code, message, details, 409);
  }
}

/** External API failure after retries (502). Carries source + status + retryability (fetchJson §6.12). */
export class UpstreamError extends AppError {
  readonly source: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    info: { source: string; status: number; retryable: boolean },
    details?: ErrorDetails,
  ) {
    super('ERR_UPSTREAM', message, { ...details, ...info }, 502);
    this.source = info.source;
    this.status = info.status;
    this.retryable = info.retryable;
  }
}

/**
 * An upstream changed shape or internal math hit an impossible state.
 * Never silently swallowed: store flagged row OR fail run + alert.
 */
export class DataIntegrityError extends AppError {
  constructor(code: string, message: string, details?: ErrorDetails) {
    super(code, message, details);
  }
}

export class GammaShapeError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_GAMMA_SHAPE', message, details);
  }
}

export class ClobShapeError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_CLOB_SHAPE', message, details);
  }
}

export class OpenMeteoShapeError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_OPENMETEO_SHAPE', message, details);
  }
}

export class WuShapeError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_WU_SHAPE', message, details);
  }
}

/** Unknown bucket label shape — the parser never guesses (§6.3). */
export class BucketParseError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_BUCKET_PARSE', message, details);
  }
}

/** A value fell outside every bucket of a supposedly continuous ladder (§6.3). */
export class LadderGapError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_LADDER_GAP', message, details);
  }
}

/** True Kelly domain violations only: p ≤ 0 or q outside [0,1] (§6.8). */
export class KellyDomainError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_KELLY_DOMAIN', message, details);
  }
}

/** Probability math hit an impossible state, e.g. σ ≤ 0.2 in gaussianBucketProbs (§6.5). */
export class DistributionError extends DataIntegrityError {
  constructor(message: string, details?: ErrorDetails) {
    super('ERR_DISTRIBUTION', message, details);
  }
}

/** Execution-path failures (§6.20/§6.20a). */
export class ExecutionError extends AppError {
  constructor(code: string, message: string, details?: ErrorDetails, httpStatus?: number) {
    super(code, message, details, httpStatus);
  }
}

export type FillRejectedReason = 'stale_book' | 'caps' | 'cas_lost' | string;

/** A fill could not be performed; reason 'stale_book' maps to the 422 path (§6.20). */
export class FillRejected extends ExecutionError {
  readonly reason: FillRejectedReason;

  constructor(reason: FillRejectedReason, message?: string, details?: ErrorDetails) {
    super('ERR_FILL_REJECTED', message ?? `fill rejected: ${reason}`, { ...details, reason }, 422);
    this.reason = reason;
  }
}

/** goLiveGate refused live execution; reasons relayed verbatim to the operator (503 path, C1). */
export class GateError extends ExecutionError {
  readonly reasons: string[];

  constructor(reasons: string[], details?: ErrorDetails) {
    super('ERR_GATE', `go-live gate closed: ${reasons.join('; ')}`, { ...details, reasons }, 503);
    this.reasons = reasons;
  }
}
