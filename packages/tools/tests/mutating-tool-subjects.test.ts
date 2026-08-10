/**
 * WS-046b — every mutating tool needs a permission subject.
 *
 * `subjectForToolInput` falls back to `path` / `url` / `name`, plus a special
 * case for `bash`. Any mutating tool whose input has none of those resolved to
 * `undefined`, which collapsed all of its calls onto the bare tool name. Three
 * consequences followed, and only the first is obvious:
 *
 *   - "always allow" stored a rule keyed on the tool name that the
 *     `subject && matchesTrust(...)` guard could never match (WS-046a);
 *   - the eval/session cache key `${tool}::${subject ?? tool.name}` collapsed to
 *     `exec::exec`, so pressing "no" once blocked EVERY exec for the session;
 *   - one cached permission decision covered every distinct command.
 *
 * This file is a ratchet, not a snapshot: it walks the real tool registry, so a
 * newly added mutating tool without a subject fails here rather than shipping
 * with the same trap.
 */

import type { Tool } from '@wrongstack/core/types';
import { subjectForToolInput } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import * as tools from '../src/index.js';

/**
 * Tools that legitimately have no subject, with the reason. Both take no
 * identifying string input at all, so there is nothing honest to key on —
 * inventing one would be worse than the explicit refusal WS-046a now gives.
 */
const NO_SUBJECT_BY_DESIGN: Record<string, string> = {
  // Its `calls` are each permission-checked on their own; the batch wrapper
  // authorizes nothing by itself.
  batch_tool_use: 'delegates to inner calls, each checked separately',
  // Inputs are `force: boolean` and `langs: string[]` — no subject exists.
  'codebase-index': 'no identifying string input',
};

function mutatingTools(): Tool[] {
  const seen = new Set<string>();
  const out: Tool[] = [];
  for (const value of Object.values(tools)) {
    const t = value as Partial<Tool> | undefined;
    if (!t || typeof t !== 'object') continue;
    if (!t.name || !t.inputSchema || !t.mutating) continue;
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t as Tool);
  }
  return out;
}

/** Fill every declared string property, mimicking a realistic call. */
function sampleInput(tool: Tool): Record<string, unknown> {
  const props = (tool.inputSchema as { properties?: Record<string, { type?: string }> }).properties;
  const input: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props ?? {})) {
    if (schema?.type === 'string') input[key] = 'X';
    else if (schema?.type === 'array') input[key] = [{ id: 'X' }];
  }
  return input;
}

describe('every mutating tool resolves a permission subject (WS-046b)', () => {
  it('finds the registry — guards against the walk silently matching nothing', () => {
    const found = mutatingTools().map((t) => t.name);
    expect(found.length).toBeGreaterThan(20);
    expect(found).toContain('exec');
    expect(found).toContain('git');
  });

  it.each(mutatingTools().map((t) => [t.name, t] as const))('%s', (name, tool) => {
    const subject = subjectForToolInput(name, sampleInput(tool), tool.subjectKey);
    if (name in NO_SUBJECT_BY_DESIGN) {
      // Pinned in both directions: if one of these ever grows a subject, this
      // fails and the exemption gets removed rather than silently outliving
      // its reason.
      expect(subject, NO_SUBJECT_BY_DESIGN[name]).toBeUndefined();
      return;
    }
    expect(subject).toBeDefined();
    expect(subject).not.toBe('');
  });
});

describe('exec renders the full invocation (WS-046b)', () => {
  const subject = (input: Record<string, unknown>) => subjectForToolInput('exec', input, 'command');

  it('includes the arguments, not just the program', () => {
    // The reason `command` alone is not enough: these must not be one subject.
    const status = subject({ command: 'git', args: ['status'] });
    const force = subject({ command: 'git', args: ['push', '--force'] });
    expect(status).toBe('git status');
    expect(force).toBe('git push --force');
    expect(status).not.toBe(force);
  });

  it('quotes arguments containing whitespace so distinct lists stay distinct', () => {
    // Without quoting, ['a b','c'] and ['a','b c'] both render "a b c" and
    // would share a trust rule.
    expect(subject({ command: 'x', args: ['a b', 'c'] })).toBe('x "a b" c');
    expect(subject({ command: 'x', args: ['a', 'b c'] })).toBe('x a "b c"');
    expect(subject({ command: 'x', args: ['a b', 'c'] })).not.toBe(
      subject({ command: 'x', args: ['a', 'b c'] }),
    );
  });

  it('handles a bare command with no args', () => {
    expect(subject({ command: 'ls' })).toBe('ls');
    expect(subject({ command: 'ls', args: [] })).toBe('ls');
  });

  it('leaves bash unchanged — its command already IS the whole line', () => {
    expect(subjectForToolInput('bash', { command: 'ls -la | wc -l' }, 'command')).toBe(
      'ls -la | wc -l',
    );
  });

  it('glob-escapes the rendered line so it round-trips as a trust pattern', () => {
    // The subject doubles as the stored pattern; unescaped metacharacters
    // would make a stored rule match more than the command it came from.
    expect(subject({ command: 'grep', args: ['[0-9]*'] })).toBe('grep \\[0-9\\]\\*');
  });
});
