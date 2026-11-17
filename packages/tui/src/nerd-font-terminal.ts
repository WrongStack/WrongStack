/**
 * Does the terminal that paints this process's output draw Nerd Font glyphs?
 *
 * `icons = auto` asks this, and a wrong "yes" costs far more than a wrong "no":
 * a yes on a terminal without the font turns every status-bar icon into an
 * empty box, while a no only swaps icons for plain characters. So this answers
 * yes only on positive evidence:
 *
 * - WezTerm, kitty and Ghostty bundle the Nerd Font symbols as a fallback font,
 *   so their icons render whatever font the user picked.
 * - Alacritty and Windows Terminal bundle nothing, so they count only when the
 *   font set in their own config file is a Nerd Font. That file lives on the
 *   machine showing the window, so over SSH they never count.
 * - Inside tmux or screen the outer terminal is unknown; a terminal marker left
 *   in the environment may belong to a client that has since detached.
 *
 * Having a Nerd Font installed is not evidence: the terminal may use another.
 */

import { readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeJsonString } from '@wrongstack/primitives/safe-json';

export type NerdFontTerminal = 'wezterm' | 'kitty' | 'ghostty' | 'alacritty' | 'windows-terminal';

/** Terminals that ship the Nerd Font symbols as a built-in fallback font. */
const BUNDLES_NERD_SYMBOLS: ReadonlySet<NerdFontTerminal> = new Set([
  'wezterm',
  'kitty',
  'ghostty',
]);

/**
 * A font family that carries the Nerd Font glyphs: "JetBrainsMono Nerd Font",
 * "Symbols Nerd Font Mono", and the short v3 names "Cascadia Code NF",
 * "JetBrainsMono NFM", "Hack NFP".
 */
const NERD_FAMILY_RE = /nerd\s*font|\bNF[MP]?\b/i;

/** Terminal config files are small; anything bigger is not one. */
const MAX_CONFIG_BYTES = 1_048_576;

export interface NerdFontTerminalProbe {
  platform?: NodeJS.Platform | undefined;
  homeDir?: string | undefined;
  /** Reads a config file; `undefined` when it is missing or unreadable. */
  readText?: ((file: string) => string | undefined) | undefined;
}

function readTextFile(file: string): string | undefined {
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Names the terminal emulator from its environment markers, or null. */
function identifyTerminal(env: NodeJS.ProcessEnv): NerdFontTerminal | null {
  const term = (env['TERM'] ?? '').trim().toLowerCase();
  if (env['TMUX'] || env['STY'] || term.startsWith('tmux') || term.startsWith('screen')) {
    return null;
  }
  // TERM_PROGRAM names the terminal (or multiplexer) that started this shell
  // and wins over markers a parent terminal may have left behind.
  const program = (env['TERM_PROGRAM'] ?? '').trim().toLowerCase();
  if (program) {
    if (program === 'wezterm' || program === 'ghostty' || program === 'kitty') return program;
    return null;
  }
  if (term === 'xterm-kitty' || env['KITTY_WINDOW_ID']) return 'kitty';
  if (term === 'xterm-ghostty' || env['GHOSTTY_RESOURCES_DIR']) return 'ghostty';
  if (term === 'wezterm' || env['WEZTERM_PANE']) return 'wezterm';
  if (term === 'alacritty' || env['ALACRITTY_WINDOW_ID'] || env['ALACRITTY_SOCKET']) {
    return 'alacritty';
  }
  if (env['WT_SESSION']) return 'windows-terminal';
  return null;
}

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['SSH_CONNECTION'] || env['SSH_CLIENT'] || env['SSH_TTY']);
}

/** Alacritty reads the first of these that exists (alacritty(5), "LOCATION"). */
function alacrittyConfigFiles(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string,
): string[] {
  if (platform === 'win32') {
    return env['APPDATA'] ? [path.win32.join(env['APPDATA'], 'alacritty', 'alacritty.toml')] : [];
  }
  const xdg = env['XDG_CONFIG_HOME'];
  return [
    ...(xdg
      ? [
          path.posix.join(xdg, 'alacritty', 'alacritty.toml'),
          path.posix.join(xdg, 'alacritty.toml'),
        ]
      : []),
    path.posix.join(homeDir, '.config', 'alacritty', 'alacritty.toml'),
    path.posix.join(homeDir, '.alacritty.toml'),
    '/etc/alacritty/alacritty.toml',
  ];
}

