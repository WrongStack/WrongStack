import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOL_DESCRIPTION_MODE,
  applyToolDescriptionModeToTool,
  applyToolDescriptionModes,
  getToolDescriptionMode,
  normalizeToolDescriptionMode,
  resolveToolDescriptionMode,
  setToolDescriptionMode,
  simplifyToolDescription,
} from '../../src/utils/tool-description-mode.js';
import type { Tool } from '../../src/types/tool.js';

function makeTool(over: Partial<Tool> = {}): Tool {
  return {
    name: 't',
    description: 'A tool.',
    permission: 'auto',
    inputSchema: { type: 'object' },
    execute: vi.fn(async () => '') as never,
    ...over,
  } as Tool;
}

describe('normalizeToolDescriptionMode', () => {
  it('maps the extend family', () => {
    expect(normalizeToolDescriptionMode('extend')).toBe('extend');
    expect(normalizeToolDescriptionMode('EXTENDED')).toBe('extend');
    expect(normalizeToolDescriptionMode(' Full ')).toBe('extend');
  });
  it('maps the simple family', () => {
    expect(normalizeToolDescriptionMode('simple')).toBe('simple');
    expect(normalizeToolDescriptionMode('short')).toBe('simple');
    expect(normalizeToolDescriptionMode('BRIEF')).toBe('simple');
  });
  it('returns undefined for non-strings and unknown values', () => {
    expect(normalizeToolDescriptionMode(undefined)).toBeUndefined();
    expect(normalizeToolDescriptionMode(5)).toBeUndefined();
    expect(normalizeToolDescriptionMode('verbose')).toBeUndefined();
  });
});

describe('resolveToolDescriptionMode', () => {
  it('uses the per-tool mode, falls back to the default', () => {
    expect(resolveToolDescriptionMode({ bash: 'simple' }, 'bash')).toBe('simple');
    expect(resolveToolDescriptionMode({ bash: 'simple' }, 'other')).toBe(
      DEFAULT_TOOL_DESCRIPTION_MODE,
    );
    expect(resolveToolDescriptionMode(undefined, 'bash')).toBe(DEFAULT_TOOL_DESCRIPTION_MODE);
    expect(resolveToolDescriptionMode({ bash: 'garbage' }, 'bash')).toBe(
      DEFAULT_TOOL_DESCRIPTION_MODE,
    );
  });
});

