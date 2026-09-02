/**
 * Additional coverage for hooks/shell-executor.ts — parseHookOutcome
 * branch coverage for all action/decision/mutate/deny paths.
 */
import { describe, expect, it } from 'vitest';
import { parseHookOutcome } from '../../src/hooks/shell-executor.js';

describe('parseHookOutcome', () => {
  it('returns null for non-JSON input', () => {
    expect(parseHookOutcome('plain text')).toBeNull();
    expect(parseHookOutcome('')).toBeNull();
    expect(parseHookOutcome('  ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseHookOutcome('{invalid}')).toBeNull();
    expect(parseHookOutcome('{"unclosed": ')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseHookOutcome('[1,2,3]')).toBeNull();
    expect(parseHookOutcome('"string"')).toBeNull();
  });

  // ── action: allow ──────────────────────────────────────────────────────

  it('parses action: allow', () => {
    const result = parseHookOutcome('{"action": "allow"}');
    expect(result).toEqual({ action: 'allow' });
  });

  it('parses action: allow with additionalContext', () => {
    const result = parseHookOutcome('{"action": "allow", "additionalContext": "extra info"}');
    expect(result).toEqual({ action: 'allow', additionalContext: 'extra info' });
  });

  it('parses action: allow with contextAs', () => {
    const result = parseHookOutcome('{"action": "allow", "contextAs": "inline"}');
    expect(result).toEqual({ action: 'allow', contextAs: 'inline' });
  });

  it('parses action: allow with contextAs separate', () => {
    const result = parseHookOutcome('{"action": "allow", "contextAs": "separate"}');
    expect(result).toEqual({ action: 'allow', contextAs: 'separate' });
  });

  it('ignores invalid contextAs', () => {
    const result = parseHookOutcome('{"action": "allow", "contextAs": "bogus"}');
    expect(result).toEqual({ action: 'allow' });
  });

  // ── action: deny ───────────────────────────────────────────────────────

  it('parses action: deny with reason', () => {
    const result = parseHookOutcome('{"action": "deny", "reason": "not allowed"}');
    expect(result).toEqual({ action: 'deny', reason: 'not allowed' });
  });

  it('returns null for deny without reason', () => {
    expect(parseHookOutcome('{"action": "deny"}')).toBeNull();
  });

  it('returns null for deny with empty reason', () => {
    expect(parseHookOutcome('{"action": "deny", "reason": "  "}')).toBeNull();
  });

  it('returns null for deny with non-string reason', () => {
    expect(parseHookOutcome('{"action": "deny", "reason": 42}')).toBeNull();
  });

  it('parses deny with additionalContext', () => {
    const result = parseHookOutcome(
      '{"action": "deny", "reason": "no", "additionalContext": "ctx"}',
    );
    expect(result).toEqual({ action: 'deny', reason: 'no', additionalContext: 'ctx' });
  });

  // ── action: mutate ─────────────────────────────────────────────────────

  it('parses action: mutate with input object', () => {
    const result = parseHookOutcome('{"action": "mutate", "input": {"key": "value"}}');
    expect(result).toEqual({ action: 'mutate', input: { key: 'value' } });
  });

  it('parses mutate with reason', () => {
    const result = parseHookOutcome('{"action": "mutate", "input": {"a": 1}, "reason": "changed"}');
    expect(result).toEqual({ action: 'mutate', input: { a: 1 }, reason: 'changed' });
  });

  it('returns null for mutate without input', () => {
    expect(parseHookOutcome('{"action": "mutate"}')).toBeNull();
  });

  it('returns null for mutate with non-object input', () => {
    expect(parseHookOutcome('{"action": "mutate", "input": "string"}')).toBeNull();
  });

  it('returns null for mutate with array input', () => {
    expect(parseHookOutcome('{"action": "mutate", "input": [1,2]}')).toBeNull();
  });

  it('parses mutate with additionalContext and contextAs', () => {
    const result = parseHookOutcome(
      '{"action": "mutate", "input": {"x": 1}, "additionalContext": "ctx", "contextAs": "separate"}',
    );
    expect(result).toEqual({
      action: 'mutate',
      input: { x: 1 },
      additionalContext: 'ctx',
      contextAs: 'separate',
    });
  });

  // ── decision: block/allow (legacy format) ──────────────────────────────

  it('parses decision: block', () => {
    const result = parseHookOutcome('{"decision": "block"}');
    expect(result).toEqual({ decision: 'block' });
  });

  it('parses decision: allow', () => {
    const result = parseHookOutcome('{"decision": "allow"}');
    expect(result).toEqual({ decision: 'allow' });
  });

  it('parses decision with reason', () => {
    const result = parseHookOutcome('{"decision": "block", "reason": "policy"}');
    expect(result).toEqual({ decision: 'block', reason: 'policy' });
  });

  it('parses decision with modifiedInput', () => {
    const result = parseHookOutcome('{"decision": "allow", "modifiedInput": {"cmd": "safe"}}');
    expect(result).toEqual({ decision: 'allow', modifiedInput: { cmd: 'safe' } });
  });

  it('parses decision with additionalContext', () => {
    const result = parseHookOutcome('{"decision": "block", "additionalContext": "warning"}');
    expect(result).toEqual({ decision: 'block', additionalContext: 'warning' });
  });

  it('parses decision with contextAs', () => {
    const result = parseHookOutcome('{"decision": "allow", "contextAs": "inline"}');
    expect(result).toEqual({ decision: 'allow', contextAs: 'inline' });
  });

  // ── empty object ───────────────────────────────────────────────────────

  it('returns empty outcome for empty object', () => {
    const result = parseHookOutcome('{}');
    expect(result).toEqual({});
  });

  // ── whitespace handling ────────────────────────────────────────────────

  it('handles leading/trailing whitespace', () => {
    const result = parseHookOutcome('  {"action": "allow"}  ');
    expect(result).toEqual({ action: 'allow' });
  });
});
