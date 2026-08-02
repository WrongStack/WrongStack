import { describe, expect, it } from 'vitest';
import { SAGE_INJECTOR_HEADINGS } from '@wrongstack/core/utils';
import { formatMemoryHintsDetailed } from '../src/retrieval/format.js';
import type { Sage } from '../src/types.js';

function makeMemory(): Sage {
  return {
    id: 'heading-contract-test',
    revision: 1,
    text: 'heading contract probe',
    kind: 'fact',
    scope: 'project',
    status: 'active',
    importance: 0.5,
    confidence: 0.5,
    freshness: 0.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    anchors: [],
    sources: [],
  };
}

describe('SAGE fence heading contract (2026-08-02)', () => {
  it('the DEFAULT (turn-context) heading is recognized by every parser', () => {
    const { text } = formatMemoryHintsDetailed([makeMemory()], {});
    const header = text.split('\n')[0] ?? '';
    // The canonical parser set (core utils/sage-output-block, webui
    // lib/sage-block, TUI sage-output-format) recognizes exactly the two
    // '(Memory Injector)' headings — turn-context injection relies on this
    // default carrying the suffix.
    expect(SAGE_INJECTOR_HEADINGS.has(header)).toBe(true);
    expect(header).toBe('--- SAGE: related project knowledge (Memory Injector) ---');
  });

  it('tool-result headings remain in the canonical set', () => {
    const { text } = formatMemoryHintsDetailed([makeMemory()], {
      heading: 'SAGE: task-aware project knowledge (Memory Injector)',
    });
    expect(SAGE_INJECTOR_HEADINGS.has(text.split('\n')[0] ?? '')).toBe(true);
  });
});
