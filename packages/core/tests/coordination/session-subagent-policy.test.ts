import { describe, expect, it, vi } from 'vitest';
import {
  areSubagentCompanionsAllowed,
  areSubagentCompanionsAllowedForSession,
  areSubagentsAllowed,
  areSubagentsAllowedForSession,
  isSubagentPolicyLocked,
  lockSessionSubagentPolicyForSession,
  resetSessionSubagentPolicy,
  restoreSessionSubagentPolicy,
  setSessionSubagentPolicy,
  setSessionSubagentsAllowed,
  subagentPolicyMode,
  unlockSessionSubagentPolicyForSession,
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

  it('companions mode blocks general subagents but admits the resident companions', async () => {
    const ctx = policyContext('policy-companions');

    await setSessionSubagentPolicy(ctx as never, 'companions');

    expect(subagentPolicyMode(ctx as never)).toBe('companions');
    expect(areSubagentsAllowed(ctx as never)).toBe(false);
    expect(areSubagentCompanionsAllowed(ctx as never)).toBe(true);
    expect(areSubagentsAllowedForSession('policy-companions')).toBe(false);
    expect(areSubagentCompanionsAllowedForSession('policy-companions')).toBe(true);
    expect(ctx.session.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent_policy', allowed: false, companions: true }),
    );
  });

  it('strict solo blocks the companions too', async () => {
    const ctx = policyContext('policy-strict');

    await setSessionSubagentsAllowed(ctx as never, false);

    expect(subagentPolicyMode(ctx as never)).toBe('none');
    expect(areSubagentCompanionsAllowed(ctx as never)).toBe(false);
    expect(areSubagentCompanionsAllowedForSession('policy-strict')).toBe(false);
    const event = (
      ctx.session.append.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]![0];
    expect(event).not.toHaveProperty('companions');
  });

  it('restores companions mode from the journal and from the persisted fallback', () => {
    const journaled = policyContext('policy-restore-companions');
    restoreSessionSubagentPolicy(journaled as never, [
      { type: 'subagent_policy', ts: '2026-01-01T00:00:00.000Z', allowed: false, companions: true },
    ]);
    expect(subagentPolicyMode(journaled as never)).toBe('companions');
    expect(areSubagentCompanionsAllowedForSession('policy-restore-companions')).toBe(true);

    // Events evicted: the load-time summary carries both halves.
    const evicted = policyContext('policy-restore-evicted');
    restoreSessionSubagentPolicy(evicted as never, [], false, true);
    expect(subagentPolicyMode(evicted as never)).toBe('companions');

    // A pre-companions journal (allowed:false, no field) stays strict.
    const legacy = policyContext('policy-restore-legacy');
    restoreSessionSubagentPolicy(legacy as never, [
      { type: 'subagent_policy', ts: '2026-01-01T00:00:00.000Z', allowed: false },
    ]);
    expect(subagentPolicyMode(legacy as never)).toBe('none');
    expect(areSubagentCompanionsAllowedForSession('policy-restore-legacy')).toBe(false);
  });

  it('unlockSessionSubagentPolicyForSession unlocks session and resets mode to all', () => {
    lockSessionSubagentPolicyForSession('policy-unlock-test');
    unlockSessionSubagentPolicyForSession('policy-unlock-test');
    expect(areSubagentsAllowedForSession('policy-unlock-test')).toBe(true);
  });

  it('allows forced policy change even when locked', async () => {
    const ctx = policyContext('policy-force-test');
    ctx.messages.push({ role: 'user', content: 'hello' });
    lockSessionSubagentPolicyForSession('policy-force-test');

    expect(isSubagentPolicyLocked(ctx as never)).toBe(true);
    await setSessionSubagentPolicy(ctx as never, 'companions', { force: true });

    expect(subagentPolicyMode(ctx as never)).toBe('companions');
    expect(areSubagentsAllowed(ctx as never)).toBe(false);
    expect(areSubagentCompanionsAllowed(ctx as never)).toBe(true);
  });

  it('unknown sessions default to allowing both', () => {
    expect(areSubagentsAllowedForSession('policy-never-seen')).toBe(true);
    expect(areSubagentCompanionsAllowedForSession('policy-never-seen')).toBe(true);
    expect(areSubagentCompanionsAllowedForSession(undefined)).toBe(true);
  });
});
