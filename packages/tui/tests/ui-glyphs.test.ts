import { describe, expect, it } from 'vitest';
import { displayWidth } from '../src/terminal-width.js';
import {
  glyphSet,
  glyphs,
  hasInstalledNerdFont,
  type IconStyle,
  isBrowserSafeGlyph,
  resolveIconStyle,
} from '../src/ui-glyphs.js';

const noNerdFont = () => false;

describe('resolveIconStyle', () => {
  it('returns "unicode" when env is not set', () => {
    expect(resolveIconStyle({}, noNerdFont)).toBe('unicode');
  });

  it('returns "unicode" when env is undefined', () => {
    expect(resolveIconStyle(undefined as unknown as NodeJS.ProcessEnv, noNerdFont)).toBe('unicode');
  });

  it('returns "unicode" for unrecognised values', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'whatever' }, () => true)).toBe('unicode');
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: '' }, noNerdFont)).toBe('unicode');
  });

  it('returns "nerd" for "nerd"', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'nerd' })).toBe('nerd');
  });

  it('returns "nerd" for "nerd-font"', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'nerd-font' })).toBe('nerd');
  });

  it('returns "nerd" for "nerdfont"', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'nerdfont' })).toBe('nerd');
  });

  it('returns "nerd" for "NERD" (case insensitive)', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'NERD' })).toBe('nerd');
  });

  it('returns "ascii" for "ascii"', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'ascii' })).toBe('ascii');
  });

  it('returns "ascii" for "plain"', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'plain' })).toBe('ascii');
  });

  it('trims whitespace from env value', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: '  nerd  ' })).toBe('nerd');
  });

  it('auto-selects nerd glyphs when a local Nerd Font is installed', () => {
    expect(resolveIconStyle({}, () => true)).toBe('nerd');
  });

  it('lets an explicit unicode setting override installed Nerd Fonts', () => {
    expect(resolveIconStyle({ WRONGSTACK_TUI_ICON_STYLE: 'unicode' }, () => true)).toBe('unicode');
  });

  it('reads from process.env by default', () => {
    // This test checks the default parameter behavior
    const result = resolveIconStyle();
    expect(['unicode', 'nerd', 'ascii']).toContain(result);
  });
});

describe('hasInstalledNerdFont', () => {
  it('detects Nerd Font files recursively in local font directories', () => {
    const files = new Map<string, Array<{ name: string; isDirectory: boolean }>>([
      ['/home/me/.local/share/fonts', [{ name: 'JetBrainsMono', isDirectory: true }]],
      [
        '/home/me/.local/share/fonts/JetBrainsMono',
        [{ name: 'JetBrainsMonoNerdFontMono-Regular.ttf', isDirectory: false }],
      ],
    ]);
    expect(
      hasInstalledNerdFont({
        platform: 'linux',
        homeDir: '/home/me',
        env: {},
        readDirectory: (directory) => {
          const entries = files.get(directory);
          if (!entries) throw new Error('missing');
          return entries;
        },
      }),
    ).toBe(true);
  });

  it('does not infer the SSH client font from server-side font files', () => {
    expect(
      hasInstalledNerdFont({
        platform: 'linux',
        homeDir: '/home/me',
        env: { SSH_CONNECTION: 'client 1 server 2' },
        readDirectory: () => [{ name: 'SymbolsNerdFont-Regular.ttf', isDirectory: false }],
      }),
    ).toBe(false);
  });

  it('ignores unrelated font files', () => {
    expect(
      hasInstalledNerdFont({
        platform: 'darwin',
        homeDir: '/Users/me',
        env: {},
        readDirectory: (directory) => {
          if (directory === '/Users/me/Library/Fonts') {
            return [{ name: 'Inter-Regular.ttf', isDirectory: false }];
          }
          throw new Error('missing');
        },
      }),
    ).toBe(false);
  });
});

