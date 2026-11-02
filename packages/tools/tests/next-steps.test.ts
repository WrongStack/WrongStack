import { describe, expect, it } from 'vitest';
import { isFinalTurnStopReason, parseNextSteps, stripNextStepsBlock } from '../src/next-steps.js';

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
    const text = ['Here is my plan:', '', '1. First do X', '2. Then do Y', '', 'That is all.'].join(
      '\n',
    );
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
    expect(steps.map((s) => s.text)).toEqual(['Run the smoke test', 'Commit the change', 'Push']);
    expect(texts).toEqual(['Run the smoke test', 'Commit the change', 'Push']);
    expect(stripped).not.toContain('<nextsteps>');
    expect(stripped).not.toContain('1. Run the smoke test');
    expect(stripped).toContain('Some preamble.');
    expect(stripped).toContain('Some postamble.');
  });

  it('ignores legacy loose next-step headings', () => {
    const text = ['I did the thing.', '', '💡 Next steps', '1. First', '2. Second'].join('\n');
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

  it('honours auto="true" only on the first item', () => {
    const text = [
      '<nextsteps>',
      '1. Run tests auto="true"',
      '2. Commit auto="true"',
      '3. Push auto="true"',
      '</nextsteps>',
    ].join('\n');
    const { steps, autoTexts } = parseNextSteps(text, true);
    expect(steps.map((s) => ({ text: s.text, auto: !!s.auto }))).toEqual([
      { text: 'Run tests', auto: true },
      { text: 'Commit', auto: false },
      { text: 'Push', auto: false },
    ]);
    expect(autoTexts).toEqual(['Run tests']);
  });

  it('ignores auto="true" when it appears only on a later item', () => {
    const text = [
      '<nextsteps>',
      '1. Review the diff',
      '2. Run tests auto="true"',
      '</nextsteps>',
    ].join('\n');

    const { steps, autoTexts } = parseNextSteps(text, true);

    expect(steps).toEqual([
      { index: 1, text: 'Review the diff' },
      { index: 2, text: 'Run tests' },
    ]);
    expect(autoTexts).toEqual([]);
  });

  it('tolerates attributes on the opening tag without treating them as auto-submit', () => {
    const text = [
      'Done.',
      '<nextsteps auto="true">',
      '1. Inspect the diff',
      '2. Run tests',
      '</nextsteps>',
    ].join('\n');

    const { steps, stripped, autoTexts } = parseNextSteps(text, true);

    expect(steps).toEqual([
      { index: 1, text: 'Inspect the diff' },
      { index: 2, text: 'Run tests' },
    ]);
    expect(autoTexts).toEqual([]);
    expect(stripped).toBe('Done.');
  });
});

