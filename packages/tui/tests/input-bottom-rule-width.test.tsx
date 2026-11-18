import { describe, expect, it } from 'vitest';
import { Input } from '../src/components/input.js';
import { displayWidth } from '../src/terminal-width.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

/** The composer's bottom rule closes the frame in the last column at every width. */
describe('Input bottom rule', () => {
  it.each([24, 30, 36, 40, 44, 45, 46, 60, 80])('fills exactly %i columns', async (columns) => {
    const view = renderRealTty(<Input value="" cursor={0} onKey={() => {}} />, {
      columns,
      rows: 8,
    });
    try {
      await settle();
      const rule = view.lines().find((line) => line.startsWith('╰─'));
      expect(rule).toBeDefined();
      expect(rule?.trimEnd().endsWith('╯')).toBe(true);
      expect(displayWidth(rule!.trimEnd())).toBe(columns);
    } finally {
      view.unmount();
    }
  });
});
