import { describe, expect, it } from 'vitest';
import type { CompletionItem, CompletionList } from 'vscode-languageserver-protocol';
import { completionCoverage } from '../../src/tools/completion.js';

const {
  collectCompletionItems,
  compact,
  completionKindName,
  documentationText,
  formatCompletionItems,
} = completionCoverage;

describe('completion formatting coverage', () => {
  it('collects array, list, and empty completion results with a limit', () => {
    const items = [{ label: 'one' }, { label: 'two' }] satisfies CompletionItem[];
    const list = { isIncomplete: false, items } satisfies CompletionList;

    expect(collectCompletionItems(items, 1)).toEqual([{ label: 'one' }]);
    expect(collectCompletionItems(list, 2)).toEqual(items);
    expect(collectCompletionItems(null, 2)).toEqual([]);
  });

  it('formats empty, fallback, documented, and truncated completion items', () => {
    expect(formatCompletionItems([], null)).toBe('No completions found.');

    const items: CompletionItem[] = [
      { label: '', insertText: 'inserted' },
      { label: '', insertText: '', kind: 3, detail: '  detail\n text  ' },
      { label: 'docs', documentation: { kind: 'markdown', value: 'documentation' } },
      { label: 'plain', documentation: 'plain docs' },
    ];

    expect(formatCompletionItems(items.slice(0, 3), items)).toBe(
      [
        '1. inserted [Completion]',
        '2. (unnamed) [Function] — detail text',
        '3. docs [Completion] — documentation',
        '... truncated 1 more',
      ].join('\n'),
    );
  });

  it('normalizes documentation and compact text variants', () => {
    expect(documentationText(undefined)).toBeUndefined();
    expect(documentationText('plain')).toBe('plain');
    expect(documentationText({ kind: 'plaintext', value: 'markup' })).toBe('markup');

    expect(compact(undefined)).toBeUndefined();
    expect(compact(' \n ')).toBeUndefined();
    expect(compact(' short\n value ')).toBe('short value');
    expect(compact('x'.repeat(161))).toBe(`${'x'.repeat(157)}...`);
  });

  it('names known and unknown completion kinds', () => {
    expect(completionKindName(1)).toBe('Text');
    expect(completionKindName(25)).toBe('TypeParameter');
    expect(completionKindName(999)).toBe('Kind 999');
  });
});
