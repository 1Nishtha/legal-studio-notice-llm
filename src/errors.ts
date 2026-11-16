/**
 * Error kinds are exactly the backend's LlmErrorKind values, so the backend adapter can map
 * them 1:1 and keep its retry rules (retryable errors are retried by its job queue).
 */
export const ERROR_KINDS = ["not_configured", "refusal", "max_tokens", "invalid_json", "bad_request", "auth", "rate_limit", "overloaded", "timeout", "api"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

const STATUS: Record<ErrorKind, number> = {
  not_configured: 503,
  refusal: 422,
  max_tokens: 422,
  invalid_json: 422,
  bad_request: 400,
  auth: 401,
  rate_limit: 429,
  overloaded: 503,
  timeout: 504,
  api: 502,
};

export class ServiceError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }

  get status(): number {
    return STATUS[this.kind];
  }

  toJSON(): { kind: ErrorKind; message: string; retryable: boolean; details?: Record<string, unknown> } {
    return { kind: this.kind, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) };
  }
}
