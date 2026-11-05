import type { TFunction } from 'i18next';

/**
 * Display labels for Kanban enum values. The values themselves are data — they
 * are stored on the board and sent to the engine — so only what the user reads
 * goes through the catalog, and an unknown value is shown as it is.
 */

export const ROUTING_MODE_KEYS: Record<string, string> = {
  session: 'activity:kanbanText.routingMode.session',
  fixed: 'activity:kanbanText.routingMode.fixed',
  fallback_profile: 'activity:kanbanText.routingMode.fallbackProfile',
};

export const RETRY_POLICY_KEYS: Record<string, string> = {
  off: 'activity:kanbanText.retryPolicy.off',
  incremental: 'activity:kanbanText.retryPolicy.incremental',
  exponential: 'activity:kanbanText.retryPolicy.exponential',
};

export const ATOMICITY_VERDICT_KEYS: Record<string, string> = {
  atomic: 'activity:kanbanText.verdict.atomic',
  borderline: 'activity:kanbanText.verdict.borderline',
  needs_decomposition: 'activity:kanbanText.verdict.needsDecomposition',
  composite: 'activity:kanbanText.verdict.composite',
};

export const TASK_STATUS_KEYS: Record<string, string> = {
  pending: 'activity:kanbanText.taskStatus.pending',
  ready: 'activity:kanbanText.taskStatus.ready',
  in_progress: 'activity:kanbanText.taskStatus.in_progress',
  blocked: 'activity:kanbanText.taskStatus.blocked',
  review: 'activity:kanbanText.taskStatus.review',
  completed: 'activity:kanbanText.taskStatus.completed',
  failed: 'activity:kanbanText.taskStatus.failed',
  archived: 'activity:kanbanText.taskStatus.archived',
};

export const TASK_PRIORITY_KEYS: Record<string, string> = {
  critical: 'activity:kanbanText.taskPriority.critical',
  high: 'activity:kanbanText.taskPriority.high',
  medium: 'activity:kanbanText.taskPriority.medium',
  low: 'activity:kanbanText.taskPriority.low',
};

/** Card badge text for a `TaskVerificationState` (`unverified` shows no badge). */
export const VERIFICATION_STATE_KEYS: Record<string, string> = {
  running: 'activity:kanban.statusRunning',
  passed: 'activity:kanbanText.verification.passed',
  failed: 'activity:kanbanText.verification.failed',
  needs_human: 'activity:kanbanText.verification.needsHuman',
  incomplete: 'activity:kanbanText.verification.incomplete',
};

/** Translate an enum value through a key map, falling back to the raw value. */
export function enumLabel(t: TFunction, keys: Record<string, string>, value: string): string {
  const key = keys[value];
  return key ? t(key) : value;
}

/**
 * `deriveTaskCardIntelligence` keeps its route sentinels in English (they are
 * cached per board and asserted by tests); this maps them for display.
 */
export function routeLabel(t: TFunction, route: string): string {
  if (route === 'session default') return t('activity:kanbanText.routeSessionDefault');
  if (route === 'default route') return t('activity:kanbanText.routeDefault');
  return route;
}
