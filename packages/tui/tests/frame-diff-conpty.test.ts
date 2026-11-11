import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildStyledFrames, VtScreen } from './helpers/vt-screen.js';

/**
 * The frame differ against a real Windows pseudo console.
 *
 * frame-diff-stdout.test.tsx proves "diffed writes == whole-frame writes" on a
 * VT model, which is only as good as the model. Here the same frames go
 * through ConPTY: conhost interprets the bytes into its own screen buffer and
 * reports what it holds. If conhost read the row-addressed updates any
 * differently from a whole repaint (a scroll on the bottom-right cell, an
 * erase that reaches too far, a lost attribute), the two screens differ.
 */
const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'helpers', 'frame-diff-pty-child.ts');
const COLUMNS = 60;
const ROWS = 12;
const FRAMES = 120;

async function screenFromPty(mode: 'whole' | 'diff', seed: number): Promise<VtScreen> {
  const pty = await import('node-pty');
  const terminal = pty.spawn(process.execPath, [child, mode, String(seed), String(FRAMES)], {
    name: 'xterm-256color',
    cols: COLUMNS,
    rows: ROWS,
    cwd: here,
    env: process.env as Record<string, string>,
  });
  let output = '';
  terminal.onData((data) => {
    output += data;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error(`pty child (${mode}, seed ${seed}) did not exit`));
    }, 30_000);
    terminal.onExit((event) => {
      clearTimeout(timer);
      resolve(event.exitCode);
    });
  });
  expect(
    exitCode,
    `pty child (${mode}, seed ${seed}) output: ${JSON.stringify(output.slice(-300))}`,
  ).toBe(0);
  const screen = new VtScreen(COLUMNS, ROWS);
  screen.feed(output);
  return screen;
}

describe.skipIf(process.platform !== 'win32')('frame differ through Windows ConPTY', () => {
  it.each([3, 11, 2026])(
    'leaves conhost holding the same screen as whole-frame writes (seed %i)',
    async (seed) => {
      const whole = await screenFromPty('whole', seed);
      const diffed = await screenFromPty('diff', seed);

      // The console really rendered the final frame, not an empty buffer.
      const expected = new VtScreen(COLUMNS, ROWS);
      const last = buildStyledFrames(seed, COLUMNS, ROWS, FRAMES).at(-1) as string[];
      expected.feed(`\x1b[1;1H\x1b[J${last.join('\n')}`);
      expect(whole.text()).toEqual(expected.text());

      expect(diffed.text()).toEqual(whole.text());
      expect(diffed.snapshot()).toBe(whole.snapshot());
    },
    90_000,
  );
});
