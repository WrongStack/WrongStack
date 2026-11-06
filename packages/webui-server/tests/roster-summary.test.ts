import { describe, expect, it } from 'vitest';
import { rosterPromptSummary } from '../src/server/roster-summary.js';

describe('rosterPromptSummary', () => {
  it('joins the hard-wrapped lines of the first prose paragraph', () => {
    const prompt = [
      '# Analyst',
      '',
      'You are the Analyst agent. Your job is requirement analysis: turn a',
      'vague request into a scoped, testable brief.',
      '',
      'Second paragraph.',
    ].join('\n');
    expect(rosterPromptSummary(prompt)).toBe(
      'You are the Analyst agent. Your job is requirement analysis: turn a vague request into a scoped, testable brief.',
    );
  });

  it('skips short paragraphs, headings and rules', () => {
    expect(rosterPromptSummary('Hi.\n\n---\n## Role\nYou review code for correctness bugs.')).toBe(
      'You review code for correctness bugs.',
    );
  });

  it('ends a very long paragraph at a word boundary with an ellipsis', () => {
    const summary = rosterPromptSummary(`${'word '.repeat(100)}end`);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(281);
    expect(summary).not.toMatch(/ …$/);
  });

  it('returns an empty summary without a prompt', () => {
    expect(rosterPromptSummary(undefined)).toBe('');
    expect(rosterPromptSummary('short')).toBe('');
  });
});