describe('glyphSet', () => {
  it('returns UNICODE glyphs by default', () => {
    const g = glyphSet();
    expect(g.brand).toBe('◆');
    expect(g.prompt).toBe('❯');
    expect(g.success).toBe('✓');
    expect(g.failure).toBe('×');
  });

  it('returns UNICODE glyphs for "unicode" style', () => {
    const g = glyphSet('unicode');
    expect(g.segmentStart).toBe('◖');
    expect(g.segmentTransition).toBe('▶');
    expect(g.segmentEnd).toBe('◗');
  });

  it('returns NERD glyphs for "nerd" style', () => {
    const g = glyphSet('nerd');
    expect(g.brand).toBe('󰚩');
    expect(g.gitBranch).toBe('');
    expect(g.fleet).toBe('󰓾');
    expect(g.segmentStart).toBe('');
    expect(g.segmentTransition).toBe('');
    expect(g.segmentEnd).toBe('');
  });

  it('returns ASCII glyphs for "ascii" style', () => {
    const g = glyphSet('ascii');
    expect(g.brand).toBe('*');
    expect(g.prompt).toBe('>');
    expect(g.success).toBe('+');
    expect(g.failure).toBe('x');
    expect(g.idle).toBe('o');
    expect(g.running).toBe('>');
    expect(g.gitBranch).toBe('git');
    expect(g.segmentStart).toBe('[');
    expect(g.segmentTransition).toBe('>');
    expect(g.segmentEnd).toBe(']');
  });

  it('returns UNICODE for unrecognised style', () => {
    const g = glyphSet('bogus' as IconStyle);
    expect(g.prompt).toBe('❯');
  });

  it('NERD glyphs include all the same fields as UNICODE', () => {
    const unicode = glyphSet('unicode');
    const nerd = glyphSet('nerd');
    expect(Object.keys(nerd).sort()).toEqual(Object.keys(unicode).sort());
  });

  it('ASCII glyphs include all the same fields as UNICODE', () => {
    const unicode = glyphSet('unicode');
    const ascii = glyphSet('ascii');
    expect(Object.keys(ascii).sort()).toEqual(Object.keys(unicode).sort());
  });

  it('NERD overrides specific UNICODE fields', () => {
    const unicode = glyphSet('unicode');
    const nerd = glyphSet('nerd');
    // Nerd should differ for brand, gitBranch, etc.
    expect(nerd.brand).not.toBe(unicode.brand);
    // But prompt should be the same
    expect(nerd.prompt).toBe(unicode.prompt);
  });
});

describe('glyphs singleton', () => {
  it('is exported as a frozen object resolved from the process env', () => {
    expect(Object.isFrozen(glyphs)).toBe(true);
    expect(glyphs).toBe(glyphSet(resolveIconStyle()));
  });
});

describe('resolveIconStyle — browser-hosted terminals', () => {
  it('refuses Nerd Font auto-detection for every browser host, local or remote', () => {
    // Browser emulators paint with the page's CSS font stack, so a font scan of
    // this machine cannot describe the surface the user is looking at — private-
    // use Nerd glyphs would render as tofu boxes.
    expect(resolveIconStyle({ CODESPACES: 'true' }, () => true)).toBe('browser');
    expect(resolveIconStyle({ GITPOD_WORKSPACE_ID: 'ws-1' }, () => true)).toBe('browser');
    expect(
      resolveIconStyle({ TERM_PROGRAM: 'vscode', SSH_CONNECTION: 'a 1 b 2' }, () => true),
    ).toBe('browser');
    // Remote-SSH/Containers spawn the shell on the server, so SSH_CONNECTION is
    // absent there; the local webview marker alone must still suppress it.
    expect(resolveIconStyle({ TERM_PROGRAM: 'vscode' }, () => true)).toBe('browser');
    expect(resolveIconStyle({ TERM_PROGRAM: 'hyper' }, () => true)).toBe('browser');
    expect(resolveIconStyle({ TERM_PROGRAM: 'tabby' }, () => true)).toBe('browser');
  });

  it('keeps native terminals on the font scan', () => {
    expect(resolveIconStyle({ TERM: 'xterm-256color' }, () => true)).toBe('nerd');
    expect(resolveIconStyle({ TERM: 'xterm-256color' }, noNerdFont)).toBe('unicode');
  });

  it('still honors an explicit icon style override in a browser terminal', () => {
    expect(
      resolveIconStyle({ CODESPACES: 'true', WRONGSTACK_TUI_ICON_STYLE: 'nerd' }, noNerdFont),
    ).toBe('nerd');
    expect(
      resolveIconStyle({ CODESPACES: 'true', WRONGSTACK_TUI_ICON_STYLE: 'ascii' }, () => true),
    ).toBe('ascii');
  });
});

