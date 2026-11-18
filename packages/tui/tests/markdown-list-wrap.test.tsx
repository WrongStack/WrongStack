import { describe, expect, it } from 'vitest';
import { MarkdownView } from '../src/markdown.js';
import { renderRealTty } from './helpers/real-tty.js';

/**
 * A list marker is a hanging indent: when the item wraps, the marker keeps its
 * width and every continuation row lines up under the item's first word.
 */
describe('MarkdownView list items that wrap', () => {
  it.each([
    ['- alpha bravo charlie delta echo foxtrot golf hotel', '• ', '  '],
    ['  * alpha bravo charlie delta echo foxtrot golf hotel', '  • ', '    '],
    ['12. alpha bravo charlie delta echo foxtrot golf hotel', '12. ', '    '],
  ])('%s keeps its marker and hangs the continuation', (source, marker, indent) => {
    const view = renderRealTty(<MarkdownView text={source} termWidth={24} />, {
      columns: 24,
      rows: 10,
    });
    try {
      const lines = view.lines().filter((line) => line.trim() !== '');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]?.startsWith(`${marker}alpha`)).toBe(true);
      for (const line of lines.slice(1)) {
        expect(line.startsWith(indent)).toBe(true);
        expect(line.slice(indent.length, indent.length + 1)).not.toBe(' ');
      }
    } finally {
      view.unmount();
    }
  });
});
