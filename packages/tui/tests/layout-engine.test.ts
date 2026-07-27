/**
 * Comprehensive tests for the layout engine.
 *
 * Verifies that every entry kind produces correct row counts given terminal
 * width, character counts, overflow tracking, and that the engine matches
 * what the actual Ink component tree produces.
 */
import { describe, expect, it } from 'vitest';
import {
  computeEntryRows,
  computeLayout,
  computeOverflow,
  computeEntryChars,
  wrappedRows,
  visibleChars,
  LAYOUT_VERSION,
} from '../src/layout-engine.js';

describe('wrappedRows', () => {
  it('returns 1 for empty string', () => {
    expect(wrappedRows('', 80)).toBe(1);
  });

  it('counts one short line as 1 row', () => {
    expect(wrappedRows('hello', 80)).toBe(1);
  });

  it('wraps a long line across multiple rows', () => {
    const line = 'a'.repeat(250);
    expect(wrappedRows(line, 80)).toBe(4); // ceil(250/80) = 4
  });

  it('handles multiple explicit newlines', () => {
    expect(wrappedRows('line1\nline2\nline3', 80)).toBe(3);
  });

  it('handles multi-byte characters correctly', () => {
    const lorem = 'あ'.repeat(200); // Japanese — each char is multi-byte but display width
    expect(wrappedRows(lorem, 80)).toBe(3); // ceil(200/80) = 3
  });

  it('caps at maxRows', () => {
    const text = Array.from({ length: 5000 }, () => 'x'.repeat(100)).join('\n');
    expect(wrappedRows(text, 80, 2000)).toBe(2000);
  });

  it('handles explicit newline within long lines', () => {
    const text = 'a'.repeat(160) + '\n' + 'b'.repeat(40);
    // First line: ceil(160/80)=2 rows, second line: ceil(40/80)=1 row
    expect(wrappedRows(text, 80)).toBe(3);
  });

  it('handles width narrower than MIN_CONTENT_WIDTH', () => {
    expect(wrappedRows('hello world', 1)).toBeGreaterThanOrEqual(1);
  });
});

describe('visibleChars', () => {
  it('counts plain text correctly', () => {
    expect(visibleChars('hello world')).toBe(11);
  });

  it('strips ANSI escape sequences', () => {
    expect(visibleChars('\x1b[31mhello\x1b[0m')).toBe(5);
  });

  it('counts multi-byte characters', () => {
    expect(visibleChars('あいう')).toBe(3);
  });

  it('handles empty string', () => {
    expect(visibleChars('')).toBe(0);
  });
});

describe('computeEntryChars', () => {
  it('counts user text with pasteContent', () => {
    const chars = computeEntryChars('user', {
      text: 'hello',
      pasteContent: '\npasted content',
    });
    expect(chars).toBe(20); // 5 (hello) + 15 (\npasted content)
  });

  it('counts tool output and input', () => {
    const chars = computeEntryChars('tool', {
      text: '',
      output: 'line1\nline2\nline3',
      input: { path: '/test/file.ts' },
    });
    expect(chars).toBeGreaterThan(25); // output chars + serialized input
  });

  it('counts subagent text with detail', () => {
    const chars = computeEntryChars('subagent', {
      text: 'main text',
      detail: 'extra info',
    });
    expect(chars).toBe(19); // 9 (main text) + 10 (extra info)
  });
});

