/**
 * Tests for GoalAssessor — goal duration realism assessment.
 * Covers: parse() with valid/invalid/missing JSON, extractJSONObject via
 * fenced blocks and balanced-brace extraction, and assess() integration.
 */
import { describe, expect, it, vi } from 'vitest';
import { GoalAssessor } from '../../src/goal/goal-assessor.js';

// Mock the instruction-file module so buildPrompt() doesn't hit disk.
vi.mock('../../src/utils/instruction-file.js', () => ({
  readBundledInstructionText: vi.fn(() => 'Assess this goal: {{goal}}'),
  renderInstructionTemplate: vi.fn((template: string, vars: Record<string, string>) =>
    template.replace('{{goal}}', vars.goal ?? ''),
  ),
}));

function makeAssessor(response: string, goal = 'test goal') {
  return new GoalAssessor({
    goal,
    runOnce: vi.fn(async () => response),
  });
}

describe('GoalAssessor.parse', () => {
  it('parses a clean JSON response with all fields', () => {
    const a = makeAssessor('');
    const result = a.parse(
      JSON.stringify({
        realistic: false,
        durationClaimed: '2 days',
        explanation: 'Too ambitious',
        recommendedDuration: '2 weeks',
        concerns: ['scope creep', 'no tests'],
      }),
    );
    expect(result.parseFailed).toBe(false);
    expect(result.realistic).toBe(false);
    expect(result.durationClaimed).toBe('2 days');
    expect(result.explanation).toBe('Too ambitious');
    expect(result.recommendedDuration).toBe('2 weeks');
    expect(result.concerns).toEqual(['scope creep', 'no tests']);
  });

  it('returns parseFailed when no JSON object is found', () => {
    const a = makeAssessor('');
    const result = a.parse('This is just plain text with no JSON.');
    expect(result.parseFailed).toBe(true);
    expect(result.parseError).toBe('No JSON object found in model output');
    expect(result.realistic).toBe(true);
    expect(result.raw).toBe('This is just plain text with no JSON.');
  });

  it('returns parseFailed for invalid JSON syntax', () => {
    const a = makeAssessor('');
    const result = a.parse('{invalid json!!!}');
    expect(result.parseFailed).toBe(true);
    expect(result.parseError).toBe('Failed to parse JSON from model output');
  });

  it('defaults missing fields to safe values', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true}');
    expect(result.parseFailed).toBe(false);
    expect(result.realistic).toBe(true);
    expect(result.durationClaimed).toBeNull();
    expect(result.explanation).toBe('');
    expect(result.recommendedDuration).toBeNull();
    expect(result.concerns).toEqual([]);
  });

  it('treats non-boolean realistic as false', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": "yes"}');
    expect(result.realistic).toBe(false);
  });

  it('filters non-string items from concerns', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true, "concerns": ["valid", 42, null, "also valid"]}');
    expect(result.concerns).toEqual(['valid', 'also valid']);
  });

  it('treats non-array concerns as empty', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true, "concerns": "not an array"}');
    expect(result.concerns).toEqual([]);
  });

  it('treats non-string durationClaimed as null', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true, "durationClaimed": 42}');
    expect(result.durationClaimed).toBeNull();
  });

  it('treats non-string recommendedDuration as null', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true, "recommendedDuration": 99}');
    expect(result.recommendedDuration).toBeNull();
  });
});

describe('JSON extraction via parse()', () => {
  it('extracts JSON from a fenced code block', () => {
    const a = makeAssessor('');
    const result = a.parse(
      'Here is my assessment:\n```json\n{"realistic": false, "explanation": "nope"}\n```\nDone.',
    );
    expect(result.parseFailed).toBe(false);
    expect(result.realistic).toBe(false);
    expect(result.explanation).toBe('nope');
  });

  it('extracts JSON from a fenced block without language tag', () => {
    const a = makeAssessor('');
    const result = a.parse('```\n{"realistic": true}\n```');
    expect(result.parseFailed).toBe(false);
    expect(result.realistic).toBe(true);
  });

  it('extracts JSON embedded in surrounding text', () => {
    const a = makeAssessor('');
    const result = a.parse('The result is {"realistic": true, "explanation": "fine"} as expected.');
    expect(result.parseFailed).toBe(false);
    expect(result.realistic).toBe(true);
  });

  it('handles nested braces in JSON', () => {
    const a = makeAssessor('');
    const result = a.parse(
      '{"realistic": true, "concerns": ["a"], "nested": {"deep": {"deeper": 1}}}',
    );
    expect(result.parseFailed).toBe(false);
    expect(result.realistic).toBe(true);
  });

  it('handles strings containing braces', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true, "explanation": "use { and } carefully"}');
    expect(result.parseFailed).toBe(false);
    expect(result.explanation).toBe('use { and } carefully');
  });

  it('handles escaped quotes inside strings', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true, "explanation": "say \\"hello\\""}');
    expect(result.parseFailed).toBe(false);
    expect(result.explanation).toBe('say "hello"');
  });

  it('returns parseFailed for unbalanced braces', () => {
    const a = makeAssessor('');
    const result = a.parse('{"realistic": true');
    expect(result.parseFailed).toBe(true);
  });

  it('returns parseFailed for empty input', () => {
    const a = makeAssessor('');
    const result = a.parse('');
    expect(result.parseFailed).toBe(true);
  });
});

describe('GoalAssessor.assess', () => {
  it('calls runOnce with the built prompt and parses the response', async () => {
    const runOnce = vi.fn(async (_prompt: string) => '{"realistic": true, "explanation": "ok"}');
    const a = new GoalAssessor({ goal: 'build a website in 1 day', runOnce });
    const result = await a.assess();
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls[0]?.[0]).toContain('build a website in 1 day');
    expect(result.parseFailed).toBe(false);
    expect(result.realistic).toBe(true);
  });

  it('propagates runOnce errors', async () => {
    const a = new GoalAssessor({
      goal: 'test',
      runOnce: vi.fn(async () => {
        throw new Error('LLM unavailable');
      }),
    });
    await expect(a.assess()).rejects.toThrow('LLM unavailable');
  });
});

describe('GoalAssessor.buildPrompt', () => {
  it('renders the goal into the instruction template', () => {
    const a = makeAssessor('', 'ship the feature by Friday');
    const prompt = a.buildPrompt();
    expect(prompt).toContain('ship the feature by Friday');
  });
});
