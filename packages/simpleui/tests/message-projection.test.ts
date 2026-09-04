import { describe, expect, it } from 'vitest';
import { projectAssistantMessage } from '../src/lib/message-projection.js';

/**
 * Regression coverage for fenced <nextsteps> code examples: a fenced block is
 * documentation the user asked to see — it must survive verbatim and never be
 * parsed into (executable) suggestions.
 */
describe('projectAssistantMessage — fenced examples', () => {
  it('preserves a fenced example verbatim and extracts no suggestions from it', () => {
    const text = [
      'Here is the suggestion format:',
      '',
      '```xml',
      '<nextsteps>',
      '1. Run the test suite',
      '2. Review the diff',
      '</nextsteps>',
      '```',
      '',
      'Use it in your replies.',
    ].join('\n');
    const projection = projectAssistantMessage(text);
    expect(projection.nextSteps).toEqual([]);
    expect(projection.text).toBe(text);
  });

  it('still parses a real (non-fenced) canonical block', () => {
    const projection = projectAssistantMessage(
      'Answer.\n\n<nextsteps>\n1. Alpha\n2. Beta\n</nextsteps>',
    );
    expect(projection.nextSteps.map((s) => s.text)).toEqual(['Alpha', 'Beta']);
    expect(projection.text).toBe('Answer.');
  });

  it('parses a real block while preserving a fenced example in the same message', () => {
    const text = [
      'Real one:',
      '',
      '<nextsteps>',
      '1. Real step',
      '</nextsteps>',
      '',
      'Example:',
      '',
      '```xml',
      '<nextsteps>',
      '1. Fake step',
      '</nextsteps>',
      '```',
    ].join('\n');
    const projection = projectAssistantMessage(text);
    expect(projection.nextSteps.map((s) => s.text)).toEqual(['Real step']);
    expect(projection.text).toContain('1. Fake step');
    expect(projection.text).toContain('```xml');
    expect(projection.text).not.toContain('1. Real step');
  });

  it('does not truncate streaming text at a legacy tag inside an unclosed fence', () => {
    const text = ['Config example:', '', '```xml', '<next_steps>', '1. Draft step'].join('\n');
    const projection = projectAssistantMessage(text);
    expect(projection.nextSteps).toEqual([]);
    expect(projection.text).toBe(text);
  });
});
