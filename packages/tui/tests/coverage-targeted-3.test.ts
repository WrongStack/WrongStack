/**
 * Third batch of targeted tests for TUI coverage.
 * Covers: markdown.tsx (parseInline cache, edge cases), additional edge coverage.
 */

import { describe, expect, it } from 'vitest';
import { parseInline } from '../src/markdown.js';

// ────────────────────────────────────────────────────────────────────────────
// markdown.tsx — parseInline edge cases + LRU cache
// ────────────────────────────────────────────────────────────────────────────

describe('markdown.tsx — parseInline edge cases', () => {
  it('handles unterminated backtick marker (emitted literally)', () => {
    const t = parseInline('hello `world');
    expect(t).toEqual([{ text: 'hello `world' }]);
  });

  it('handles unterminated **bold marker', () => {
    const t = parseInline('hello **world');
    expect(t).toEqual([{ text: 'hello **world' }]);
  });

  it('handles backtick at end of string with no close', () => {
    const t = parseInline('code: `');
    const joined = t.map((tok) => tok.text).join('');
    expect(joined).toBe('code: `');
  });

  it('handles double-asterisk at very end (no close)', () => {
    const t = parseInline('bold **');
    const joined = t.map((tok) => tok.text).join('');
    expect(joined).toBe('bold **');
  });

  it('handles single asterisk at end (no close)', () => {
    const t = parseInline('italic *');
    const joined = t.map((tok) => tok.text).join('');
    expect(joined).toBe('italic *');
  });

  it('handles mixed valid and unterminated markers', () => {
    const t = parseInline('**bold** and *italic and `code');
    expect(t[0]).toEqual({ text: 'bold', bold: true });
    const joined = t.map((tok) => tok.text).join('');
    expect(joined).toBe('bold and *italic and `code');
  });

  it('handles empty input string', () => {
    expect(parseInline('')).toEqual([]);
  });

  it('handles LRU cache eviction gracefully', () => {
    // Fill cache past the 5000 entry limit to trigger eviction
    for (let i = 0; i < 5100; i++) {
      parseInline(`unique-line-${i}-with-some-**bold**-and-*italic*-and-\`code\``);
    }
    // Should still parse correctly after eviction
    const t = parseInline('final **test**');
    expect(t).toEqual([{ text: 'final ' }, { text: 'test', bold: true }]);
  });

  it('handles strikethrough at end without close', () => {
    const t = parseInline('strike ~~');
    const joined = t.map((tok) => tok.text).join('');
    expect(joined).toBe('strike ~~');
  });

  it('handles strikethrough with valid markers', () => {
    const t = parseInline('~~done~~');
    expect(t).toEqual([{ text: 'done', strike: true }]);
  });

  it('handles consecutive plain and bold text with flush', () => {
    const t = parseInline('hi **bold** there');
    expect(t).toHaveLength(3);
    expect(t[0]).toEqual({ text: 'hi ' });
    expect(t[1]).toEqual({ text: 'bold', bold: true });
    expect(t[2]).toEqual({ text: ' there' });
  });

  it('handles text starting immediately with a marker', () => {
    const t = parseInline('**bold start** plus');
    expect(t).toHaveLength(2);
    expect(t[0]).toEqual({ text: 'bold start', bold: true });
    expect(t[1]).toEqual({ text: ' plus' });
  });

  it('handles only plain text', () => {
    expect(parseInline('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('flushes trailing plain text correctly', () => {
    const t = parseInline('a **b** c');
    expect(t[t.length - 1]).toEqual({ text: ' c' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// input-tokens.ts — edge coverage via dynamic import
// ────────────────────────────────────────────────────────────────────────────

describe('input-tokens.ts — direct import edge cases', () => {
  it('tokenSpanAt includes endpoint (cursor at exact end IS inside chip)', async () => {
    const { tokenSpanAt } = await import('../src/input-tokens.js');
    // clamped === end → returns chip (because clamped <= end)
    const result = tokenSpanAt('hello [pasted #1]', 'hello [pasted #1]'.length);
    expect(result).toEqual({ start: 6, end: 17 });
  });

  it('tokenLengthForward returns 0 for empty buffer', async () => {
    const { tokenLengthForward } = await import('../src/input-tokens.js');
    expect(tokenLengthForward('', 0)).toBe(0);
  });

  it('deleteTokenBackward returns null for empty buffer', async () => {
    const { deleteTokenBackward } = await import('../src/input-tokens.js');
    expect(deleteTokenBackward('', 0)).toBeNull();
  });

  it('deleteTokenBackward handles cursor inside but not at end of chip', async () => {
    const { deleteTokenBackward } = await import('../src/input-tokens.js');
    const buffer = '[pasted #1, 5 lines]';
    expect(deleteTokenBackward(buffer, buffer.length - 1)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// heap-watchdog.ts — onWarn callback paths
// ────────────────────────────────────────────────────────────────────────────

describe('heap-watchdog.ts — warning paths', () => {
  it('startHeapWatchdog triggers immediate first tick with warn threshold', async () => {
    const { startHeapWatchdog } = await import('../src/heap-watchdog.js');
    let warned = false;
    const stop = startHeapWatchdog({
      sampleEveryMs: 100000,
      logEveryMs: 100000,
      warnAt: 0, // 0% — immediate warn on first sample
      onWarn: (level) => {
        warned = true;
        expect(level).toBe('warn');
      },
    });
    expect(warned).toBe(true);
    stop();
  });

  it('startHeapWatchdog uses collectStats returning values', async () => {
    const { startHeapWatchdog } = await import('../src/heap-watchdog.js');
    const stop = startHeapWatchdog({
      sampleEveryMs: 100000,
      logEveryMs: 1, // immediate log
      collectStats: () => ({ entries: 42 }),
      onWarn: () => {},
    });
    stop();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// paste-accumulator.ts — additional edge cases
// ────────────────────────────────────────────────────────────────────────────

describe('paste-accumulator.ts — additional', () => {
  it('feedPaste handles a full paste cycle with ANSI in content', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const result = feedPaste(null, '\x1b[200~pasted\x1b[1m content\x1b[0m\x1b[201~');
    expect(result).toEqual({ accum: null, complete: 'pasted content' });
  });

  it('feedPaste accumulates content after begin marker', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const afterBegin = feedPaste(null, '\x1b[200~');
    expect(afterBegin?.accum).toBe('');

    const partial = feedPaste('', 'hello');
    expect(partial?.accum).toBe('hello');
    expect(partial?.complete).toBeNull();
  });

  it('feedPaste returns null for normal input without BEGIN', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const result = feedPaste(null, 'normal typing');
    expect(result).toBeNull();
  });

  it('feedPaste strips paste markers from input with both begin and end', async () => {
    const { feedPaste } = await import('../src/paste-accumulator.js');
    const result = feedPaste(null, '\x1b[200~content\x1b[201~');
    expect(result).toEqual({ accum: null, complete: 'content' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// terminal-title.ts — event wiring
// ────────────────────────────────────────────────────────────────────────────

describe('terminal-title.ts — event wiring', () => {
  it('wires and unwires event listeners', async () => {
    const { startTerminalTitle } = await import('../src/terminal-title.js');
    const writes: string[] = [];
    const { stop } = startTerminalTitle({
      stdout: {
        isTTY: true,
        write: (s: string) => {
          writes.push(s);
        },
      } as never,
      events: {
        on: () => () => {},
      } as never,
      model: 'test-model',
      appName: 'TestApp',
      intervalMs: 50000,
      idleAfterMs: 50000,
    });
    expect(typeof stop).toBe('function');
    stop();
  });
});