describe('parseNextSteps (REPL store path)', () => {
  it('requires the canonical XML block in the default heading mode', () => {
    const looseCases = [
      '💡 Next steps\n1. First\n2. Second',
      '## Next steps\n1. First\n2. Second',
      '\nNext steps\n1. First\n2. Second',
      'Next suggests\n1. First\n2. Second',
    ];
    for (const text of looseCases) {
      const { texts, stripped } = parseNextSteps(text);
      expect(texts).toEqual([]);
      expect(stripped).toBe(text);
    }

    const { texts } = parseNextSteps('<nextsteps>\n1. First\n2. Second\n</nextsteps>');
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
    const { texts } = parseNextSteps(text, false);
    expect(texts).toEqual(['Run the typecheck', 'Add a test', 'Commit']);
  });

  it('keeps bold intros, rules and decimals out of the list', () => {
    // A marker needs whitespace (or, for numbers, no digit after it); otherwise
    // `**Intro**` / `---` became item 1 and displaced the real first step.
    const list = '1. Run tests\n2. Fix lint';
    expect(parseNextSteps(`**Suggested next steps:**\n${list}`, false).texts).toEqual([
      'Run tests',
      'Fix lint',
    ]);
    expect(parseNextSteps(`Here you go\n---\n${list}`, false).texts).toEqual([
      'Run tests',
      'Fix lint',
    ]);
    expect(parseNextSteps('1. Run tests\n2.5x faster builds\n2. Ship', false).texts).toEqual([
      'Run tests',
      'Ship',
    ]);
  });

  it('parses bullet items in raw mode', () => {
    const text = '- First bullet\n- Second bullet';
    const { texts } = parseNextSteps(text, false);
    expect(texts).toEqual(['First bullet', 'Second bullet']);
  });

  it('accepts auto="true" only on the first item in raw mode', () => {
    const text = '1. Auto item auto="true"\n2. Later marker auto="true"\n3. Also plain';
    const { steps, autoTexts } = parseNextSteps(text, false);
    expect(steps).toEqual([
      { index: 1, text: 'Auto item', auto: true },
      { index: 2, text: 'Later marker' },
      { index: 3, text: 'Also plain' },
    ]);
    expect(autoTexts).toEqual(['Auto item']);
  });

  it('skips duplicate numbers in raw mode', () => {
    const text = '1. First\n1. Duplicate\n2. Second';
    const { texts } = parseNextSteps(text, false);
    expect(texts).toEqual(['First', 'Second']);
  });

  it('caps at MAX_STEPS in raw mode', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) lines.push(`${i}. Step ${i}`);
    const { steps } = parseNextSteps(lines.join('\n'), false);
    expect(steps).toHaveLength(6);
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

  it('keeps a numbered item that follows a bullet item', () => {
    // Regression (bug-hunt round 17): the duplicate-index guard compared a
    // bullet's positional index against explicit item numbers, so
    // `1. First / - detail / 2. Second` dropped the real `2. Second` — and
    // the block is stripped from the body, so the user lost that suggestion
    // entirely. The guard must only drop repeated ITEM NUMBERS.
    const content = `<nextsteps>
1. First
- detail
2. Second
</nextsteps>`;
    const { texts } = parseNextSteps(content);
    expect(texts).toEqual(['First', 'detail', 'Second']);
  });

  it('keeps every numbered item when several bullets sit between them', () => {
    const content = `<nextsteps>
1. Alpha
- a1
- a2
2. Beta
3. Gamma
</nextsteps>`;
    const { texts } = parseNextSteps(content);
    expect(texts).toEqual(['Alpha', 'a1', 'a2', 'Beta', 'Gamma']);
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

  it('accepts bullet items (-) in heading mode', () => {
    const content = `<nextsteps>
- First bullet item
- Second bullet item
</nextsteps>`;
    const { steps } = parseNextSteps(content);
    expect(steps.map((s) => s.text)).toEqual(['First bullet item', 'Second bullet item']);
    expect(steps[0]!.index).toBe(1); // bullet gets sequential index
    expect(steps[1]!.index).toBe(2);
  });

  it('accepts asterisk bullet items in heading mode', () => {
    const content = `<nextsteps>
* Setup
* Test
</nextsteps>`;
    const { steps } = parseNextSteps(content);
    expect(steps.map((s) => s.text)).toEqual(['Setup', 'Test']);
  });

  it('returns empty when heading is followed by non-item text', () => {
    const content = `<nextsteps>
This is not a numbered step.
</nextsteps>`;
    const { steps } = parseNextSteps(content);
    expect(steps).toEqual([]);
  });

  it('uses alt numbering formats 1) and 1)', () => {
    const content = `<nextsteps>
1) First
2) Second
</nextsteps>`;
    const { steps } = parseNextSteps(content);
    expect(steps.map((s) => s.text)).toEqual(['First', 'Second']);
  });

  it('skips blank lines inside the block instead of stopping', () => {
    const content = `<nextsteps>
1. First

2. Second
</nextsteps>`;
    const { steps } = parseNextSteps(content);
    expect(steps.map((s) => s.text)).toEqual(['First', 'Second']);
  });

  it('stops at a non-item line inside the block', () => {
    const content = `<nextsteps>
1. First
Some commentary
2. Second
</nextsteps>`;
    const { steps } = parseNextSteps(content);
    expect(steps.map((s) => s.text)).toEqual(['First']);
  });

  // Regression: `<nextsteps>1. Run the tests</nextsteps>` written without
  // line breaks after the opening tag is the same block, but the heading
  // match only accepted a following newline (or an inline `<nextstep>`).
  // It was therefore parsed as prose: no suggestions, and the raw XML
  // survived in `stripped` straight into the rendered message body.
  it('parses a canonical block whose items start on the opening-tag line', () => {
    const content = 'All set.\n<nextsteps>1. Run the tests</nextsteps>';
    const { texts, stripped } = parseNextSteps(content);
    expect(texts).toEqual(['Run the tests']);
    expect(stripped).toBe('All set.');
  });

  it('accepts the single-line form for bullets and alt numbering', () => {
    expect(parseNextSteps('Done.\n<nextsteps>- Run the tests</nextsteps>').texts).toEqual([
      'Run the tests',
    ]);
    expect(parseNextSteps('Done.\n<nextsteps>1) Review the diff</nextsteps>').texts).toEqual([
      'Review the diff',
    ]);
  });

  it('ignores attributes on the opening tag of a single-line block', () => {
    const { texts, autoTexts } = parseNextSteps(
      'Done.\n<nextsteps auto="true">1. Run the tests</nextsteps>',
    );
    expect(texts).toEqual(['Run the tests']);
    expect(autoTexts).toEqual([]);
  });

  // Guard against the widened lookahead: prose on the opening-tag line is
  // still not a suggestion list.
  it('still ignores a single-line block whose body is not a list item', () => {
    const content = 'Done.\n<nextsteps>2024 budget review</nextsteps>';
    expect(parseNextSteps(content).steps).toEqual([]);
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

describe('isFinalTurnStopReason', () => {
  it('treats a tool stop as mid-turn', () => {
    // The agent loop will run again, so the message is prose on the way to a
    // tool call — not the model's answer.
    expect(isFinalTurnStopReason('tool_use')).toBe(false);
    // The spelling some providers put on the WebUI wire.
    expect(isFinalTurnStopReason('tool_call')).toBe(false);
  });

  it('treats every non-tool stop as the turn ending', () => {
    for (const reason of ['end_turn', 'max_tokens', 'stop_sequence', 'refusal']) {
      expect(isFinalTurnStopReason(reason)).toBe(true);
    }
  });

  it('defaults to final when no stop reason is available', () => {
    // Legacy paths that never carried a stop reason keep their suggestions
    // rather than losing them silently.
    expect(isFinalTurnStopReason(undefined)).toBe(true);
  });
});

describe('code fences (fenced examples are documentation, not metadata)', () => {
  // A fenced code example showing the suggestion syntax is user-facing
  // documentation: it must never be parsed into suggestions nor stripped
  // from the visible message.
  it('does not parse a <nextsteps> example inside a fenced code block', () => {
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
    const { steps, stripped } = parseNextSteps(text, true);
    expect(steps).toEqual([]);
    expect(stripped).toBe(text);
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
    const { steps, stripped } = parseNextSteps(text, true);
    expect(steps.map((s) => s.text)).toEqual(['Real step']);
    expect(stripped).toContain('1. Fake step');
    expect(stripped).toContain('```xml');
    expect(stripped).not.toContain('1. Real step');
  });

  it('rejects a tag inside an unclosed fence without truncating the text', () => {
    // An unterminated fence extends to end-of-text: the tag inside it is
    // example content, and nothing may be stripped.
    const text = ['Config example:', '', '```xml', '<nextsteps>', '1. Draft step'].join('\n');
    const { steps, stripped } = parseNextSteps(text, true);
    expect(steps).toEqual([]);
    expect(stripped).toBe(text);
  });

  it('stripNextStepsBlock preserves fenced examples and strips real blocks', () => {
    const text = [
      'Real:',
      '',
      '<nextsteps>',
      '1. Real step',
      '</nextsteps>',
      '',
      '```xml',
      '<nextsteps>',
      '1. Fake step',
      '</nextsteps>',
      '```',
    ].join('\n');
    const out = stripNextStepsBlock(text);
    expect(out).not.toContain('1. Real step');
    expect(out).toContain('1. Fake step');
    expect(out).toContain('```xml');
  });

  it('stripNextStepsBlock preserves a legacy tag inside a fence', () => {
    const text = ['A', '', '```xml', '<next_steps>', '1. Draft', '```', '', 'B'].join('\n');
    const out = stripNextStepsBlock(text);
    expect(out).toContain('<next_steps>');
    expect(out).toContain('1. Draft');
  });
});
describe('tool-encoded prompt text', () => {
  it.each(['not-json', '{}', '42', 'null', '"   "'])(
    'rejects malformed or non-prompt encoded data (%s)',
    (value) => {
      const text = `<nextsteps>\n1. <!--ws:nextstep-json-->${value} auto="true"\n</nextsteps>`;
      expect(parseNextSteps(text).steps).toEqual([]);
      expect(parseNextSteps(text, false).steps).toEqual([]);
    },
  );

  it('does not reinterpret entity or JSON-looking text in ordinary model prompts', () => {
    const text = 'Search for "&amp;" and "\\n" in the parser.';
    expect(parseNextSteps(`<nextsteps>\n1. ${text}\n</nextsteps>`).texts).toEqual([text]);
  });
});

describe('nextsteps candidate boundaries', () => {
  it.each([
    '<nextsteps>\n</nextsteps>',
    '<nextsteps>\nThis is not a prompt list.\n</nextsteps>',
    '<nextsteps>\n1. Unfinished old suggestion auto="true"',
    '<nextsteps/>\n1. Not a real block',
    '<nextsteps>\n1. <!--ws:nextstep-json-->null\n</nextsteps>',
  ])('finds a valid block after a malformed candidate (%j)', (prefix) => {
    const valid = '<nextsteps>\n1. Inspect the current parser\n</nextsteps>';
    const parsed = parseNextSteps(`${prefix}\n\n${valid}`);
    expect(parsed.texts).toEqual(['Inspect the current parser']);
    expect(parsed.autoTexts).toEqual([]);
    expect(parsed.stripped).toBe(prefix);
  });

  it('does not promote fenced numbered examples in raw suggestion mode', () => {
    const text = '```text\n1. Example only auto="true"\n```\n1. Inspect the current parser';
    const parsed = parseNextSteps(text, false);
    expect(parsed.texts).toEqual(['Inspect the current parser']);
    expect(parsed.autoTexts).toEqual([]);
  });
});

describe('parseNextSteps (<nextstep> item elements)', () => {
  it('parses one <nextstep> element per line and strips the block', () => {
    const text = [
      'Done.',
      '',
      '<nextsteps>',
      '<nextstep>Run the full test suite</nextstep>',
      '<nextstep>Commit the parser fix</nextstep>',
      '</nextsteps>',
    ].join('\n');
    const parsed = parseNextSteps(text);
    expect(parsed.steps).toEqual([
      { index: 1, text: 'Run the full test suite' },
      { index: 2, text: 'Commit the parser fix' },
    ]);
    expect(parsed.stripped).toBe('Done.');
  });

  it('parses elements written inline, multi-line, or with a list marker', () => {
    const text =
      'Ok.\n<nextsteps><nextstep>1. Run lint</nextstep><nextstep>\n  Fix the\n  failing test\n</nextstep></nextsteps>';
    const parsed = parseNextSteps(text);
    expect(parsed.texts).toEqual(['Run lint', 'Fix the failing test']);
    expect(parsed.stripped).toBe('Ok.');
  });

  it('honours auto="true" only on the first element', () => {
    const text = [
      '<nextsteps>',
      '<nextstep auto="true">Run the tests</nextstep>',
      '<nextstep auto="true">Push</nextstep>',
      '</nextsteps>',
    ].join('\n');
    const parsed = parseNextSteps(text);
    expect(parsed.steps).toEqual([
      { index: 1, text: 'Run the tests', auto: true },
      { index: 2, text: 'Push' },
    ]);
    expect(parsed.autoTexts).toEqual(['Run the tests']);
  });

  it('keeps a fenced <nextstep> example out of the suggestions', () => {
    const text = [
      '```xml',
      '<nextsteps>',
      '<nextstep>Example only</nextstep>',
      '</nextsteps>',
      '```',
    ].join('\n');
    expect(parseNextSteps(text).steps).toEqual([]);
  });
});
