import { describe, expect, it } from 'vitest';
import { detectTerminal } from '../../src/utils/terminal-capability.js';

function fakeStreams(isTTY = true, withColorDepth = true) {
  const stdin = { isTTY } as unknown as NodeJS.ReadStream;
  const stdout = {
    isTTY,
    write: () => true,
    ...(withColorDepth ? { getColorDepth: () => 24 } : {}),
  } as unknown as NodeJS.WriteStream;
  return { stdin, stdout };
}

describe('detectTerminal — supportsSyncOutput & graphicsProtocol', () => {
  it('enables synchronized output on modern real TTYs and disables on non-TTY or dumb terminals', () => {
    const tty = fakeStreams(true, true);
    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      }).supportsSyncOutput,
    ).toBe(true);

    expect(
      detectTerminal({
        ...fakeStreams(false, true),
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      }).supportsSyncOutput,
    ).toBe(false);

    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'dumb', COLORTERM: 'truecolor' },
      }).supportsSyncOutput,
    ).toBe(false);
  });

  it('honors WRONGSTACK_TUI_SYNC=0 and WRONGSTACK_TUI_SYNC=1 overrides', () => {
    const tty = fakeStreams(true, true);
    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'xterm-256color', WRONGSTACK_TUI_SYNC: '0' },
      }).supportsSyncOutput,
    ).toBe(false);

    expect(
      detectTerminal({
        ...fakeStreams(true, false),
        env: { TERM: 'xterm-256color', WRONGSTACK_TUI_SYNC: '1' },
      }).supportsSyncOutput,
    ).toBe(true);
  });

  it('detects Kitty and Ghostty as kitty graphics protocol', () => {
    const tty = fakeStreams(true, true);
    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'xterm-kitty', COLORTERM: 'truecolor' },
      }).graphicsProtocol,
    ).toBe('kitty');

    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'xterm-ghostty', GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' },
      }).graphicsProtocol,
    ).toBe('kitty');
  });

  it('detects iTerm2, WezTerm, Warp, and Rio as iterm2 graphics protocol', () => {
    const tty = fakeStreams(true, true);
    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', COLORTERM: 'truecolor' },
      }).graphicsProtocol,
    ).toBe('iterm2');

    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'xterm-256color', WEZTERM_PANE: '0', COLORTERM: 'truecolor' },
      }).graphicsProtocol,
    ).toBe('iterm2');
  });

  it('falls back to halfblock inside tmux unless WRONGSTACK_TUI_TMUX_PASSTHROUGH=1 is set', () => {
    const tty = fakeStreams(true, true);
    expect(
      detectTerminal({
        ...tty,
        env: { TERM: 'tmux-256color', KITTY_WINDOW_ID: '1', COLORTERM: 'truecolor' },
      }).graphicsProtocol,
    ).toBe('halfblock');

    expect(
      detectTerminal({
        ...tty,
        env: {
          TERM: 'tmux-256color',
          KITTY_WINDOW_ID: '1',
          COLORTERM: 'truecolor',
          WRONGSTACK_TUI_TMUX_PASSTHROUGH: '1',
        },
      }).graphicsProtocol,
    ).toBe('kitty');
  });

  it('disables graphics in frugal perf profile or when WRONGSTACK_TUI_GRAPHICS=off', () => {
    const tty = fakeStreams(true, true);
    expect(
      detectTerminal({
        ...tty,
        env: {
          TERM: 'xterm-kitty',
          KITTY_WINDOW_ID: '1',
          WRONGSTACK_PERF_PROFILE: 'frugal',
        },
      }).graphicsProtocol,
    ).toBe('none');

    expect(
      detectTerminal({
        ...tty,
        env: {
          TERM: 'xterm-kitty',
          KITTY_WINDOW_ID: '1',
          WRONGSTACK_TUI_GRAPHICS: 'off',
        },
      }).graphicsProtocol,
    ).toBe('none');
  });
});
