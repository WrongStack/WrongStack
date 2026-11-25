import type { Message } from '@wrongstack/contracts/types/messages';
import { describe, expect, it } from 'vitest';
import {
  armRequiredSkills,
  markRequiredSkillLoaded,
  pendingRequiredSkills,
} from '../src/skills/required-skill-gate.js';

describe('pendingRequiredSkills prototype key guard (F2007)', () => {
  it('handles valid skill name constructor without reading Object.prototype.constructor', () => {
    const ctx = {
      meta: {} as Record<string, unknown>,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'u1', name: 'skill', input: { name: 'constructor' } }],
        },
      ] as unknown as Message[],
    };
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills constructor -->');
    markRequiredSkillLoaded(ctx, 'constructor');
    expect(pendingRequiredSkills(ctx)).toEqual([]);
  });
});
