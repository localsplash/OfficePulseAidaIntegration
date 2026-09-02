/** Typed service errors mapped onto HTTP statuses at the API edge. */

export class ValidationError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class UpstreamError extends Error {
  readonly status = 502;
  constructor(
    message: string,
    readonly stage?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class DependencyUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'DependencyUnavailableError';
  }
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}
