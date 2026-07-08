import { describe, expect, it } from 'vitest';
import { parseNextSteps, stripNextStepsBlock } from '../src/next-steps.js';

/**
 * Tests for the canonical `<nextsteps>` block parser, now extracted into
 * `@wrongstack/tools/next-steps` as the single source of truth shared by
 * the TUI history renderer, the CLI REPL suggestion store, the CLI
 * /suggest subagent output, and the WebUI MessageBubble/NextStepsBar.
 *
 * Behavior must remain byte-identical to the previous TUI-resident
 * implementation (`packages/tui/src/components/suggestions.ts`) and the
 * WebUI's local `NextStepsBar.tsx` implementation; this test suite pins
 * every branch the old TUI suite pinned, plus the WebUI's stricter
 * whitespace / no-auto-on-falsy expectation.
 */

describe('parseNextSteps (strict mode — assistant-message path)', () => {
  it('returns no steps when there is no heading and no XML tag', () => {
    // Regression test: the legacy webui parser fell back to treating any
    // "1. foo" line in the message body as a step. The parser must not —
    // a canonical <nextsteps> tag is required before items are recognised.
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
    // A <nextsteps> block without </nextsteps> is malformed and should be
    // rejected in strict mode.
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
    // tag as the steps, ignoring the actual block. The parser matches the
    // heading first, then only items after it.
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

describe('parseNextSteps (WebUI parity — previously NextStepsBar.tsx)', () => {
  // These tests mirror the WebUI's previous local parser to guard against
  // regressions during the migration to the shared module.

  it('extracts steps from a balanced <nextsteps> block (WebUI shape)', () => {
    const content = `I made the changes you asked for.

<nextsteps>
1. Fix shell injection in tools/shell.ts:42
2. Replace Math.random() with crypto.randomUUID() in 4 files
3. Run pnpm typecheck to verify fixes
</nextsteps>`;

    const { steps, stripped } = parseNextSteps(content);

    expect(steps.map((s) => ({ index: s.index, text: s.text }))).toEqual([
      { index: 1, text: 'Fix shell injection in tools/shell.ts:42' },
      { index: 2, text: 'Replace Math.random() with crypto.randomUUID() in 4 files' },
      { index: 3, text: 'Run pnpm typecheck to verify fixes' },
    ]);
    // The block must be stripped from the rendered content so the raw
    // <nextsteps>1- 2- 3- </nextsteps> text never appears on screen.
    expect(stripped).not.toContain('<nextsteps>');
    expect(stripped).not.toContain('</nextsteps>');
    expect(stripped).not.toContain('1. Fix shell injection');
    // The preceding prose is preserved.
    expect(stripped).toContain('I made the changes you asked for.');
  });

  it('parses auto="true" attribute and removes it from the text', () => {
    const content = `<nextsteps>
1. Continue to next phase auto="true"
2. Review the diff
</nextsteps>`;

    const { steps } = parseNextSteps(content);

    expect(steps).toEqual([
      { index: 1, text: 'Continue to next phase', auto: true },
      { index: 2, text: 'Review the diff' },
    ]);
  });

  it('returns empty result for content without a block', () => {
    const content = 'Just some prose, no suggestions here.';
    const { steps, stripped } = parseNextSteps(content);
    expect(steps).toEqual([]);
    expect(stripped).toBe(content);
  });

  it('skips duplicate indices but keeps short valid text', () => {
    // The consolidated parser no longer enforces the 3-character minimum
    // that the original TUI parser used. The canonical `<nextsteps>` tag
    // requirement already scopes parsing to the deliberate block, and the
    // duplicate-index filter prevents accidental prose collisions. WebUI's
    // previous local parser accepted short steps like "2. OK".
    const content = `<nextsteps>
1. First step
1. Duplicate of first
2. OK
</nextsteps>`;
    const { steps } = parseNextSteps(content);
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
    expect(steps[1]?.text).toBe('OK');
  });

  it('caps runaway whitespace to 2 consecutive newlines in stripped output', () => {
    const content = `Before.


<nextsteps>
1. A
</nextsteps>



After.`;

    const { stripped } = parseNextSteps(content);
    expect(stripped).not.toMatch(/\n{3,}/);
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

  it('passes through text with no block unchanged', () => {
    const text = 'Just plain text.';
    expect(stripNextStepsBlock(text)).toBe(text.trim());
  });

  it('removes the legacy <next_steps/> self-closing form (WebUI parity)', () => {
    // Older persisted subagent output may contain the legacy `<next_steps/>`
    // spelling. The shared stripper handles both forms.
    const out = stripNextStepsBlock('A\n<next_steps/>\nB');
    expect(out).not.toContain('<next_steps');
    expect(out).toContain('A');
    expect(out).toContain('B');
  });
});