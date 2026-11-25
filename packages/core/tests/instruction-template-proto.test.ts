import { describe, expect, it } from 'vitest';
import { renderInstructionLayer } from '../src/core/instruction-template.js';

describe('renderInstructionLayer prototype-safe variable substitution', () => {
  it('leaves prototype-named placeholders intact instead of interpolating Object.prototype members', () => {
    const ctx = {
      toolNames: new Set<string>(),
      tier: 'off' as const,
      subagent: false,
      vars: { name: 'Ada' },
    };
    expect(renderInstructionLayer('Keep {{toString}} and {{constructor}} and {{name}}', ctx)).toBe(
      'Keep {{toString}} and {{constructor}} and Ada',
    );
  });
});
