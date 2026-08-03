/**
 * Requirements Intake — deterministic lifecycle.
 *
 * Status transitions are enforced by application logic. The LLM never
 * changes status directly; it may only *suggest* information that moves a
 * draft into `collecting_information` through the service.
 */
import { INTAKE_STATUSES, type IntakeStatus } from './constants.js';
import { IntakeStateTransitionError } from './errors.js';

export const ALLOWED_TRANSITIONS: Readonly<Record<IntakeStatus, readonly IntakeStatus[]>> = {
  draft: ['collecting_information', 'submitted', 'cancelled'],
  collecting_information: ['submitted', 'cancelled'],
  submitted: ['archived'],
  cancelled: ['archived'],
  archived: [],
};

/**
 * Statuses whose content may still be edited. Submitted, cancelled, and
 * archived records are locked (except for lifecycle operations).
 */
export const MUTABLE_STATUSES: readonly IntakeStatus[] = ['draft', 'collecting_information'];

export function canTransition(from: IntakeStatus, to: IntakeStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throw `IntakeStateTransitionError` when the transition is not allowed. */
export function assertTransition(from: IntakeStatus, to: IntakeStatus): void {
  if (!canTransition(from, to)) {
    throw new IntakeStateTransitionError(from, to);
  }
}

export function isMutableStatus(status: IntakeStatus): boolean {
  return MUTABLE_STATUSES.includes(status);
}

export function isTerminalStatus(status: IntakeStatus): boolean {
  return status === 'submitted' || status === 'cancelled' || status === 'archived';
}

export function isKnownStatus(value: string): value is IntakeStatus {
  return (INTAKE_STATUSES as readonly string[]).includes(value);
}