describe('simplifyToolDescription', () => {
  it('returns short text normalized (whitespace collapsed)', () => {
    expect(simplifyToolDescription('  Hello   world.  ')).toBe('Hello world.');
  });
  it('keeps text under the char limit as-is', () => {
    const text =
      'This is a short description that fits within the default limit without any problem.';
    expect(simplifyToolDescription(text)).toBe(text);
  });
  it('selects up to maxSentences for multi-sentence text', () => {
    const text =
      'First sentence here that is reasonably long on its own. ' +
      'Second sentence that follows it in sequence. ' +
      'Third sentence which should be dropped by the cap.';
    // maxChars sits between two-sentences and three-sentences so the
    // selection returns exactly the first two without hard truncation.
    const out = simplifyToolDescription(text, { maxSentences: 2, maxChars: 130 });
    expect(out).toContain('First sentence');
    expect(out).toContain('Second sentence');
    expect(out).not.toContain('Third sentence');
  });
  it('truncates with a word boundary at a sentence punctuation', () => {
    const text = `Word `.repeat(60) + '. ' + `More `.repeat(60) + '.'; // has '. ' after many words
    const out = simplifyToolDescription(text, { maxChars: 180 });
    expect(out.endsWith('...')).toBe(true);
  });
  it('truncates at a space boundary when there is no sentence punctuation', () => {
    const text = `${'word '.repeat(80)}`; // spaces, no sentence punctuation
    const out = simplifyToolDescription(text, { maxChars: 180, maxSentences: 1 });
    expect(out.endsWith('...')).toBe(true);
  });
  it('falls back to a hard slice when there are no boundaries', () => {
    const out = simplifyToolDescription('a'.repeat(400), { maxChars: 180 });
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThan(200);
  });
  it('treats all-punctuation text as a single sentence (regex null-match)', () => {
    const out = simplifyToolDescription('!?'.repeat(200), { maxChars: 180 });
    expect(out.endsWith('...')).toBe(true);
  });
  it('truncates at a mid-string sentence punctuation (semantic boundary)', () => {
    // '. ' lands between position 40 and the char limit → findWordBoundary semantic branch.
    const text = `${'fillerword '.repeat(10)}ends. ${'trailingword '.repeat(40)}`;
    const out = simplifyToolDescription(text, { maxChars: 180 });
    expect(out.endsWith('...')).toBe(true);
  });
  it('honors custom maxChars under the floor of 40', () => {
    // maxChars clamped to >= 40
    const out = simplifyToolDescription('a'.repeat(300), { maxChars: 5 });
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('applyToolDescriptionModeToTool', () => {
  it('returns the tool unchanged for extend with no prior original', () => {
    const tool = makeTool({ description: 'Original.' });
    expect(applyToolDescriptionModeToTool(tool, 'extend')).toBe(tool);
  });
  it('simplifies the description in simple mode', () => {
    const tool = makeTool({ description: `${'long description sentence. '.repeat(20)}` });
    const out = applyToolDescriptionModeToTool(tool, 'simple');
    expect(out.description.length).toBeLessThan(tool.description.length);
  });
  it('simplifies a present usageHint and drops an undefined one', () => {
    const toolWithHint = makeTool({
      description: 'Short.',
      usageHint: `${'hint sentence. '.repeat(30)}`,
    });
    const out1 = applyToolDescriptionModeToTool(toolWithHint, 'simple');
    expect(out1.usageHint).toBeDefined();
    expect(out1.usageHint!.length).toBeLessThan(toolWithHint.usageHint!.length);

    const toolNoHint = makeTool({ description: 'Short.' });
    const out2 = applyToolDescriptionModeToTool(toolNoHint, 'simple');
    expect(out2.usageHint).toBeUndefined();
  });
  it('restores the original description when switching back to extend', () => {
    const tool = makeTool({ description: `${'very long original description. '.repeat(20)}` });
    const simple = applyToolDescriptionModeToTool(tool, 'simple');
    expect(simple.description).not.toBe(tool.description);
    const restored = applyToolDescriptionModeToTool(simple, 'extend');
    expect(restored.description).toBe(tool.description);
  });
});

describe('registry helpers', () => {
  it('setToolDescriptionMode prefers registry.setDescriptionMode when present', () => {
    const registry = {
      get: vi.fn(),
      list: vi.fn(() => []),
      setDescriptionMode: vi.fn(() => true),
    };
    expect(setToolDescriptionMode(registry as never, 'bash', 'simple')).toBe(true);
    expect(registry.setDescriptionMode).toHaveBeenCalledWith('bash', 'simple');
  });

  it('setToolDescriptionMode wraps the tool when only get+wrap are available', () => {
    const wrap = vi.fn((_name: string, wrapper: (t: Tool) => Tool) => {
      wrapper(makeTool()); // invoke the wrapper so its body is covered
    });
    const registry = {
      get: vi.fn(() => makeTool()),
      list: vi.fn(() => []),
      wrap,
    };
    expect(setToolDescriptionMode(registry as never, 'bash', 'simple')).toBe(true);
    expect(wrap).toHaveBeenCalledWith('bash', expect.any(Function), 'tool-description-mode');
  });

  it('setToolDescriptionMode returns false when the tool is missing or no wrap', () => {
    expect(
      setToolDescriptionMode(
        { get: () => undefined, list: () => [], wrap: vi.fn() } as never,
        'x',
        'simple',
      ),
    ).toBe(false);
    expect(
      setToolDescriptionMode({ get: () => makeTool(), list: () => [] } as never, 'x', 'simple'),
    ).toBe(false);
  });

  it('getToolDescriptionMode delegates or defaults', () => {
    expect(
      getToolDescriptionMode(
        { get: () => undefined, list: () => [], getDescriptionMode: () => 'simple' } as never,
        'x',
      ),
    ).toBe('simple');
    expect(getToolDescriptionMode({ get: () => undefined, list: () => [] } as never, 'x')).toBe(
      DEFAULT_TOOL_DESCRIPTION_MODE,
    );
  });

  it('applyToolDescriptionModes prefers registry.applyDescriptionModes', () => {
    const registry = {
      get: vi.fn(),
      list: vi.fn(),
      applyDescriptionModes: vi.fn(() => ({ applied: 3, missing: ['z'] })),
    };
    expect(applyToolDescriptionModes(registry as never, { bash: 'simple' })).toEqual({
      applied: 3,
      missing: ['z'],
    });
  });

  it('applyToolDescriptionModes with no modes applies nothing', () => {
    const wrap = vi.fn();
    const registry = { get: vi.fn(() => makeTool()), list: () => [], wrap };
    expect(applyToolDescriptionModes(registry as never, undefined)).toEqual({
      applied: 0,
      missing: [],
    });
    expect(wrap).not.toHaveBeenCalled();
  });

  it('applyToolDescriptionModes loops: applied + missing + invalid-skip', () => {
    const wrap = vi.fn();
    const registry = {
      get: (name: string) => (name === 'missing' ? undefined : makeTool()),
      list: () => [],
      wrap,
    };
    const res = applyToolDescriptionModes(registry as never, {
      bash: 'simple', // valid + present -> applied
      missing: 'short', // valid + absent -> missing
      garbage: 'verbose', // invalid -> skipped
    });
    expect(res.applied).toBe(1);
    expect(res.missing).toEqual(['missing']);
  });
});