/** Every `family = "…"` in an Alacritty TOML config (normal, bold, italic). */
function alacrittyFontFamilies(toml: string): string[] {
  const families: string[] = [];
  for (const match of toml.matchAll(/^[^#\n]*?\bfamily\s*=\s*(["'])([^"'\n]+)\1/gm)) {
    families.push(match[2]!);
  }
  return families;
}

function windowsTerminalSettingsFiles(env: NodeJS.ProcessEnv): string[] {
  const local = env['LOCALAPPDATA'];
  if (!local) return [];
  const packaged = (name: string) =>
    path.win32.join(local, 'Packages', name, 'LocalState', 'settings.json');
  return [
    packaged('Microsoft.WindowsTerminal_8wekyb3d8bbwe'),
    packaged('Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe'),
    // Unpackaged installs (portable zip, scoop, winget's unpackaged build).
    path.win32.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function fontFaceOf(profile: JsonObject | undefined): string | undefined {
  const face = asObject(profile?.['font'])?.['face'] ?? profile?.['fontFace'];
  return typeof face === 'string' && face.trim() ? face : undefined;
}

/**
 * The font face of the Windows Terminal profile this shell runs in: the profile
 * named by `WT_PROFILE_ID`, else the settings' `defaultProfile`; its own face,
 * else `profiles.defaults`, else Windows Terminal's built-in Cascadia Mono.
 * `undefined` when the settings do not parse or do not hold that profile.
 */
function windowsTerminalFontFace(
  settingsJson: string,
  profileId: string | undefined,
): string | undefined {
  // settings.json is JSONC: comments and trailing commas are allowed.
  const json = sanitizeJsonString(settingsJson);
  if (json === null) return undefined;
  const settings = asObject(JSON.parse(json));
  if (!settings) return undefined;
  const profiles = settings['profiles'];
  const list = Array.isArray(profiles) ? profiles : asObject(profiles)?.['list'];
  const defaults = Array.isArray(profiles) ? undefined : asObject(asObject(profiles)?.['defaults']);
  const id = (profileId ?? settings['defaultProfile'] ?? '').toString().trim().toLowerCase();
  if (!id || !Array.isArray(list)) return undefined;
  const profile = list
    .map(asObject)
    .find((entry) => String(entry?.['guid'] ?? '').toLowerCase() === id);
  if (!profile) return undefined;
  return fontFaceOf(profile) ?? fontFaceOf(defaults) ?? 'Cascadia Mono';
}

function configuredFontIsNerd(
  terminal: 'alacritty' | 'windows-terminal',
  env: NodeJS.ProcessEnv,
  probe: NerdFontTerminalProbe,
): boolean {
  const readText = probe.readText ?? readTextFile;
  if (terminal === 'alacritty') {
    const platform = probe.platform ?? process.platform;
    const homeDir = probe.homeDir ?? os.homedir();
    for (const file of alacrittyConfigFiles(env, platform, homeDir)) {
      const toml = readText(file);
      if (toml === undefined) continue;
      // The first file found is the one Alacritty loads; no family = its default.
      return alacrittyFontFamilies(toml).some((family) => NERD_FAMILY_RE.test(family));
    }
    return false;
  }
  for (const file of windowsTerminalSettingsFiles(env)) {
    const text = readText(file);
    if (text === undefined) continue;
    const face = windowsTerminalFontFace(text, env['WT_PROFILE_ID']);
    // A file without this shell's profile belongs to the other WT install.
    if (face !== undefined) return NERD_FAMILY_RE.test(face);
  }
  return false;
}

/** True only when the terminal is known to draw Nerd Font glyphs. */
export function detectNerdFontTerminal(
  env: NodeJS.ProcessEnv,
  probe: NerdFontTerminalProbe = {},
): boolean {
  const terminal = identifyTerminal(env);
  if (terminal === null) return false;
  if (terminal === 'alacritty' || terminal === 'windows-terminal') {
    return !isRemoteSession(env) && configuredFontIsNerd(terminal, env, probe);
  }
  return BUNDLES_NERD_SYMBOLS.has(terminal);
}
