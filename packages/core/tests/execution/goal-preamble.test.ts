import { describe, it, expect } from 'vitest';
import { buildGoalPreamble } from '../../src/execution/goal-preamble.js';

describe('buildGoalPreamble', () => {
  it('returns a non-empty string', () => {
    const result = buildGoalPreamble('Fix the bug');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('contains the goal text verbatim', () => {
    const goal = 'Fix the login bug';
    const result = buildGoalPreamble(goal);
    expect(result).toContain(goal);
  });

  it('contains all four section headers', () => {
    const result = buildGoalPreamble('Test goal');
    expect(result).toContain('AUTHORITY YOU HAVE:');
    expect(result).toContain('WHAT "DONE" MEANS — non-negotiable:');
    expect(result).toContain('WHAT IS NOT DONE — never report any of these as completion:');
    expect(result).toContain('PERSISTENCE PROTOCOL:');
  });

  it('contains the GOAL locked marker', () => {
    const result = buildGoalPreamble('Any goal');
    expect(result).toContain('[GOAL — LOCKED IN.');
  });

  it('contains the BEGIN marker at the end', () => {
    const result = buildGoalPreamble('Any goal');
    expect(result).toContain('BEGIN.]');
  });

  it('handles empty string goal', () => {
    const result = buildGoalPreamble('');
    expect(result).toContain('[GOAL — LOCKED IN.');
    expect(result).toContain('AUTHORITY YOU HAVE:');
  });

  it('handles multi-line goal text', () => {
    const goal = 'Line one\nLine two\nLine three';
    const result = buildGoalPreamble(goal);
    expect(result).toContain(goal);
  });

  it('handles goal with special characters', () => {
    const goal = 'Fix "special" <chars> and `code`';
    const result = buildGoalPreamble(goal);
    expect(result).toContain(goal);
  });

  it('does not include REPORTING section for short goals', () => {
    const result = buildGoalPreamble('Short goal');
    expect(result).toContain('REPORTING:');
  });

  it('contains spawn authority statement', () => {
    const result = buildGoalPreamble('Test');
    expect(result).toContain('Spawn as many subagents');
  });

  it('contains no hidden budget statement', () => {
    const result = buildGoalPreamble('Test');
    expect(result).toContain('NO hidden budget');
  });

  it('contains subagent retry directive', () => {
    const result = buildGoalPreamble('Test');
    expect(result).toContain('respawn with a tighter prompt');
  });

  it('is stable across calls with same input', () => {
    const goal = 'Stable goal';
    expect(buildGoalPreamble(goal)).toBe(buildGoalPreamble(goal));
  });

  it('produces different output for different goals', () => {
    const r1 = buildGoalPreamble('Goal A');
    const r2 = buildGoalPreamble('Goal B');
    expect(r1).not.toBe(r2);
    expect(r1).toContain('Goal A');
    expect(r2).toContain('Goal B');
  });
});
