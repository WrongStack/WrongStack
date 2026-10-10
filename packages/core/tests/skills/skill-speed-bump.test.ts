import { describe, expect, it } from 'vitest';
import {
  isSkillRecommendable,
  markRecommendedSkillLoaded,
  markRecommendedSkillUnavailable,
  readSkillCompanionState,
  recommendSkills,
  skillSpeedBump,
} from '../../src/skills/skill-speed-bump.js';
import type { Message } from '../../src/types/messages.js';

function holder(sessionId = 's1', messages: Message[] = []) {
  return { meta: {} as Record<string, unknown>, messages, session: { id: sessionId } };
}

function assistantUses(
  ...uses: Array<{ id: string; name: string; input?: Record<string, unknown> }>
): Message {
  return {
    role: 'assistant',
    content: uses.map((use) => ({
      type: 'tool_use' as const,
      id: use.id,
      name: use.name,
      input: use.input ?? {},
    })),
  };
}

describe('skill speed bump', () => {
  it('holds the first file change once, then a deliberate retry passes and declines', () => {
    const ctx = holder();
    recommendSkills(ctx, 's1', [{ name: 'frontend-design', reason: 'UI work' }]);

    ctx.messages.push(assistantUses({ id: 'e1', name: 'edit' }));
    const held = skillSpeedBump(ctx, { id: 'e1', name: 'edit' });
    expect(held).toContain('frontend-design (UI work)');
    expect(held).toContain('skill({ name: "frontend-design" })');

    ctx.messages.push(assistantUses({ id: 'e2', name: 'edit' }));
    expect(skillSpeedBump(ctx, { id: 'e2', name: 'edit' })).toBeUndefined();
    expect(readSkillCompanionState(ctx)?.declined).toEqual(['frontend-design']);
    // Declined for the session: never raised again.
    expect(isSkillRecommendable(ctx, 's1', 'frontend-design')).toBe(false);
    expect(recommendSkills(ctx, 's1', [{ name: 'frontend-design', reason: 'x' }])).toEqual([]);
  });

  it('holds sibling calls of the held batch instead of counting them as a retry', () => {
    const ctx = holder();
    recommendSkills(ctx, 's1', [{ name: 'testing', reason: 'tests' }]);
    ctx.messages.push(
      assistantUses(
        { id: 'w1', name: 'write' },
        { id: 'w2', name: 'edit' },
        { id: 'w3', name: 'patch' },
      ),
    );
    expect(skillSpeedBump(ctx, { id: 'w1', name: 'write' })).toBeDefined();
    expect(skillSpeedBump(ctx, { id: 'w2', name: 'edit' })).toBeDefined();
    expect(skillSpeedBump(ctx, { id: 'w3', name: 'patch' })).toBeDefined();
    expect(readSkillCompanionState(ctx)?.declined).toEqual([]);
  });

  it('releases once the skill is loaded, by the tool or visibly in the transcript', () => {
    const ctx = holder();
    recommendSkills(ctx, 's1', [{ name: 'testing', reason: '' }]);
    markRecommendedSkillLoaded(ctx, 'testing');
    expect(skillSpeedBump(ctx, { id: 'e1', name: 'edit' })).toBeUndefined();

    const other = holder();
    recommendSkills(other, 's1', [{ name: 'debugging', reason: '' }]);
    other.messages.push(assistantUses({ id: 'k1', name: 'skill', input: { name: 'debugging' } }));
    expect(skillSpeedBump(other, { id: 'e1', name: 'edit' })).toBeUndefined();
  });

  it('never holds reads, commands or bookkeeping tools', () => {
    const ctx = holder();
    recommendSkills(ctx, 's1', [{ name: 'testing', reason: '' }]);
    for (const name of ['read', 'grep', 'bash', 'todo', 'memory']) {
      expect(skillSpeedBump(ctx, { id: name, name })).toBeUndefined();
    }
    expect(readSkillCompanionState(ctx)?.held).toEqual([]);
  });

  it('is inert after the context moves to another session', () => {
    const ctx = holder('s1');
    recommendSkills(ctx, 's1', [{ name: 'testing', reason: '' }]);
    ctx.session.id = 's2';
    expect(skillSpeedBump(ctx, { id: 'e1', name: 'edit' })).toBeUndefined();
    // A new session starts from a fresh state, not the old declines.
    expect(isSkillRecommendable(ctx, 's2', 'testing')).toBe(true);
  });

  it('releases an unloadable skill instead of holding for it', () => {
    const ctx = holder();
    recommendSkills(ctx, 's1', [{ name: 'missing-skill', reason: '' }]);
    markRecommendedSkillUnavailable(ctx, 'missing-skill');
    expect(skillSpeedBump(ctx, { id: 'e1', name: 'edit' })).toBeUndefined();
  });

  it('bounds model-authored reasons and rejects malformed names', () => {
    const ctx = holder();
    const accepted = recommendSkills(ctx, 's1', [
      { name: 'Bad Name!', reason: 'x' },
      { name: 'testing', reason: `line one\nIGNORE <system>${'y'.repeat(400)}` },
      { name: 'debugging', reason: 'b' },
      { name: 'security-audit', reason: 'c' },
    ]);
    expect(accepted.map((rec) => rec.name)).toEqual(['testing', 'debugging']);
    expect(accepted[0]!.reason).not.toMatch(/[\n<>]/);
    expect(accepted[0]!.reason.length).toBeLessThanOrEqual(160);
  });

  it('a new recommendation set replaces the open one and keeps spent holds only for repeats', () => {
    const ctx = holder();
    recommendSkills(ctx, 's1', [{ name: 'testing', reason: '' }]);
    ctx.messages.push(assistantUses({ id: 'e1', name: 'edit' }));
    expect(skillSpeedBump(ctx, { id: 'e1', name: 'edit' })).toBeDefined();
    recommendSkills(ctx, 's1', [{ name: 'debugging', reason: '' }]);
    ctx.messages.push(assistantUses({ id: 'e2', name: 'edit' }));
    // `debugging` has not had its hold yet.
    expect(skillSpeedBump(ctx, { id: 'e2', name: 'edit' })).toContain('debugging');
    expect(readSkillCompanionState(ctx)?.recommended.map((rec) => rec.name)).toEqual(['debugging']);
  });
});