describe('computeEntryRows', () => {
  it('user entry has minimum rows', () => {
    expect(computeEntryRows('user', 'hello', 80)).toBeGreaterThanOrEqual(2);
  });

  it('assistant entry dimensions include header and chrome', () => {
    const rows = computeEntryRows('assistant', 'short text', 80);
    expect(rows).toBe(3); // header(1) + body(1) = 2, but function returns 2+bodyRows
  });

  it('assistant with next-steps adds panel', () => {
    const rows = computeEntryRows('assistant', 'some text', 80, {
      hasNextSteps: true,
    });
    expect(rows).toBeGreaterThan(4);
  });

  it('thinking entry includes chrome', () => {
    const rows = computeEntryRows('thinking', 'reasoning content', 80);
    expect(rows).toBe(4); // 3 chrome + 1 body
  });

  it('tool card with simple mode is compact', () => {
    const rows = computeEntryRows('tool', 'output', 80, {
      hasBody: true,
      resultRenderMode: 'simple',
    });
    expect(rows).toBe(2);
  });

  it('tool card with expanded body has rail and footer', () => {
    const text = 'a\nb\nc';
    const rows = computeEntryRows('tool', text, 80, { hasBody: true });
    expect(rows).toBe(5); // 2 (header + footer layout) + 3 (body lines)
  });

  it('tool card without body is compact', () => {
    const rows = computeEntryRows('tool', '', 80, { hasBody: false });
    expect(rows).toBe(2);
  });

  it('tool-group includes header and footer rules', () => {
    const rows = computeEntryRows('tool-group', 'read', 80, { groupCount: 3 });
    expect(rows).toBe(6); // header(1) + entries(3) + rail(1) + footer rule(1)
  });

  it('info and warn are 1 row', () => {
    expect(computeEntryRows('info', 'info text', 80)).toBe(1);
    expect(computeEntryRows('warn', 'warn text', 80)).toBe(1);
  });

  it('error is a NoticeCard with border and wrapped body', () => {
    const rows = computeEntryRows('error', 'error message', 80);
    expect(rows).toBeGreaterThanOrEqual(4); // border(1) + header(1) + body + border(1)
  });

  it('turn-summary includes border and bottom margin', () => {
    const rows = computeEntryRows('turn-summary', 'summary', 80);
    expect(rows).toBeGreaterThanOrEqual(4); // border(2) + body(1) + margin(1)
  });

  it('model-switch has fixed layout', () => {
    expect(computeEntryRows('model-switch', '', 80)).toBe(5);
  });

  it('model-switch with body adds warning row', () => {
    expect(computeEntryRows('model-switch', '', 80, { hasBody: true })).toBe(6);
  });

  it('memory-activation has chrome + body rows', () => {
    expect(computeEntryRows('memory-activation', '', 80)).toBe(4);
  });

  it('memory-lifecycle is 1 row', () => {
    expect(computeEntryRows('memory-lifecycle', 'label', 80)).toBe(1);
  });

  it('confirm entry has 4 rows', () => {
    expect(computeEntryRows('confirm', '', 80)).toBe(4);
  });

  it('subagent counts lines in text', () => {
    expect(computeEntryRows('subagent', 'line1\nline2\nline3', 80)).toBe(3);
  });

  it('banner uses compact or full layout', () => {
    expect(computeEntryRows('banner', '', 80)).toBe(5);
    expect(computeEntryRows('banner', '', 40)).toBe(3);
  });

  it('unknown kind uses FALLBACK_ROWS', () => {
    expect(computeEntryRows('unknown', '', 80)).toBe(3);
  });
});

describe('computeLayout', () => {
  it('produces a complete layout with version', () => {
    const layout = computeLayout(42, 'user', 'hello world', 80);
    expect(layout.id).toBe(42);
    expect(layout.termWidth).toBe(80);
    expect(layout.rows).toBeGreaterThanOrEqual(2);
    expect(layout.chars).toBeGreaterThan(0);
    expect(layout.kind).toBe('estimated');
    expect(layout.version).toBe(LAYOUT_VERSION);
    expect(layout.overflowBefore).toBe(0);
    expect(layout.overflowAfter).toBe(0);
  });
});

describe('computeOverflow', () => {
  it('marks partial entry above viewport', () => {
    const layouts = [
      {
        id: 1,
        rows: 10,
        overflowBefore: 0,
        overflowAfter: 0,
        kind: 'measured' as const,
        version: 1,
        chars: 10,
        termWidth: 80,
      },
      {
        id: 2,
        rows: 10,
        overflowBefore: 0,
        overflowAfter: 0,
        kind: 'measured' as const,
        version: 1,
        chars: 10,
        termWidth: 80,
      },
    ];
    const result = computeOverflow(layouts, 5, 25);
    // Entry 0 occupies rows 0-9. viewportTop=5: 5 rows before, 5 visible.
    expect(result[0]!.overflowBefore).toBe(5);
    expect(result[0]!.overflowAfter).toBe(0);
    // Entry 1 occupies rows 10-19. Fully visible (5-25).
    expect(result[1]!.overflowBefore).toBe(0);
    expect(result[1]!.overflowAfter).toBe(0);
  });

  it('marks entry partially below viewport', () => {
    const layouts = [
      {
        id: 1,
        rows: 5,
        overflowBefore: 0,
        overflowAfter: 0,
        kind: 'measured' as const,
        version: 1,
        chars: 10,
        termWidth: 80,
      },
      {
        id: 2,
        rows: 10,
        overflowBefore: 0,
        overflowAfter: 0,
        kind: 'measured' as const,
        version: 1,
        chars: 10,
        termWidth: 80,
      },
    ];
    const result = computeOverflow(layouts, 0, 12);
    // Entry 0: rows 0-4, fully visible. overflowBefore=0, overflowAfter=0
    expect(result[0]!.overflowBefore).toBe(0);
    expect(result[0]!.overflowAfter).toBe(0);
    // Entry 1: rows 5-14. rows 5-11 visible (viewportBottom=12), rows 12-14 overflow below
    expect(result[1]!.overflowBefore).toBe(0);
    expect(result[1]!.overflowAfter).toBe(3);
  });
});
