import { describe, expect, it } from 'vitest';
import {
  parseNextSteps,
  stripNextStepsBlock,
} from '../../src/components/NextStepsBar';

/**
 * Tests for the canonical `<nextsteps>` block parser that the
 * MessageBubble component uses to (1) extract clickable suggestion buttons
 * and (2) strip the raw block from the content fed to react-markdown.
 *
 * Background: react-markdown v10's micromark parser does not dispatch
 * `<nextsteps>` (underscored tag) to the `components` map — it leaks
 * through as raw HTML. The previous parser only matched the legacy `💡
 * Next steps` heading, so the new XML format was being printed verbatim
 * to the screen instead of being rendered as buttons. These tests pin the
 * corrected behavior.
 */

describe('parseNextSteps', () => {
  describe('XML <nextsteps> format (preferred)', () => {
    it('extracts steps from a balanced <nextsteps> block', () => {
      const content = `I made the changes you asked for.

<nextsteps>
1. Fix shell injection in tools/shell.ts:42
2. Replace Math.random() with crypto.randomUUID() in 4 files
3. Run pnpm typecheck to verify fixes
</nextsteps>`;

      const { steps, stripped } = parseNextSteps(content);

      expect(steps).toEqual([
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

    it('caps at 6 items', () => {
      const content = `<nextsteps>
1. A
2. B
3. C
4. D
5. E
6. F
7. G
8. H
</nextsteps>`;

      const { steps } = parseNextSteps(content);
      expect(steps).toHaveLength(6);
      expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('rejects an unbalanced block (no closing tag) in strict mode', () => {
      const content = `Some prose.

<nextsteps>
1. Fix the bug
2. Run tests`;

      const { steps, stripped } = parseNextSteps(content, true);
      // We don't trust malformed blocks — the agent should always emit
      // a balanced pair. Refuse to consume anything.
      expect(steps).toEqual([]);
      expect(stripped).toBe(content);
    });

    it('rejects markdown headings even when strict is false', () => {
      const content = `Some prose.

## Next steps
1. Fix the bug
2. Run tests`;

      const { steps, stripped } = parseNextSteps(content, false);
      expect(steps).toEqual([]);
      expect(stripped).toBe(content);
    });

    it('returns empty result for content without a block', () => {
      const content = 'Just some prose, no suggestions here.';
      const { steps, stripped } = parseNextSteps(content);
      expect(steps).toEqual([]);
      expect(stripped).toBe(content);
    });
  });

  describe('legacy loose next-step formats', () => {
    it('are ignored so /next only activates for the tagged block', () => {
      const content = `All done.

💡 Next steps
1. Run pnpm test
2. Commit the changes`;

      const { steps, stripped } = parseNextSteps(content);

      expect(steps).toEqual([]);
      expect(stripped).toBe(content);
    });
  });

  describe('whitespace and edge cases', () => {
    it('preserves prose before and after the block', () => {
      const content = `Before prose.

<nextsteps>
1. Do thing
</nextsteps>

After prose.`;

      const { stripped } = parseNextSteps(content);
      expect(stripped).toContain('Before prose.');
      expect(stripped).toContain('After prose.');
      expect(stripped).not.toContain('<nextsteps>');
    });

    it('handles blank lines inside the block', () => {
      const content = `<nextsteps>

1. First

2. Second

</nextsteps>`;

      const { steps } = parseNextSteps(content);
      expect(steps).toEqual([
        { index: 1, text: 'First' },
        { index: 2, text: 'Second' },
      ]);
    });

    it('skips duplicate indices but keeps short valid text', () => {
      const content = `<nextsteps>
1. First step
1. Duplicate of first
2. OK
</nextsteps>`;

      const { steps } = parseNextSteps(content);
      expect(steps.map((s) => s.index)).toEqual([1, 2]);
      expect(steps[1]?.text).toBe('OK');
    });

    it('caps runaway whitespace to 2 consecutive newlines', () => {
      const content = `Before.


<nextsteps>
1. A
</nextsteps>



After.`;

      const { stripped } = parseNextSteps(content);
      expect(stripped).not.toMatch(/\n{3,}/);
    });
  });
});

describe('stripNextStepsBlock', () => {
  it('removes a <nextsteps>...</nextsteps> block entirely', () => {
    const text = 'Prose.\n<nextsteps>\n1. A\n2. B\n</nextsteps>\nMore prose.';
    const out = stripNextStepsBlock(text);
    expect(out).not.toContain('<nextsteps>');
    expect(out).not.toContain('</nextsteps>');
    expect(out).toContain('Prose.');
    expect(out).toContain('More prose.');
  });

  it('removes a self-closing <next_steps/>', () => {
    const out = stripNextStepsBlock('A\n<next_steps/>\nB');
    expect(out).not.toContain('<next_steps');
    expect(out).toContain('A');
    expect(out).toContain('B');
  });

  it('passes through text with no block unchanged', () => {
    const text = 'Just plain text.';
    expect(stripNextStepsBlock(text)).toBe(text.trim());
  });
});
