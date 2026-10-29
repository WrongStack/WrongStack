import { expect, it } from 'vitest';
import {
  agentModelPlan,
  agentPlanPatch,
  agentRouteTarget,
  resizeAgentLanes,
} from '../src/session-agent-plan';

it('retains role/runtime/label metadata while explicitly replacing a lane routing target', () => {
  const source = {
    enabled: true,
    lock: true,
    slots: [
      {
        tier: 'fast',
        fallbackProfile: 'old',
        label: 'Research',
        modelRuntime: { reasoning: { effort: 'high' } },
      },
    ],
    roles: {
      reviewer: {
        provider: 'local',
        model: 'review',
        modelRuntime: { reasoning: { preserve: true } },
      },
    },
  };
  const plan = agentModelPlan(source);
  plan.slots[0] = agentRouteTarget(plan.slots[0]!, 'model', 'local', 'build');
  expect(plan.slots[0]).toEqual({
    provider: 'local',
    model: 'build',
    label: 'Research',
    modelRuntime: { reasoning: { effort: 'high' } },
  });
  expect(plan.roles).toEqual(source.roles);
  const expanded = resizeAgentLanes(plan, 3);
  expect(expanded.slots).toHaveLength(3);
  expect(expanded.slots[0]).toEqual(plan.slots[0]);
  expect(() => resizeAgentLanes(plan, 17)).toThrow();
  expect(() => agentModelPlan({ slots: 'bad' })).toThrow('invalid model lanes');
});
it('refuses a competing whole-plan change and emits only the session-owned preference', () => {
  const base = agentModelPlan(undefined);
  const draft = { ...base, followSessionModel: true };
  expect(agentPlanPatch(base, draft, base)).toEqual({ subagentModelPlan: draft });
  expect(() => agentPlanPatch(base, draft, { ...base, lock: false })).toThrow('changed elsewhere');
  expect(agentPlanPatch(base, draft, draft)).toEqual({ subagentModelPlan: draft });
  expect(agentPlanPatch(base, draft, base, true)).toEqual({
    subagentModelPlan: draft,
    expectedSubagentModelPlan: base,
  });
  expect(agentPlanPatch(undefined, draft, undefined, true)).toMatchObject({
    expectedSubagentModelPlan: null,
  });
});
