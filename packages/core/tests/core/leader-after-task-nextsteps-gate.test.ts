/**
 * The leader-after-task layer describes the `nextsteps` tool only when that
 * tool is actually registered.
 *
 * Both directions matter. Without the gate, every request would advertise a
 * tool most sessions do not have — the phantom-tool failure mode the
 * `<!--ws:if tool=…-->` convention exists to prevent. With the gate but no
 * text, turning the opt-in on would register a tool the prompt never mentions.
 */
import { describe, expect, it } from 'vitest';
import { renderInstructionLayer } from '../../src/core/instruction-template.js';
import { LEADER_AFTER_TASK_PROMPT } from '../../src/core/modes/default.js';

function render(toolNames: string[]): string {
  return renderInstructionLayer(LEADER_AFTER_TASK_PROMPT, {
    toolNames: new Set(toolNames),
    tier: 'off',
    subagent: false,
  });
}

describe('leader-after-task `nextsteps` tool gate', () => {
  it('says nothing about the tool when it is not registered', () => {
    const out = render(['todo', 'read']);

    expect(out).not.toContain('`nextsteps` tool');
    // The block contract itself is unconditional — it is the only route then.
    expect(out).toContain('<nextsteps>');
  });

  it('offers the tool as an equal route when it is registered', () => {
    const out = render(['todo', 'read', 'nextsteps']);

    expect(out).toContain('`nextsteps` tool');
    // Precedence must be stated, or a model that does both has no rule to follow.
    expect(out).toContain('wins');
  });

  it('leaves no directive markers in either rendering', () => {
    for (const out of [render([]), render(['nextsteps'])]) {
      expect(out).not.toContain('ws:if');
      expect(out).not.toContain('ws:end');
    }
  });
});
