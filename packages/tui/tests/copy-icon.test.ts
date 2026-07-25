import { describe, expect, it } from 'vitest';
import {
  COPY_ICON,
  COPY_ICON_WIDTH,
  copyableTextForEntry,
  isCopyableEntry,
} from '../src/components/history/copy-icon.js';
import type { HistoryEntry } from '../src/history-entry.js';

describe('copyableTextForEntry', () => {
  it('returns the text for an assistant card', () => {
    const entry: HistoryEntry = { id: 1, kind: 'assistant', text: 'hello world' };
    expect(copyableTextForEntry(entry)).toBe('hello world');
    expect(isCopyableEntry(entry)).toBe(true);
  });

  it('returns the text for a thinking card', () => {
    const entry: HistoryEntry = { id: 2, kind: 'thinking', text: 'pondering' };
    expect(copyableTextForEntry(entry)).toBe('pondering');
  });

  it('returns the visible text for a plain user card', () => {
    const entry: HistoryEntry = { id: 3, kind: 'user', text: 'run the tests' };
    expect(copyableTextForEntry(entry)).toBe('run the tests');
  });

  it('prefers the full paste content over the collapsed visible text', () => {
    const entry: HistoryEntry = {
      id: 4,
      kind: 'user',
      text: '[pasted 4 lines]',
      pasteContent: 'line1\nline2\nline3\nline4',
    };
    expect(copyableTextForEntry(entry)).toBe('line1\nline2\nline3\nline4');
  });

  it('falls back to visible text when paste content is empty', () => {
    const entry: HistoryEntry = { id: 5, kind: 'user', text: 'visible', pasteContent: '' };
    expect(copyableTextForEntry(entry)).toBe('visible');
  });

  it('returns null for empty text', () => {
    const entry: HistoryEntry = { id: 6, kind: 'assistant', text: '' };
    expect(copyableTextForEntry(entry)).toBeNull();
    expect(isCopyableEntry(entry)).toBe(false);
  });

  it('returns null for non-conversational cards', () => {
    const info: HistoryEntry = { id: 7, kind: 'info', text: 'some status' };
    const warn: HistoryEntry = { id: 8, kind: 'warn', text: 'careful' };
    const tool: HistoryEntry = {
      id: 9,
      kind: 'tool',
      name: 'read',
      durationMs: 5,
      ok: true,
      output: 'file contents',
    };
    expect(copyableTextForEntry(info)).toBeNull();
    expect(copyableTextForEntry(warn)).toBeNull();
    expect(copyableTextForEntry(tool)).toBeNull();
    expect(isCopyableEntry(tool)).toBe(false);
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
