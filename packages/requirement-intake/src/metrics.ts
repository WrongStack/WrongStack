/**
 * Requirements Intake — metrics.
 *
 * Lightweight counters/timers for the observability surface. The service
 * never records request content; only identifiers and outcome counts.
 */

export const INTAKE_COUNTERS = [
  'intake.created',
  'intake.submitted',
  'intake.cancelled',
  'intake.archived',
  'intake.duplicate_create',
  'intake.duplicate_submit',
  'intake.validation_failure',
  'intake.suggestions.requested',
  'intake.suggestions.succeeded',
  'intake.suggestions.failed',
  'intake.unauthorized_attempt',
] as const;

export type IntakeCounter = (typeof INTAKE_COUNTERS)[number];

export const INTAKE_TIMERS = ['intake.time_to_submit'] as const;

export type IntakeTimer = (typeof INTAKE_TIMERS)[number];

export interface IntakeMetrics {
  increment(counter: IntakeCounter, by?: number, labels?: Record<string, string>): void;
  recordDuration(timer: IntakeTimer, milliseconds: number): void;
}

/** Default metrics — silent. */
export class NoopIntakeMetrics implements IntakeMetrics {
  increment(_counter: IntakeCounter, _by?: number, _labels?: Record<string, string>): void {}
  recordDuration(_timer: IntakeTimer, _milliseconds: number): void {}
}

/** In-memory metrics for tests and lightweight hosts. */
export class InMemoryIntakeMetrics implements IntakeMetrics {
  readonly counters = new Map<string, number>();
  readonly durations = new Map<string, number[]>();

  increment(counter: IntakeCounter, by = 1, _labels?: Record<string, string>): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
  }

  recordDuration(timer: IntakeTimer, milliseconds: number): void {
    const bucket = this.durations.get(timer) ?? [];
    bucket.push(milliseconds);
    this.durations.set(timer, bucket);
  }

  count(counter: IntakeCounter): number {
    return this.counters.get(counter) ?? 0;
  }

  /** Sum of recorded durations for a timer, or undefined when none recorded. */
  durationSum(timer: IntakeTimer): number | undefined {
    const bucket = this.durations.get(timer);
    if (!bucket || bucket.length === 0) return undefined;
    return bucket.reduce((total, value) => total + value, 0);
  }
}
