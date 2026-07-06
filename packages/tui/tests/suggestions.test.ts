import { describe, expect, it } from 'vitest';
import { parseNextSteps, stripNextStepsBlock } from '../src/components/suggestions.js';

describe('parseNextSteps (strict mode — assistant-message path)', () => {
  it('returns no steps when there is no heading and no XML tag', () => {
    // Regression test: the legacy webui parser fell back to treating any
    // "1. foo" line in the message body as a step. The TUI's parser must
    // not — a canonical <nextsteps> tag is required
    // before items are recognised.
    const text = [
      'Here is my plan:',
      '',
      '1. First do X',
      '2. Then do Y',
      '',
      'That is all.',
    ].join('\n');
    const { steps, stripped } = parseNextSteps(text, true);
    expect(steps).toEqual([]);
    expect(stripped).toBe(text);
  });

  it('returns no steps for a single "1. foo" line with no surrounding context', () => {
    const { steps, stripped } = parseNextSteps('1. foo', true);
    expect(steps).toEqual([]);
    expect(stripped).toBe('1. foo');
  });

  it('parses the <nextsteps> XML tag block with closing tag', () => {
    const text = [
      'Some preamble.',
      '',
      '<nextsteps>',
      '1. Run the smoke test',
      '2. Commit the change',
      '3. Push',
      '</nextsteps>',
      '',
      'Some postamble.',
    ].join('\n');
    const { steps, stripped, texts } = parseNextSteps(text, true);
    expect(steps.map((s) => s.text)).toEqual([
      'Run the smoke test',
      'Commit the change',
      'Push',
    ]);
    expect(texts).toEqual([
      'Run the smoke test',
      'Commit the change',
      'Push',
    ]);
    expect(stripped).not.toContain('<nextsteps>');
    expect(stripped).not.toContain('1. Run the smoke test');
    expect(stripped).toContain('Some preamble.');
    expect(stripped).toContain('Some postamble.');
  });

  it('ignores legacy loose next-step headings', () => {
    const text = [
      'I did the thing.',
      '',
      '💡 Next steps',
      '1. First',
      '2. Second',
    ].join('\n');
    const { stripped, texts } = parseNextSteps(text, true);
    expect(texts).toEqual([]);
    expect(stripped).toBe(text);
  });

  it('rejects the XML tag block when the closing tag is missing (strict mode)', () => {
    // The webui subagent's fix also added this: a <nextsteps> block
    // without </nextsteps> is malformed and should be rejected in strict
    // mode. The TUI's parseNextSteps already enforces this.
    const text = [
      'Preamble.',
      '',
      '<nextsteps>',
      '1. First',
      '2. Second',
      '',
      'No closing tag here.',
    ].join('\n');
    const { steps, stripped } = parseNextSteps(text, true);
    expect(steps).toEqual([]);
    // Reject means the original text is preserved unchanged.
    expect(stripped).toBe(text);
  });

  it('does not pick up numbered items from BEFORE the heading', () => {
    // The bug: legacy parser treated the "1. " list above the <nextsteps>
    // tag as the steps, ignoring the actual block. The TUI's parser matches
    // the heading first, then only items after it.
    const text = [
      'My reasoning:',
      '1. start with the registry',
      '2. then add the runner',
      '3. then write tests',
      '',
      'Conclusion:',
      '',
      '<nextsteps>',
      '1. Commit the change',
      '2. Push',
      '</nextsteps>',
    ].join('\n');
    const { steps, texts } = parseNextSteps(text, true);
    expect(texts).toEqual(['Commit the change', 'Push']);
    expect(steps).toHaveLength(2);
  });

  it('caps at MAX_STEPS (6) items', () => {
    const lines = ['<nextsteps>'];
    for (let i = 1; i <= 10; i++) {
      lines.push(`${i}. Step number ${i}`);
    }
    lines.push('</nextsteps>');
    const { steps } = parseNextSteps(lines.join('\n'), true);
    expect(steps).toHaveLength(6);
  });

  it('honours the auto="true" attribute', () => {
    const text = [
      '<nextsteps>',
      '1. Run tests',
      '2. Commit auto="true"',
      '3. Push',
      '</nextsteps>',
    ].join('\n');
    const { steps, autoTexts } = parseNextSteps(text, true);
    expect(steps.map((s) => ({ text: s.text, auto: !!s.auto }))).toEqual([
      { text: 'Run tests', auto: false },
      { text: 'Commit', auto: true },
      { text: 'Push', auto: false },
    ]);
    expect(autoTexts).toEqual(['Commit']);
  });
});

describe('parseNextSteps (REPL store path)', () => {
  it('requires the canonical XML block even when strict is false', () => {
    const looseCases = [
      '💡 Next steps\n1. First\n2. Second',
      '## Next steps\n1. First\n2. Second',
      '\nNext steps\n1. First\n2. Second',
      'Next suggests\n1. First\n2. Second',
    ];
    for (const text of looseCases) {
      const { texts, stripped } = parseNextSteps(text, false);
      expect(texts).toEqual([]);
      expect(stripped).toBe(text);
    }

    const { texts } = parseNextSteps('<nextsteps>\n1. First\n2. Second\n</nextsteps>', false);
    expect(texts).toEqual(['First', 'Second']);
  });
});

describe('parseNextSteps (raw mode — /suggest subagent output)', () => {
  it('parses numbered items from anywhere when requireHeading is false', () => {
    // /suggest subagent output has no heading — it returns a raw numbered
    // list. This is opt-in via requireHeading = false; it's not the
    // assistant-message path and should never be used for that.
    const text = [
      'I think you should:',
      '',
      '1. Run the typecheck',
      '2. Add a test',
      '3. Commit',
    ].join('\n');
    const { texts } = parseNextSteps(text, false, false);
    expect(texts).toEqual(['Run the typecheck', 'Add a test', 'Commit']);
  });
});

describe('stripNextStepsBlock', () => {
  it('removes a complete <nextsteps>...</nextsteps> block', () => {
    const text = [
      'Preamble.',
      '',
      '<nextsteps>',
      '1. Foo',
      '2. Bar',
      '</nextsteps>',
      '',
      'Postamble.',
    ].join('\n');
    expect(stripNextStepsBlock(text)).toBe('Preamble.\n\nPostamble.');
  });

  it('removes a self-closing <nextsteps/> tag', () => {
    const text = 'Preamble.\n<nextsteps/>\nPostamble.';
    expect(stripNextStepsBlock(text)).toBe('Preamble.\n\nPostamble.');
  });

  it('removes attributes on the opening tag', () => {
    const text = 'Pre.\n<nextsteps auto="true">1. Foo</nextsteps>\nPost.';
    expect(stripNextStepsBlock(text)).toBe('Pre.\n\nPost.');
  });
});
