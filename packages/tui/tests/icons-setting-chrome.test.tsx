/**
 * The `icons` setting on the real chrome: the status bar and the input box.
 *
 * Glyph tables are fixed when `ui-glyphs.ts` is first imported, so each mode
 * re-imports the components under its own `WSTACK_ICONS` value.
 */

import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatusBarProps } from '../src/components/status-bar.js';

/** Private use: BMP area plus supplementary planes 15 and 16. */
const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

const STATUS_PROPS = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  effort: 'high',
  version: '1.7.7',
  state: 'idle',
  mode: 'detailed',
  yolo: true,
  queueCount: 2,
  todos: { pending: 2, inProgress: 1, completed: 3 },
  plan: { open: 1, inProgress: 1, done: 1 },
} as unknown as StatusBarProps;

interface ChromeFrames {
  statusBar: string;
  inputBox: string;
  permissionPrompt: string;
  /** Every byte written to the fake terminals, ANSI included. */
  raw: string;
}

async function renderChrome(env: Record<string, string | undefined>): Promise<ChromeFrames> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const React = await import('react');
  const { StatusBar } = await import('../src/components/status-bar.js');
  const { Input } = await import('../src/components/input.js');
  const { ConfirmPrompt } = await import('../src/components/confirm-prompt.js');
  const { renderRealTty, settle } = await import('./helpers/real-tty.js');

  const bar = renderRealTty(React.createElement(StatusBar, STATUS_PROPS), { columns: 140 });
  const input = renderRealTty(
    React.createElement(Input, {
      value: 'hello',
      cursor: 5,
      onKey: () => {},
    }) as React.ReactElement,
    { columns: 80 },
  );
  const prompt = renderRealTty(
    React.createElement(ConfirmPrompt, {
      toolName: 'edit',
      input: { path: 'src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      suggestedPattern: 'edit:src/**',
      onDecision: () => {},
      onEnableYolo: () => {},
    }),
    { columns: 100, rows: 30 },
  );
  await settle();
  const frames: ChromeFrames = {
    statusBar: bar.lastFrame(),
    inputBox: input.lastFrame(),
    permissionPrompt: prompt.lastFrame(),
    raw: [...bar.stdout.frames, ...input.stdout.frames, ...prompt.stdout.frames].join(''),
  };
  bar.unmount();
  input.unmount();
  prompt.unmount();
  return frames;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('icons setting — status bar and input box', () => {
  it('nerd: Powerline separators and Nerd icons', async () => {
    const { statusBar, raw } = await renderChrome({ WSTACK_ICONS: 'nerd' });
    expect(PRIVATE_USE.test(raw)).toBe(true);
    expect(statusBar).toMatchSnapshot();
  });

  it('ascii: same layout, no private-use code point anywhere in the output', async () => {
    const { statusBar, raw } = await renderChrome({ WSTACK_ICONS: 'ascii' });
    const offenders = [...raw]
      .filter((char) => PRIVATE_USE.test(char))
      .map((char) => `U+${char.codePointAt(0)?.toString(16).toUpperCase()}`);
    expect(offenders).toEqual([]);
    expect(statusBar).toMatchSnapshot();
  });

  it('ascii keeps every status-bar cell where nerd put it', async () => {
    const nerd = await renderChrome({ WSTACK_ICONS: 'nerd' });
    const ascii = await renderChrome({ WSTACK_ICONS: 'ascii' });
    const { displayWidth } = await import('../src/terminal-width.js');
    const nerdLines = nerd.statusBar.split('\n');
    const asciiLines = ascii.statusBar.split('\n');
    expect(asciiLines.map(displayWidth)).toEqual(nerdLines.map(displayWidth));
    // Same text in the same columns: only the icon cells differ.
    const words = (line: string) => line.match(/[A-Za-z0-9][\w./-]*/g) ?? [];
    expect(asciiLines.map(words)).toEqual(nerdLines.map(words));
  });

  it('ascii leaves the input box and permission prompt exactly as non-Nerd terminals drew them', async () => {
    // The `❯` prompt, the frame and the first line are matched by the tools that
    // supervise WrongStack. `unicode` was the profile every terminal without a
    // Nerd Font got before the icons setting existed.
    const before = await renderChrome({ WRONGSTACK_TUI_ICON_STYLE: 'unicode' });
    const ascii = await renderChrome({ WSTACK_ICONS: 'ascii' });
    expect(ascii.inputBox).toBe(before.inputBox);
    expect(ascii.permissionPrompt).toBe(before.permissionPrompt);
    expect(ascii.permissionPrompt).toContain('edit');
    expect(ascii.inputBox).toContain('❯ hello');
    expect(ascii.inputBox.split('\n')[0]).toMatch(/^╭─ ◆ ASK WRONGSTACK ─+.*╮$/);
  });
});
