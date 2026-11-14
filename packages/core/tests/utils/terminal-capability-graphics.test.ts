import { describe, expect, it } from 'vitest';
import { detectTerminal, detectTerminalHost } from '../../src/utils/terminal-capability.js';

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

describe('detectTerminalHost — browser/webview hosts', () => {
  it('keeps native desktop terminals native', () => {
    expect(detectTerminalHost({ TERM: 'xterm-256color' })).toEqual({
      host: 'native',
      kind: null,
      remoteClient: false,
    });
  });

  it('detects hosted browser workspaces as remote browser clients', () => {
    expect(detectTerminalHost({ CODESPACES: 'true', CODESPACE_NAME: 'demo' })).toEqual({
      host: 'browser',
      kind: 'codespaces',
      remoteClient: true,
    });
    expect(detectTerminalHost({ GITPOD_WORKSPACE_ID: 'ws-1' })).toEqual({
      host: 'browser',
      kind: 'gitpod',
      remoteClient: true,
    });
    expect(detectTerminalHost({ OPENVSCODE_SERVER_ROOT: '/opt/openvscode-server' })).toEqual({
      host: 'browser',
      kind: 'code-server',
      remoteClient: true,
    });
    expect(detectTerminalHost({ JUPYTER_SERVER_ROOT: '/home/me' })).toEqual({
      host: 'browser',
      kind: 'jupyter',
      remoteClient: true,
    });
  });

  it('treats the local VS Code webview as a browser host with a local client', () => {
    expect(detectTerminalHost({ TERM_PROGRAM: 'vscode' })).toEqual({
      host: 'browser',
      kind: 'vscode',
      remoteClient: false,
    });
  });

  it('detects IDE-hosted terminals that paint with the editor font (JetBrains, Coder, Cloud9)', () => {
    expect(detectTerminalHost({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).toEqual({
      host: 'browser',
      kind: 'jetbrains',
      remoteClient: true,
    });
    expect(detectTerminalHost({ CODER_WORKSPACE_ID: 'ws-1' })).toEqual({
      host: 'browser',
      kind: 'coder',
      remoteClient: true,
    });
    expect(detectTerminalHost({ C9_PROJECT: '/home/ec2-user/environment' })).toEqual({
      host: 'browser',
      kind: 'cloud9',
      remoteClient: true,
    });
  });

  it('marks the client remote when the session itself is SSH', () => {
    expect(detectTerminalHost({ TERM_PROGRAM: 'vscode', SSH_CONNECTION: 'a 1 b 2' })).toEqual({
      host: 'browser',
      kind: 'vscode',
      remoteClient: true,
    });
  });

  it('honors the WRONGSTACK_TUI_TERMINAL override in both directions', () => {
    expect(detectTerminalHost({ CODESPACES: 'true', WRONGSTACK_TUI_TERMINAL: 'native' })).toEqual({
      host: 'native',
      kind: null,
      remoteClient: false,
    });
    expect(detectTerminalHost({ WRONGSTACK_TUI_TERMINAL: 'browser' })).toEqual({
      host: 'browser',
      kind: null,
      remoteClient: true,
    });
  });

  it('never selects kitty/iTerm2 image protocols for a browser host', () => {
    const tty = fakeStreams(true, true);
    const capability = detectTerminal({
      ...tty,
      env: {
        TERM: 'xterm-kitty',
        KITTY_WINDOW_ID: '1',
        COLORTERM: 'truecolor',
        CODESPACES: 'true',
      },
    });
    expect(capability.terminalHost.host).toBe('browser');
    expect(capability.graphicsProtocol).toBe('halfblock');

    const noTruecolor = detectTerminal({
      ...tty,
      env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1', CODESPACES: 'true' },
    });
    // A browser host is 24-bit whether or not COLORTERM arrived, so the
    // half-block mosaic survives instead of degrading to a text card.
    expect(noTruecolor.colorDepth).toBe(3);
    expect(noTruecolor.graphicsProtocol).toBe('halfblock');

    const optedOut = detectTerminal({
      ...tty,
      env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1', CODESPACES: 'true', NO_COLOR: '1' },
    });
    expect(optedOut.colorDepth).toBe(0);
    expect(optedOut.graphicsProtocol).toBe('none');
  });

  it('still honors an explicit WRONGSTACK_TUI_GRAPHICS override on a browser host', () => {
    const capability = detectTerminal({
      ...fakeStreams(true, true),
      env: { TERM: 'xterm-256color', CODESPACES: 'true', WRONGSTACK_TUI_GRAPHICS: 'kitty' },
    });
    expect(capability.graphicsProtocol).toBe('kitty');
  });

  it('exposes the host on the capability snapshot', () => {
    const capability = detectTerminal({
      ...fakeStreams(true, true),
      env: { TERM: 'xterm-256color', GITPOD_WORKSPACE_ID: 'ws-1' },
    });
    expect(capability.terminalHost).toEqual({
      host: 'browser',
      kind: 'gitpod',
      remoteClient: true,
    });
  });
});

describe('detectTerminal — browser hosts are truecolor-capable', () => {
  it('promotes a COLORTERM-less web terminal so the halfblock mosaic survives', () => {
    // ttyd/gotty shape: a shell inheriting only TERM=xterm-256color, no
    // COLORTERM, and the operator pinning the host because those servers export
    // no marker of their own.
    const ttyd = detectTerminal({
      ...fakeStreams(true, true),
      env: { TERM: 'xterm-256color', WRONGSTACK_TUI_TERMINAL: 'browser' },
    });
    expect(ttyd.colorDepth).toBe(3);
    expect(ttyd.graphicsProtocol).toBe('halfblock');

    const gotty = detectTerminal({
      ...fakeStreams(true, true),
      env: { TERM: 'xterm', BROWSER_TERMINAL: '1' },
    });
    expect(gotty.colorDepth).toBe(3);
    expect(gotty.graphicsProtocol).toBe('halfblock');
  });

  it('leaves a native 256-colour terminal at its reported depth', () => {
    const native = detectTerminal({
      ...fakeStreams(true, true),
      env: { TERM: 'xterm-256color' },
    });
    expect(native.colorDepth).toBe(2);
    expect(native.graphicsProtocol).toBe('none');
  });

  it('keeps explicit colour opt-outs intact on a browser host', () => {
    const noColor = detectTerminal({
      ...fakeStreams(true, true),
      env: { TERM: 'xterm-256color', CODESPACES: 'true', NO_COLOR: '1' },
    });
    expect(noColor.colorDepth).toBe(0);
    expect(noColor.graphicsProtocol).toBe('none');

    const forcedOff = detectTerminal({
      ...fakeStreams(true, true),
      env: { TERM: 'xterm-256color', CODESPACES: 'true', FORCE_COLOR: '0' },
    });
    expect(forcedOff.colorDepth).toBe(0);
    expect(forcedOff.graphicsProtocol).toBe('none');
  });

  it('does not promote non-TTY output', () => {
    const piped = detectTerminal({
      ...fakeStreams(false, true),
      env: { TERM: 'xterm-256color', CODESPACES: 'true' },
    });
    expect(piped.colorDepth).toBe(0);
    expect(piped.graphicsProtocol).toBe('none');
  });
});
