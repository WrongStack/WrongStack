import { DEFAULT_MIN_IMPORTANCE, DEFAULT_MIN_SCORE, MIN_RELATION_STRENGTH } from '@wrongstack/sage';
import { describe, expect, it } from 'vitest';
import {
  COPY_ICON,
  COPY_ICON_WIDTH,
  copyableTextForEntries,
  copyableTextForEntry,
  isCopyableEntry,
} from '../src/components/history/copy-icon.js';
import type { HistoryEntry } from '../src/history-entry.js';

const ALL_ENTRY_KINDS = [
  { id: 1, kind: 'user', text: 'user prompt' },
  { id: 2, kind: 'assistant', text: 'assistant markdown' },
  { id: 3, kind: 'thinking', text: 'model reasoning' },
  { id: 4, kind: 'tool', name: 'read', durationMs: 5, ok: true, output: 'file contents' },
  { id: 5, kind: 'info', text: 'information' },
  { id: 6, kind: 'warn', text: 'warning' },
  { id: 7, kind: 'error', text: 'failure' },
  { id: 8, kind: 'turn-summary', text: 'turn stats' },
  { id: 9, kind: 'model-switch', toProvider: 'openai', toModel: 'gpt-test' },
  {
    id: 10,
    kind: 'memory-activation',
    trigger: 'read',
    outcome: 'injected',
    candidates: 1,
    contextPressure: 0.5,
    injectedChars: 12,
    activated: [],
    injectedIds: [],
    queryPreview: 'read',
    thresholds: {
      minScore: DEFAULT_MIN_SCORE,
      minImportance: DEFAULT_MIN_IMPORTANCE,
      relationFloor: MIN_RELATION_STRENGTH,
    },
    rejected: { duplicate: 0, belowScore: 0, alreadyVisible: 0, cooldown: 0, budget: 0 },
  },
  { id: 11, kind: 'memory-lifecycle', action: 'entered', label: 'memory-1', detail: 'why' },
  {
    id: 12,
    kind: 'brain',
    status: 'answered',
    source: 'policy',
    risk: 'low',
    question: 'Proceed?',
    decision: 'Proceed',
    rationale: 'Safe',
    outcome: 'Done',
  },
  { id: 13, kind: 'banner', version: '1.0.0', provider: 'test', model: 'model', cwd: '/' },
  {
    id: 14,
    kind: 'confirm',
    toolName: 'bash',
    input: { command: 'echo hi' },
    suggestedPattern: 'echo *',
  },
  {
    id: 15,
    kind: 'subagent',
    agentLabel: 'REVIEWER',
    agentColor: 'cyan',
    icon: 'R',
    text: 'review complete',
    detail: 'clean',
  },
] satisfies HistoryEntry[];

describe('copyableTextForEntry', () => {
  it('supports every retained history entry kind', () => {
    expect(ALL_ENTRY_KINDS.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'thinking',
      'tool',
      'info',
      'warn',
      'error',
      'turn-summary',
      'model-switch',
      'memory-activation',
      'memory-lifecycle',
      'brain',
      'banner',
      'confirm',
      'subagent',
    ]);
    for (const entry of ALL_ENTRY_KINDS) {
      expect(copyableTextForEntry(entry).length, entry.kind).toBeGreaterThan(0);
      expect(isCopyableEntry(entry), entry.kind).toBe(true);
    }
  });

  it('preserves raw markdown, code, tables, ANSI, and tool output byte-for-byte', () => {
    const assistant: HistoryEntry = {
      id: 20,
      kind: 'assistant',
      text: '| A | B |\n| - | - |\n| 1 | 2 |\n```ts\nconst x = 1;\n```',
    };
    const info: HistoryEntry = { id: 21, kind: 'info', text: '\u001b[31mred\u001b[0m' };
    const tool: HistoryEntry = {
      id: 22,
      kind: 'tool',
      name: 'read',
      durationMs: 5,
      ok: true,
      input: { path: 'a.ts' },
      output: '1| const x = 1;\n2| export { x };',
    };

    expect(copyableTextForEntry(assistant)).toBe(assistant.text);
    expect(copyableTextForEntry(info)).toBe(info.text);
    expect(copyableTextForEntry(tool)).toBe(tool.output);
  });

  it('prefers full paste content and falls back to visible user text', () => {
    const pasted: HistoryEntry = {
      id: 30,
      kind: 'user',
      text: '[pasted 4 lines]',
      pasteContent: 'line1\nline2\nline3\nline4',
    };
    const plain: HistoryEntry = { id: 31, kind: 'user', text: 'run the tests', pasteContent: '' };

    expect(copyableTextForEntry(pasted)).toBe(pasted.pasteContent);
    expect(copyableTextForEntry(plain)).toBe(plain.text);
  });

  it('uses readable text for structured cards that have a natural body', () => {
    expect(copyableTextForEntry(ALL_ENTRY_KINDS[10]!)).toBe('memory-1\nwhy');
    expect(copyableTextForEntry(ALL_ENTRY_KINDS[11]!)).toBe('Proceed?\n\nProceed\n\nSafe\n\nDone');
    expect(copyableTextForEntry(ALL_ENTRY_KINDS[14]!)).toBe('review complete\nclean');
  });

  it('uses parseable raw JSON for cards without a natural text body', () => {
    for (const index of [8, 9, 12, 13]) {
      const entry = ALL_ENTRY_KINDS[index]!;
      expect(JSON.parse(copyableTextForEntry(entry))).toEqual(entry);
    }
  });

  it('falls back to raw JSON for empty text and safely handles cyclic or bigint tool input', () => {
    const empty: HistoryEntry = { id: 40, kind: 'assistant', text: '' };
    expect(JSON.parse(copyableTextForEntry(empty))).toEqual(empty);

    const input: Record<string, unknown> = { count: 42n };
    input['self'] = input;
    const tool: HistoryEntry = {
      id: 41,
      kind: 'tool',
      name: 'custom',
      durationMs: 0,
      ok: true,
      input,
    };
    const copied = JSON.parse(copyableTextForEntry(tool)) as { input: Record<string, unknown> };
    expect(copied.input['count']).toBe('42');
    expect(copied.input['self']).toBe('[Circular]');
  });

  it('serializes compact tool groups as one ordered raw payload', () => {
    const entries = ALL_ENTRY_KINDS.filter((entry) => entry.kind === 'tool');
    const second: HistoryEntry = {
      id: 42,
      kind: 'tool',
      name: 'read',
      durationMs: 3,
      ok: false,
      output: 'missing',
    };
    expect(JSON.parse(copyableTextForEntries([...entries, second]))).toEqual([...entries, second]);
  });
});

describe('COPY_ICON', () => {
  it('is a single-cell glyph', () => {
    // The hit test assumes the icon occupies exactly COPY_ICON_WIDTH cells; a
    // multi-codepoint or surrogate-pair glyph would break the column math.
    expect(COPY_ICON_WIDTH).toBe(1);
    expect([...COPY_ICON]).toHaveLength(1);
    expect(COPY_ICON.length).toBe(1); // BMP: no surrogate pair
  });
});
