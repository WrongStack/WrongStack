import { describe, expect, it } from 'vitest';
import {
  appendToDraft,
  desktopCommands,
  fileMention,
  parseDesktopCommand,
  referenceKey,
  referenceLabel,
  referenceMessage,
  renderPromptTemplate,
  splitReferenceMessage,
  validReferenceLines,
  withReference,
} from '../src/composer-resources-model';

describe('desktop composer project resources', () => {
  it('appends templates without replacing an unsent draft and fills only explicit variables', () => {
    expect(appendToDraft('Keep my work.\n', 'New template')).toBe('Keep my work.\n\nNew template');
    expect(
      renderPromptTemplate('Review {{target}} with {{missing}} and {{constructor}}.', {
        target: 'src/main.ts',
      }),
    ).toBe('Review src/main.ts with {{missing}} and {{constructor}}.');
  });
  it('keeps project-file references explicit, complete-read scoped and human-readable after roundtrip', () => {
    const payload = referenceMessage(
      'Review this file.',
      [{ path: 'src/file with spaces.ts' }, { path: 'src/file with spaces.ts' }],
      '\\\\?\\D:\\Projects\\Example',
    );
    expect(payload).toContain('Project root: "D:/Projects/Example"');
    expect(payload).toContain('Continue paginated reads until EOF');
    expect(splitReferenceMessage(payload)).toEqual({
      text: 'Review this file.',
      paths: ['src/file with spaces.ts'],
      references: [{ path: 'src/file with spaces.ts' }],
    });
    expect(payload).not.toContain('Line ranges mark');
    expect(referenceMessage('Plain input', [], 'D:/Example')).toBe('Plain input');
    expect(splitReferenceMessage('[Project file references]\n- bad JSON')).toEqual({
      text: '[Project file references]\n- bad JSON',
      paths: [],
      references: [],
    });
  });
  it('keeps several ranges and quotes of one file as separate references', () => {
    const whole = { path: 'src/a.ts' };
    const range = { path: 'src/a.ts', lines: [3, 9] as [number, number] };
    const quote = { path: 'src/a.ts', lines: [5, 5] as [number, number], snippet: 'x()' };
    let refs = withReference([], whole);
    refs = withReference(refs, range);
    refs = withReference(refs, quote);
    expect(withReference(refs, { path: 'src/a.ts', lines: [3, 9] })).toEqual(refs);
    expect(refs).toHaveLength(3);
    expect(new Set(refs.map(referenceKey)).size).toBe(3);
    const payload = referenceMessage('Compare.', [...refs, range], 'D:/Example');
    const view = splitReferenceMessage(payload);
    expect(view.references).toEqual([whole, range, quote]);
    expect(view.paths).toEqual(['src/a.ts']);
  });
  it('carries optional line ranges through the message and back', () => {
    const payload = referenceMessage(
      'Fix the parser.',
      [
        { path: 'src/parse.ts', lines: [10, 24] },
        { path: 'README.md' },
        { path: 'src/one.ts', lines: [7, 7] },
      ],
      'D:/Example',
    );
    expect(payload).toContain('- "src/parse.ts" lines 10-24');
    expect(payload).toContain('Line ranges mark the relevant section');
    expect(splitReferenceMessage(payload).references).toEqual([
      { path: 'src/parse.ts', lines: [10, 24] },
      { path: 'README.md' },
      { path: 'src/one.ts', lines: [7, 7] },
    ]);
    expect(referenceLabel({ path: 'src/one.ts', lines: [7, 7] })).toBe('src/one.ts:7');
    expect(referenceLabel({ path: 'src/parse.ts', lines: [10, 24] })).toBe('src/parse.ts:10-24');
    // A reversed range in a message is not trusted as references.
    const reversed = payload.replace('lines 10-24', 'lines 24-10');
    expect(splitReferenceMessage(reversed).references).toEqual([]);
    for (const lines of [[0, 1], [5, 4], [1.5, 2], [1], [1, 10_000_001]])
      expect(validReferenceLines(lines)).toBe(false);
    expect(validReferenceLines([1, 1])).toBe(true);
  });
  it('only opens file mentions in prose at the caret and preserves surrounding paragraphs', () => {
    expect(fileMention('Read @src/fi', 12)).toEqual({ start: 5, end: 12, query: 'src/fi' });
    for (const value of [
      'mail@example.com',
      'Use `@file',
      '```ts\n@file',
      '~~~\n@file',
      'Escaped \\@file',
    ])
      expect(fileMention(value, value.length)).toBeNull();
    expect(fileMention('```\ncode\n```\n@src', 18)?.query).toBe('src');
  });
  it('routes native slash commands deliberately and leaves literal paths alone', () => {
    expect(parseDesktopCommand('/queue review the API')).toEqual({
      action: 'queue',
      argument: 'review the API',
    });
    expect(parseDesktopCommand('/abort')).toEqual({ action: 'stop', argument: '' });
    expect(parseDesktopCommand('/compact!')).toEqual({
      action: 'compact-aggressive',
      argument: '',
    });
    expect(parseDesktopCommand('/not-implemented')).toEqual({ action: 'unknown', argument: '' });
    expect(parseDesktopCommand('//help')).toBeNull();
    expect(parseDesktopCommand('/src/main.ts')).toBeNull();
    expect(new Set(desktopCommands.map((command) => command.name)).size).toBe(
      desktopCommands.length,
    );
  });
});
