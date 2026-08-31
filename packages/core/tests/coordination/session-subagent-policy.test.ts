import { describe, expect, it, vi } from 'vitest';
import {
  areSubagentsAllowed,
  areSubagentsAllowedForSession,
  isSubagentPolicyLocked,
  lockSessionSubagentPolicyForSession,
  resetSessionSubagentPolicy,
  restoreSessionSubagentPolicy,
  setSessionSubagentsAllowed,
} from '../../src/coordination/session-subagent-policy.js';

function policyContext(id: string) {
  return {
    messages: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
    meta: {} as Record<string, unknown>,
    session: { id, append: vi.fn(async () => undefined) },
  };
}

describe('session subagent policy', () => {
  it('persists a pre-session choice and updates the runtime registry', async () => {
    const ctx = policyContext('policy-pre-session');

    await setSessionSubagentsAllowed(ctx as never, false);

    expect(areSubagentsAllowed(ctx as never)).toBe(false);
    expect(areSubagentsAllowedForSession('policy-pre-session')).toBe(false);
    expect(ctx.session.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent_policy', allowed: false }),
    );
  });

  it('rejects a policy change after the first user message', async () => {
    const ctx = policyContext('policy-locked');
    ctx.messages.push({ role: 'user', content: 'start' });

    expect(isSubagentPolicyLocked(ctx as never)).toBe(true);
    await expect(setSessionSubagentsAllowed(ctx as never, false)).rejects.toThrow(
      'locked after the session starts',
    );
    expect(ctx.session.append).not.toHaveBeenCalled();
  });

  it('locks the policy when a subagent is spawned before the first message', async () => {
    const ctx = policyContext('policy-spawned');
    lockSessionSubagentPolicyForSession('policy-spawned');

    expect(isSubagentPolicyLocked(ctx as never)).toBe(true);
    await expect(setSessionSubagentsAllowed(ctx as never, false)).rejects.toThrow(
      'locked after the session starts',
    );
  });

  it('restores the last journaled choice for a resumed session', () => {
    const ctx = policyContext('policy-resumed');
    ctx.messages.push({ role: 'user', content: 'existing conversation' });

    restoreSessionSubagentPolicy(ctx as never, [
      { type: 'subagent_policy', ts: '2026-01-01T00:00:00.000Z', allowed: false },
    ]);

    expect(areSubagentsAllowed(ctx as never)).toBe(false);
    expect(ctx.meta['subagentsPolicyLocked']).toBe(true);
    expect(areSubagentsAllowedForSession('policy-resumed')).toBe(false);
  });

  it('starts a newly assigned session unlocked with subagents allowed', () => {
    const ctx = policyContext('policy-new-session');
    ctx.meta['subagentsAllowed'] = false;
    ctx.meta['subagentsPolicyLocked'] = true;
    lockSessionSubagentPolicyForSession('policy-new-session');

    resetSessionSubagentPolicy(ctx as never);

    expect(areSubagentsAllowed(ctx as never)).toBe(true);
    expect(isSubagentPolicyLocked(ctx as never)).toBe(false);
  });
});
