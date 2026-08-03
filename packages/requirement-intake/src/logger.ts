/**
 * Requirements Intake — structured logging.
 *
 * The service logs identifiers and safe metadata only. Request content,
 * answers, and attachments are NEVER passed to the logger, so no secret or
 * sensitive requirement content can leak into logs.
 */

export interface IntakeLogFields {
  [key: string]: string | number | boolean | undefined;
}

export interface IntakeLogger {
  info(scope: string, message: string, fields?: IntakeLogFields): void;
  warn(scope: string, message: string, fields?: IntakeLogFields): void;
  error(scope: string, message: string, fields?: IntakeLogFields): void;
}

/** Default logger — silent. Hosts may wire their own structured logger. */
export class NoopIntakeLogger implements IntakeLogger {
  info(_scope: string, _message: string, _fields?: IntakeLogFields): void {}
  warn(_scope: string, _message: string, _fields?: IntakeLogFields): void {}
  error(_scope: string, _message: string, _fields?: IntakeLogFields): void {}
}

/** In-memory logger for tests. */
export class InMemoryIntakeLogger implements IntakeLogger {
  readonly entries: Array<{
    level: 'info' | 'warn' | 'error';
    scope: string;
    message: string;
    fields?: IntakeLogFields | undefined;
  }> = [];

  info(scope: string, message: string, fields?: IntakeLogFields): void {
    this.entries.push({
      level: 'info',
      scope,
      message,
      ...(fields !== undefined ? { fields } : {}),
    });
  }

  warn(scope: string, message: string, fields?: IntakeLogFields): void {
    this.entries.push({
      level: 'warn',
      scope,
      message,
      ...(fields !== undefined ? { fields } : {}),
    });
  }

  error(scope: string, message: string, fields?: IntakeLogFields): void {
    this.entries.push({
      level: 'error',
      scope,
      message,
      ...(fields !== undefined ? { fields } : {}),
    });
  }
}
