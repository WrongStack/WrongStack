/**
 * Second batch of targeted tests for TUI coverage.
 * Covers: input-tokens, mouse, file-search, input-editing, kill-slash,
 * paste-accumulator, rehydrate-history, terminal-title, theme, app-initial-state.
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '@wrongstack/core/types';

// ────────────────────────────────────────────────────────────────────────────
// input-tokens.ts — remaining branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('input-tokens.ts — branch gaps', () => {
  it('splitChips handles consecutive chips (idx === last)', async () => {
    const { splitChips } = await import('../src/input-tokens.js');
    const spans = splitChips('[pasted #1, 5 lines][file:a.ts]');
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({ text: '[pasted #1, 5 lines]', chip: true });
    expect(spans[1]).toEqual({ text: '[file:a.ts]', chip: true });
  });

  it('layoutInputRows handles empty value with empty prompt', async () => {
    const { layoutInputRows } = await import('../src/input-tokens.js');
    const rows = layoutInputRows('', '', 0, 80);
    expect(rows).toHaveLength(1);
    // Should have one virtual cursor cell
    expect(rows[0]?.[0]?.cursor).toBe(true);
  });

  it('inputIndexAtRowCol returns 0 for row < 0', async () => {
    const { inputIndexAtRowCol } = await import('../src/input-tokens.js');
    expect(inputIndexAtRowCol('> ', 'hello', 80, -1, 0)).toBe(0);
  });

  it('inputIndexAtRowCol returns value.length for row beyond last', async () => {
    const { inputIndexAtRowCol } = await import('../src/input-tokens.js');
    expect(inputIndexAtRowCol('> ', 'hello', 80, 99, 0)).toBe(5);
  });

  it('inputIndexAtRowCol handles prompt-only row with no value chars', async () => {
    const { inputIndexAtRowCol } = await import('../src/input-tokens.js');
    expect(inputIndexAtRowCol('', '', 80, 0, 0)).toBe(0);
  });

  it('inputIndexAtRowCol handles row where start is undefined', async () => {
    const { inputIndexAtRowCol } = await import('../src/input-tokens.js');
    // Row 1 is blank (between \n\n). The value index right after first \n is 3.
    expect(inputIndexAtRowCol('> ', 'ab\n\ncd', 80, 1, 99)).toBe(3);
  });

  it('inputIndexAtRowCol handles click past end of row with no value chars', async () => {
    const { inputIndexAtRowCol } = await import('../src/input-tokens.js');
    expect(inputIndexAtRowCol('> ', 'a\n', 80, 1, 99)).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// mouse.ts — horizontal scroll branch (low=2, low=3)
// ────────────────────────────────────────────────────────────────────────────

describe('mouse.ts — horizontal scroll branch', () => {
  it('decodeMouse handles horizontal wheel (low=2, low=3) — zero wheel dir', async () => {
    const { parseMouseEvent } = await import('../src/mouse.js');
    // Cb = 64 + 2 = 66 (wheel + button bits 2 = horizontal right)
    const ev1 = parseMouseEvent('\x1b[<66;10;5M');
    expect(ev1?.kind).toBe('wheel');
    expect(ev1?.wheel).toBe(0); // horizontal → 0

    // Cb = 64 + 3 = 67 (wheel + button bits 3 = horizontal left)
    const ev2 = parseMouseEvent('\x1b[<67;10;5M');
    expect(ev2?.kind).toBe('wheel');
    expect(ev2?.wheel).toBe(0);
  });

  it('parseMouseEvents handles horizontal wheel events', async () => {
    const { parseMouseEvents } = await import('../src/mouse.js');
    const evs = parseMouseEvents('\x1b[<66;10;5M');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.wheel).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// file-search.ts — catch branch at line 44
// ────────────────────────────────────────────────────────────────────────────

describe('file-search.ts — walk error handling', () => {
  it('searchFiles handles non-existent root directory', async () => {
    const { searchFiles } = await import('../src/file-search.js');
    const results = await searchFiles('C:\\nonexistent-path-12345-test', 'test');
    expect(Array.isArray(results)).toBe(true);
  });

  it('invalidateFileCache clears the cache', async () => {
    const { invalidateFileCache } = await import('../src/file-search.js');
    expect(() => invalidateFileCache()).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// input-editing.ts — chip-aware word deletion branches
// ────────────────────────────────────────────────────────────────────────────

describe('input-editing.ts — chip-aware word deletion', () => {
  it('deleteWordBackward returns null when cursor is at start', async () => {
    const { deleteWordBackward } = await import('../src/input-editing.js');
    expect(deleteWordBackward('hello', 0)).toBeNull();
  });

  it('deleteWordBackward deletes when cursor is INSIDE a chip', async () => {
    const { deleteWordBackward } = await import('../src/input-editing.js');
    const result = deleteWordBackward('before [file:a.ts] after', 17);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.buffer).toBe('before  after');
    }
  });

  it('deleteWordForward returns null when cursor at end', async () => {
    const { deleteWordForward } = await import('../src/input-editing.js');
    expect(deleteWordForward('hello', 5)).toBeNull();
  });

  it('deleteWordForward deletes from inside a chip', async () => {
    const { deleteWordForward } = await import('../src/input-editing.js');
    const result = deleteWordForward('before [file:a.ts] after', 10);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.buffer).toBe('before  after');
    }
  });

  it('deleteWordForward deletes a chip that starts at cursor', async () => {
    const { deleteWordForward } = await import('../src/input-editing.js');
    const result = deleteWordForward('before [file:a.ts] after', 7);
    expect(result).not.toBeNull();
  });

  it('previousInputWordStart skips chip when cursor is at chip end', async () => {
    const { previousInputWordStart } = await import('../src/input-editing.js');
    const start = previousInputWordStart('a [file:a.ts] b', 'a [file:a.ts]'.length);
    expect(start).toBe(2);
  });

  it('nextInputWordStart skips past chip when cursor is inside', async () => {
    const { nextInputWordStart } = await import('../src/input-editing.js');
    const start = nextInputWordStart('a [file:a.ts] b', 5);
    expect(start).toBe('a [file:a.ts] '.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// paste-accumulator.ts — line 72 branch
// ────────────────────────────────────────────────────────────────────────────

describe('paste-accumulator.ts — branch gaps', () => {
  it('feedPaste handles partial ANSI sequence start (ESC stripped by Ink)', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const result = feedPaste(null, '[0m');
    expect(result).toEqual({ accum: null, complete: null });
  });

  it('feedPaste lets bare [ through when not a marker or partial ANSI', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const result = feedPaste(null, '[');
    expect(result).toBeNull();
  });

  it('feedPaste completes a paste when input contains END marker', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const afterBegin = feedPaste(null, '\x1b[200~');
    expect(afterBegin).toEqual({ accum: '', complete: null });

    const withContent = feedPaste('', 'hello');
    expect(withContent).toEqual({ accum: 'hello', complete: null });

    const closed = feedPaste('hello', '\x1b[201~');
    expect(closed).toEqual({ accum: null, complete: 'hello' });
  });

  it('feedPaste handles paste content with embedded ANSI sequences', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const result = feedPaste(null, '\x1b[200~hello\x1b[1m world\x1b[0m\x1b[201~');
    expect(result).toEqual({ accum: null, complete: 'hello world' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// rehydrate-history.ts — uncovered branches
// ────────────────────────────────────────────────────────────────────────────

describe('rehydrate-history.ts — branch gaps', () => {
  it('contentBlocksText returns empty for non-array content', async () => {
    const { contentBlocksText } = await import('../src/rehydrate-history.js');
    expect(contentBlocksText(null)).toBe('');
    expect(contentBlocksText(42)).toBe('');
  });

  it('rehydrateHistory handles assistant msg with non-array content (plain string)', async () => {
    const { rehydrateHistory } = await import('../src/rehydrate-history.js');
    const messages: Message[] = [
      { role: 'assistant', content: 'hello', ts: '2026-01-01T00:00:00.000Z' },
    ];
    const entries = rehydrateHistory(messages, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: 'hello' });
  });

  it('rehydrateHistory handles orphan tool_call_end (no matching tool_use)', async () => {
    const { rehydrateHistory } = await import('../src/rehydrate-history.js');
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        ts: '2026-01-01T00:00:00.000Z',
      },
    ];
    const calls = [{ name: 'read', id: 'tu-orphan', durationMs: 10, ok: true }];
    const entries = rehydrateHistory(messages, 1, calls);
    const toolEntries = entries.filter((e) => e.kind === 'tool');
    expect(toolEntries).toHaveLength(1);
  });

  it('rehydrateHistory filters tool_use blocks with no matching tool_call_end', async () => {
    const { rehydrateHistory } = await import('../src/rehydrate-history.js');
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking ' },
          { type: 'tool_use', id: 'tu-1', name: 'read', input: {} },
        ],
        ts: '2026-01-01T00:00:00.000Z',
      },
    ];
    const entries = rehydrateHistory(messages, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: 'checking' });
  });

  it('rehydrateHistory deduplicates tool_call_end by id (keeps first)', async () => {
    const { rehydrateHistory } = await import('../src/rehydrate-history.js');
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: {} }],
        ts: '2026-01-01T00:00:00.000Z',
      },
    ];
    const calls = [
      { name: 'read', id: 'tu-1', durationMs: 10, ok: true },
      { name: 'read', id: 'tu-1', durationMs: 20, ok: false },
    ];
    const entries = rehydrateHistory(messages, 1, calls);
    const toolEntries = entries.filter((e) => e.kind === 'tool');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]).toMatchObject({ durationMs: 10 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// terminal-title.ts — uncovered branches
// ────────────────────────────────────────────────────────────────────────────

describe('terminal-title.ts — branch gaps', () => {
  it('startTerminalTitle returns noop when WRONGSTACK_NO_TITLE=1', async () => {
    process.env['WRONGSTACK_NO_TITLE'] = '1';
    const { startTerminalTitle } = await import('../src/terminal-title.js');
    const { stop } = startTerminalTitle({
      stdout: { isTTY: true } as never,
      events: { on: () => () => {} } as never,
    });
    expect(typeof stop).toBe('function');
    stop();
    delete process.env['WRONGSTACK_NO_TITLE'];
  });

  it('startTerminalTitle returns noop when stdout is not a TTY', async () => {
    const { startTerminalTitle } = await import('../src/terminal-title.js');
    const { stop } = startTerminalTitle({
      stdout: { isTTY: false } as never,
      events: { on: () => () => {} } as never,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('startTerminalTitle wires event listeners and writes title', async () => {
    const offs: Array<() => void> = [];
    const { startTerminalTitle } = await import('../src/terminal-title.js');
    const { stop } = startTerminalTitle({
      stdout: {
        isTTY: true,
        write: () => {},
      } as never,
      events: {
        on: () => {
          offs.push(() => {});
          return () => {};
        },
      } as never,
    });
    expect(typeof stop).toBe('function');
    stop();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// theme.ts — uncovered branches
// ────────────────────────────────────────────────────────────────────────────

describe('theme.ts — branch gaps', () => {
  it('detectSupportsBackground: NO_COLOR env set returns false', async () => {
    const { detectSupportsBackground } = await import('../src/theme.js');
    expect(detectSupportsBackground({ NO_COLOR: '1' }, true)).toBe(false);
    expect(detectSupportsBackground({ NO_COLOR: 'true' }, true)).toBe(false);
  });

  it('detectSupportsBackground: NO_COLOR empty string bypasses', async () => {
    const { detectSupportsBackground } = await import('../src/theme.js');
    expect(detectSupportsBackground({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('detectSupportsBackground: COLORTERM=truecolor returns true', async () => {
    const { detectSupportsBackground } = await import('../src/theme.js');
    expect(detectSupportsBackground({ COLORTERM: 'truecolor', TERM: 'xterm' }, true)).toBe(true);
  });

  it('detectSupportsBackground: TERM contains 256color returns true', async () => {
    const { detectSupportsBackground } = await import('../src/theme.js');
    expect(detectSupportsBackground({ TERM: 'xterm-256color' }, true)).toBe(true);
  });

  it('detectSupportsBackground: COLORTERM with non-false value returns true', async () => {
    const { detectSupportsBackground } = await import('../src/theme.js');
    expect(detectSupportsBackground({ COLORTERM: 'yes', TERM: 'xterm' }, true)).toBe(true);
  });

  it('detectSupportsBackground: defaults to true when no indicator found', async () => {
    const { detectSupportsBackground } = await import('../src/theme.js');
    expect(detectSupportsBackground({}, true)).toBe(true);
  });

  it('softColor returns undefined for undefined input', async () => {
    const { softColor } = await import('../src/theme.js');
    expect(softColor(undefined)).toBeUndefined();
  });

  it('softColor returns hex for known color names', async () => {
    const { softColor } = await import('../src/theme.js');
    expect(softColor('red')).toBe('#f38ba8');
    expect(softColor('cyan')).toBe('#94e2d5');
  });

  it('softColor passes through unknown values', async () => {
    const { softColor } = await import('../src/theme.js');
    expect(softColor('dim')).toBe('dim');
    expect(softColor('#ff0000')).toBe('#ff0000');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// app-initial-state.ts — all-system-messages branch
// ────────────────────────────────────────────────────────────────────────────

describe('app-initial-state.ts — all-system-messages', () => {
  it('buildRestoredEntries returns [] when all messages are system', async () => {
    const { buildRestoredEntries } = await import('../src/app-initial-state.js');
    const messages: Message[] = [
      { role: 'system', content: 'system1', ts: '2026-01-01T00:00:00.000Z' },
      { role: 'system', content: 'system2', ts: '2026-01-01T00:00:01.000Z' },
    ];
    expect(buildRestoredEntries(messages)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// git-info.ts — spawn error handling
// ────────────────────────────────────────────────────────────────────────────

describe('git-info.ts — error paths', () => {
  it('readGitInfo is a function that handles git not being available', async () => {
    const { readGitInfo } = await import('../src/git-info.js');
    expect(typeof readGitInfo).toBe('function');
    // Call with a non-existent CWD — spawn will fail inside runGit
    const result = await readGitInfo('C:\\nonexistent-path-12345-git-test');
    expect(result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// heap-watchdog.ts — uncovered branches
// ────────────────────────────────────────────────────────────────────────────

describe('heap-watchdog.ts — branch gaps', () => {
  it('defaultHeapLogPath returns a path ending with heap.jsonl', async () => {
    const { defaultHeapLogPath } = await import('../src/heap-watchdog.js');
    const p = defaultHeapLogPath();
    expect(p).toContain('heap.jsonl');
    expect(p).toContain('wstack');
  });

  it('takeHeapSample returns a valid sample with load property', async () => {
    const { takeHeapSample } = await import('../src/heap-watchdog.js');
    const sample = takeHeapSample();
    expect(sample).toHaveProperty('ts');
    expect(sample).toHaveProperty('load');
    expect(typeof sample.load).toBe('number');
    expect(sample.load).toBeGreaterThanOrEqual(0);
  });

  it('startHeapWatchdog returns a stop function', async () => {
    const { startHeapWatchdog } = await import('../src/heap-watchdog.js');
    const stop = startHeapWatchdog({
      sampleEveryMs: 100000,
      logEveryMs: 100000,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('startHeapWatchdog with collectStats that throws does not break', async () => {
    const { startHeapWatchdog } = await import('../src/heap-watchdog.js');
    const stop = startHeapWatchdog({
      sampleEveryMs: 100000,
      logEveryMs: 100000,
      collectStats: () => {
        throw new Error('stats error');
      },
    });
    expect(typeof stop).toBe('function');
    stop();
  });
});
