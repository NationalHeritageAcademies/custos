import type { StatementAnalysis } from './safety';

/** Base class for every error Custos raises intentionally. */
export class CustosError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    // `new.target` gives the concrete subclass name even after transpilation.
    this.name = new.target.name;
    this.code = code;
  }
}

export class UnknownDriverError extends CustosError {
  constructor(driverId: string) {
    super('UNKNOWN_DRIVER', `No driver is registered with id "${driverId}".`);
  }
}

export class DuplicateDriverError extends CustosError {
  constructor(driverId: string) {
    super('DUPLICATE_DRIVER', `A driver with id "${driverId}" is already registered.`);
  }
}

export class ConnectionError extends CustosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONNECTION_ERROR', message, options);
  }
}

export class QueryError extends CustosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('QUERY_ERROR', message, options);
  }
}

/** Raised when a write/DDL statement is run on a read-only connection. */
export class ReadOnlyViolationError extends CustosError {
  constructor(statementKind: string) {
    super(
      'READ_ONLY_VIOLATION',
      `This connection is read-only; refusing to run a "${statementKind}" statement.`,
    );
  }
}

/**
 * Raised when an auth mode needs an interactive sign-in that has not happened
 * yet (or whose session has lapsed). The renderer reacts to the code by opening
 * the sign-in dialog and retrying the original call once the user is through.
 */
export class SignInRequiredError extends CustosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('SIGN_IN_REQUIRED', message, options);
  }
}

/**
 * Raised when a batch contains a destructive statement that has not yet been
 * confirmed by the user. Carries the per-statement analysis so the renderer can
 * explain exactly what needs confirming.
 */
export class ConfirmationRequiredError extends CustosError {
  readonly analyses: StatementAnalysis[];

  constructor(analyses: StatementAnalysis[]) {
    super('CONFIRMATION_REQUIRED', 'This statement requires confirmation before it can run.');
    this.analyses = analyses;
  }
}
