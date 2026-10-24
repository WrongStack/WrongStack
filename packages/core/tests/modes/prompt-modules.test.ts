import { describe, expect, it } from 'vitest';
import { PROMPT as briefPrompt } from '../../src/core/modes/brief.js';
import { PROMPT as defaultPrompt } from '../../src/core/modes/default.js';
import { PROMPT as teachPrompt } from '../../src/core/modes/teach.js';
import { DEFAULT_MODES } from '../../src/models/default-modes.js';

// These modules only export a `PROMPT` string. Coverage requires the file
// to be executed at least once; this test does that and asserts the strings
// are non-empty and contain identifying markers.

describe('mode prompts', () => {
  it('brief prompt is non-empty and identifies itself as WrongStack', () => {
    expect(typeof briefPrompt).toBe('string');
    expect(briefPrompt.length).toBeGreaterThan(50);
    expect(briefPrompt).toMatch(/WrongStack/i);
  });

  it('teach prompt is non-empty and mentions teaching/mentor', () => {
    expect(typeof teachPrompt).toBe('string');
    expect(teachPrompt.length).toBeGreaterThan(50);
    expect(teachPrompt).toMatch(/teach|mentor/i);
  });

  it('default prompt is non-empty and identifies itself as WrongStack', () => {
    expect(typeof defaultPrompt).toBe('string');
    expect(defaultPrompt.length).toBeGreaterThan(50);
    expect(defaultPrompt).toMatch(/WrongStack/i);
  });

  it('built-in non-default mode prompts load from files', () => {
    // A FILTER result, and mode prompts load from disk: if DEFAULT_MODES came
    // back empty (or held only `default`), this asserted nothing and still
    // reported green.
    const builtIns = DEFAULT_MODES.filter((m) => m.id !== 'default');
    expect(builtIns.length).toBeGreaterThan(0);
    for (const mode of builtIns) {
      expect(mode.prompt.trim(), mode.id).toBeTruthy();
      expect(mode.prompt, mode.id).toContain('## ');
    }
  });
});
