/**
 * Requirements Intake — typed errors.
 *
 * Every failure path throws an `IntakeError` subclass carrying a stable
 * `code` so hosts can map them to HTTP statuses, CLI messages, or events.
 */

export type IntakeErrorCode =
  | 'INTAKE_VALIDATION_ERROR'
  | 'INTAKE_NOT_FOUND'
  | 'INTAKE_INVALID_TRANSITION'
  | 'INTAKE_STATUS_LOCKED'
  | 'INTAKE_CONFLICT'
  | 'INTAKE_UNAUTHORIZED'
  | 'INTAKE_SUGGESTION_ERROR';

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;
  constructor(code: IntakeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IntakeError';
    this.code = code;
  }
}

/** One field-level validation problem. */
export interface IntakeValidationIssue {
  /** Path of the offending field, e.g. `originalRequest` or `metadata.foo`. */
  field: string;
  message: string;
}

export class IntakeValidationError extends IntakeError {
  readonly issues: IntakeValidationIssue[];
  constructor(issues: IntakeValidationIssue[], message?: string) {
    super(
      'INTAKE_VALIDATION_ERROR',
      message ??
        `Requirement intake validation failed (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    );
    this.name = 'IntakeValidationError';
    this.issues = issues;
  }
}

export class IntakeNotFoundError extends IntakeError {
  constructor(id: string) {
    super('INTAKE_NOT_FOUND', `Requirement intake record not found: ${id}`);
    this.name = 'IntakeNotFoundError';
  }
}

export class IntakeStateTransitionError extends IntakeError {
  constructor(from: string, to: string) {
    super(
      'INTAKE_INVALID_TRANSITION',
      `Invalid requirement intake status transition: ${from} → ${to}`,
    );
    this.name = 'IntakeStateTransitionError';
  }
}

/** Raised when mutating a record whose status locks its content. */
export class IntakeStatusLockedError extends IntakeError {
  constructor(id: string, status: string, action: string) {
    super(
      'INTAKE_STATUS_LOCKED',
      `Requirement intake ${id} is ${status} and cannot be modified via ${action}`,
    );
    this.name = 'IntakeStatusLockedError';
  }
}

/** Raised on optimistic-concurrency version mismatch. */
export class IntakeConflictError extends IntakeError {
  constructor(id: string, expectedVersion: number, actualVersion: number) {
    super(
      'INTAKE_CONFLICT',
      `Requirement intake ${id} was modified concurrently (expected version ${expectedVersion}, found ${actualVersion})`,
    );
    this.name = 'IntakeConflictError';
  }
}

export class IntakeAuthorizationError extends IntakeError {
  constructor(operation: string, actorId: string, projectId: string) {
    super(
      'INTAKE_UNAUTHORIZED',
      `Actor ${actorId} is not authorized to ${operation} requirement intakes for project ${projectId}`,
    );
    this.name = 'IntakeAuthorizationError';
  }
}

/** Raised when the LLM suggestion pipeline fails or returns malformed output. */
export class IntakeSuggestionError extends IntakeError {
  constructor(message: string, options?: ErrorOptions) {
    super('INTAKE_SUGGESTION_ERROR', message, options);
    this.name = 'IntakeSuggestionError';
  }
}