describe('browser glyph profile', () => {
  const browser = glyphSet('browser');
  const unicode = glyphSet('unicode');

  // Structural prefixes, not icons: `indent` is two spaces, the tree prefixes a
  // corner plus a dash. They must still be safe and exactly two cells wide.
  const COMPOSITE_KEYS = ['indent', 'treeLast', 'treeBranch', 'treeThrough'] as const;

  it('is a complete profile with the same keys as unicode', () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(unicode).sort());
  });

  it('renders every icon glyph in exactly one cell', () => {
    for (const [key, value] of Object.entries(browser)) {
      if ((COMPOSITE_KEYS as readonly string[]).includes(key)) continue;
      expect(displayWidth(value), `${key} (${value})`).toBe(1);
    }
  });

  it('keeps layout prefixes at two safe cells', () => {
    for (const key of COMPOSITE_KEYS) {
      expect(displayWidth(browser[key]), key).toBe(2);
      expect(isBrowserSafeGlyph(browser[key]), key).toBe(true);
    }
  });

  it('uses only code points common monospace fonts cover', () => {
    for (const [key, value] of Object.entries(browser)) {
      expect(isBrowserSafeGlyph(value), `${key} (${value})`).toBe(true);
    }
  });

  it('contains no private-use, variation-selector or emoji-presentation glyphs', () => {
    for (const [key, value] of Object.entries(browser)) {
      expect(/[\uE000-\uF8FF]/.test(value), key).toBe(false);
      expect(/[\uFE0E\uFE0F\u200D]/.test(value), key).toBe(false);
      // Some Geometric Shapes (▶, ◀) carry Extended_Pictographic yet render as
      // single-cell text in every monospace font; a pictographic glyph outside
      // that block is an emoji whose width the layout cannot predict.
      for (const char of value) {
        if (!/\p{Extended_Pictographic}/u.test(char)) continue;
        const codePoint = char.codePointAt(0) ?? 0;
        expect(codePoint >= 0x25a0 && codePoint <= 0x25ff, `${key} (${char})`).toBe(true);
      }
    }
  });

  it('replaces the width-unstable symbols named in the remap', () => {
    const unstable = [
      '\u26B7',
      '\u26BF',
      '\u2397',
      '\u2398',
      '\u26E8',
      '\u2315',
      '\u{1F3A8}',
      '\u26A1',
    ];
    const browserValues = Object.values(browser);
    const unicodeValues = Object.values(unicode);
    for (const symbol of unstable) {
      expect(browserValues, symbol).not.toContain(symbol);
      expect(unicodeValues, symbol).toContain(symbol);
    }
  });

  it('maps every unsafe unicode glyph explicitly instead of falling back', () => {
    let remapped = 0;
    for (const [key, value] of Object.entries(unicode)) {
      if (isBrowserSafeGlyph(value)) continue;
      remapped += 1;
      expect(browser[key as keyof typeof browser], key).not.toBe(value);
      expect(browser[key as keyof typeof browser], key).not.toBe('\u00B7');
    }
    expect(remapped).toBeGreaterThan(0);
  });

  it('leaves already-safe unicode glyphs untouched and keeps the native profile intact', () => {
    for (const [key, value] of Object.entries(unicode)) {
      if (!isBrowserSafeGlyph(value)) continue;
      expect(browser[key as keyof typeof browser], key).toBe(value);
    }
    expect(unicode.lock).toBe('\u26BF');
    expect(browser.lock).toBe('L');
  });
});
