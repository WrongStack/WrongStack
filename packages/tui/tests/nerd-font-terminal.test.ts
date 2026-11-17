import { describe, expect, it } from 'vitest';
import { detectNerdFontTerminal } from '../src/nerd-font-terminal.js';

function files(map: Record<string, string>) {
  return { readText: (file: string) => map[file] };
}

const NO_FILES = files({});

describe('detectNerdFontTerminal — terminals that bundle the Nerd symbols', () => {
  it('says yes for WezTerm, kitty and Ghostty by any of their markers', () => {
    for (const env of [
      { TERM_PROGRAM: 'WezTerm' },
      { WEZTERM_PANE: '0' },
      { TERM_PROGRAM: 'ghostty' },
      { TERM: 'xterm-ghostty' },
      { TERM: 'xterm-kitty' },
      { KITTY_WINDOW_ID: '1' },
    ]) {
      expect(detectNerdFontTerminal(env, NO_FILES), JSON.stringify(env)).toBe(true);
    }
  });

  it('still says yes over SSH: the client terminal paints with its bundled font', () => {
    expect(detectNerdFontTerminal({ TERM: 'xterm-kitty', SSH_TTY: '/dev/pts/1' }, NO_FILES)).toBe(
      true,
    );
  });

  it('does not guess behind a multiplexer or another named terminal', () => {
    for (const env of [
      { TMUX: '/tmp/tmux-1/default', KITTY_WINDOW_ID: '1' },
      { TERM: 'screen-256color', WEZTERM_PANE: '0' },
      { TERM_PROGRAM: 'tmux', KITTY_WINDOW_ID: '1' },
      { TERM_PROGRAM: 'Apple_Terminal' },
      { TERM: 'xterm-256color' },
      {},
    ]) {
      expect(detectNerdFontTerminal(env, NO_FILES), JSON.stringify(env)).toBe(false);
    }
  });
});

describe('detectNerdFontTerminal — Alacritty reads its config', () => {
  const env = { ALACRITTY_WINDOW_ID: '1', XDG_CONFIG_HOME: '/home/me/.config' };
  const probe = { platform: 'linux' as const, homeDir: '/home/me' };
  const CONFIG = '/home/me/.config/alacritty/alacritty.toml';

  it('says yes only for a Nerd Font family', () => {
    const nerd = files({ [CONFIG]: '[font.normal]\nfamily = "JetBrainsMono Nerd Font"\n' });
    const shortName = files({ [CONFIG]: "[font.normal]\nfamily = 'Hack NF'\n" });
    const plain = files({ [CONFIG]: '[font]\nnormal = { family = "Hack" }\n' });
    const commented = files({ [CONFIG]: '# family = "Old Nerd Font"\n[font]\nsize = 12\n' });
    expect(detectNerdFontTerminal(env, { ...probe, ...nerd })).toBe(true);
    expect(detectNerdFontTerminal(env, { ...probe, ...shortName })).toBe(true);
    expect(detectNerdFontTerminal(env, { ...probe, ...plain })).toBe(false);
    expect(detectNerdFontTerminal(env, { ...probe, ...commented })).toBe(false);
  });

  it('says no without a config (the default font has no Nerd glyphs)', () => {
    expect(detectNerdFontTerminal(env, { ...probe, ...NO_FILES })).toBe(false);
  });

  it('says no over SSH: the config lives on the machine showing the window', () => {
    const nerd = files({ [CONFIG]: 'family = "JetBrainsMono Nerd Font"\n' });
    expect(
      detectNerdFontTerminal({ ...env, SSH_CONNECTION: 'a 1 b 2' }, { ...probe, ...nerd }),
    ).toBe(false);
  });

  it('reads %APPDATA% on Windows', () => {
    const winEnv = { TERM: 'alacritty', APPDATA: String.raw`C:\Users\me\AppData\Roaming` };
    const winProbe = files({
      [String.raw`C:\Users\me\AppData\Roaming\alacritty\alacritty.toml`]:
        '[font.normal]\nfamily = "CaskaydiaCove NFM"\n',
    });
    expect(detectNerdFontTerminal(winEnv, { platform: 'win32', ...winProbe })).toBe(true);
  });
});

describe("detectNerdFontTerminal — Windows Terminal reads the profile's font", () => {
  const LOCAL = String.raw`C:\Users\me\AppData\Local`;
  const STABLE = String.raw`C:\Users\me\AppData\Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`;
  const env = { WT_SESSION: 'x', LOCALAPPDATA: LOCAL };
  const settings = `{
    // JSONC: comments and trailing commas
    "defaultProfile": "{AAAA}",
    "profiles": {
      "defaults": { "font": { "face": "CaskaydiaCove Nerd Font" } },
      "list": [
        { "guid": "{AAAA}", "name": "PowerShell" },
        { "guid": "{BBBB}", "name": "cmd", "font": { "face": "Consolas" } },
        { "guid": "{CCCC}", "name": "bash", "fontFace": "Cascadia Code NF" },
      ],
    },
  }`;
  const probe = files({ [STABLE]: settings });

  it('uses the default profile, inheriting profiles.defaults', () => {
    expect(detectNerdFontTerminal(env, probe)).toBe(true);
  });

  it('uses the profile named by WT_PROFILE_ID, case-insensitively', () => {
    expect(detectNerdFontTerminal({ ...env, WT_PROFILE_ID: '{bbbb}' }, probe)).toBe(false);
    expect(detectNerdFontTerminal({ ...env, WT_PROFILE_ID: '{CCCC}' }, probe)).toBe(true);
  });

  it('falls back to Cascadia Mono, which has no Nerd glyphs', () => {
    const bare = JSON.stringify({ defaultProfile: '{A}', profiles: { list: [{ guid: '{A}' }] } });
    expect(detectNerdFontTerminal(env, files({ [STABLE]: bare }))).toBe(false);
  });

  it('says no when the settings are missing, unparseable or lack the profile', () => {
    expect(detectNerdFontTerminal(env, NO_FILES)).toBe(false);
    expect(detectNerdFontTerminal(env, files({ [STABLE]: 'not json' }))).toBe(false);
    expect(detectNerdFontTerminal({ ...env, WT_PROFILE_ID: '{ZZZZ}' }, probe)).toBe(false);
  });

  it('finds the profile in the unpackaged install when the packaged one lacks it', () => {
    const unpackaged = String.raw`C:\Users\me\AppData\Local\Microsoft\Windows Terminal\settings.json`;
    const other = JSON.stringify({ profiles: { list: [{ guid: '{OTHER}' }] } });
    const mine = JSON.stringify({
      profiles: { list: [{ guid: '{MINE}', font: { face: 'JetBrainsMono NF' } }] },
    });
    expect(
      detectNerdFontTerminal(
        { ...env, WT_PROFILE_ID: '{MINE}' },
        files({ [STABLE]: other, [unpackaged]: mine }),
      ),
    ).toBe(true);
  });
});
