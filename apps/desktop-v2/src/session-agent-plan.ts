import { record } from './engine-values';
import { sameSetting } from './settings-save-model';

export interface AgentModelPlan extends Record<string, unknown> {
  enabled: boolean;
  lock: boolean;
  followSessionModel: boolean;
  slots: Record<string, unknown>[];
  roles?: Record<string, Record<string, unknown>>;
}
/** Project the known wire shape without discarding runtime overrides on retained routes. */
export function agentModelPlan(value: unknown): AgentModelPlan {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw Error('The session returned an unreadable agent plan. It has been preserved.');
  const raw = record(value);
  if (
    raw['roles'] !== undefined &&
    (!raw['roles'] ||
      typeof raw['roles'] !== 'object' ||
      Array.isArray(raw['roles']) ||
      Object.values(raw['roles']).some(
        (route) => !route || typeof route !== 'object' || Array.isArray(route),
      ))
  )
    throw Error('The session returned invalid role overrides. They have been preserved.');
  const slots = raw['slots'] ?? [];
  if (
    !Array.isArray(slots) ||
    slots.length > 16 ||
    slots.some((slot) => !slot || typeof slot !== 'object' || Array.isArray(slot))
  )
    throw Error('The session returned invalid model lanes. Reload before editing.');
  return {
    ...raw,
    enabled: raw['enabled'] !== false,
    lock: raw['lock'] !== false,
    followSessionModel: raw['followSessionModel'] === true,
    slots: slots.length
      ? slots.map((slot) => ({ ...slot }))
      : Array.from({ length: 8 }, () => ({})),
    ...(raw['roles']
      ? {
          roles: Object.fromEntries(
            Object.entries(record(raw['roles'])).map(([key, value]) => [key, { ...record(value) }]),
          ),
        }
      : {}),
  };
}
export function resizeAgentLanes(plan: AgentModelPlan, count: number): AgentModelPlan {
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw Error('Choose between 1 and 16 lanes.');
  return { ...plan, slots: Array.from({ length: count }, (_, index) => plan.slots[index] ?? {}) };
}
export function agentRouteTarget(
  route: Record<string, unknown>,
  kind: string,
  value = '',
  model = '',
): Record<string, unknown> {
  const next = { ...route };
  for (const key of ['provider', 'model', 'tier', 'fallbackProfile']) delete next[key];
  if (kind === 'model') {
    next['provider'] = value;
    next['model'] = model;
  } else if (kind === 'tier' && value.trim()) next['tier'] = value.trim();
  else if (kind === 'profile' && value.trim()) next['fallbackProfile'] = value.trim();
  return next;
}
/**
 * The save request for a reviewed plan. With `atomic` (engines advertising
 * `session.subagent-plan-expected`), the plan just read travels as `expectedSubagentModelPlan`
 * and the engine refuses the write if another window changed it in between.
 */
export function agentPlanPatch(
  base: unknown,
  draft: AgentModelPlan,
  current: unknown,
  atomic = false,
): Record<string, unknown> {
  if (!sameSetting(base, current) && !sameSetting(draft, current))
    throw Error(
      'This session model plan changed elsewhere. Your edits are kept; reload the saved plan before retrying.',
    );
  return {
    subagentModelPlan: draft,
    ...(atomic ? { expectedSubagentModelPlan: current ?? null } : {}),
  };
}
