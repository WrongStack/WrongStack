import { describe, expect, it, vi } from 'vitest';
import {
  createGraphemeStableStdout,
  resolveGraphemePolicy,
  stabilizeGraphemes,
  stabilizeTerminalOutput,
} from '../src/grapheme-stable-stdout.js';
import { displayWidth } from '../src/terminal-width.js';

const PIN_RE = /\x1b7 {2}\x1b8(.+?)\x1b8\x1b\[2C/gu;
/** The pinned form advances exactly two columns; collapse it to measure. */
const unpin = (text: string): string => text.replace(PIN_RE, '$1');

describe('stabilizeGraphemes', () => {
  it.each([
    ['⚠️', '⚠ '],
    ['❤️', '❤ '],
    ['1️⃣', '1 '],
    ['👍🏽', '\x1b7  \x1b8👍\x1b8\x1b[2C'],
    ['👨‍👩‍👧', '\x1b7  \x1b8👨\x1b8\x1b[2C'],
    ['🧑🏽‍💻', '\x1b7  \x1b8🧑\x1b8\x1b[2C'],
    ['🏳️‍🌈', '🏳 '],
    ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', '\x1b7  \x1b8🏴\x1b8\x1b[2C'],
    ['✌🏿', '✌ '],
    ['🚀', '\x1b7  \x1b8🚀\x1b8\x1b[2C'],
    ['✅', '\x1b7  \x1b8✅\x1b8\x1b[2C'],
  ])('rewrites %s to a width every terminal agrees on', (cluster, expected) => {
    expect(stabilizeGraphemes(cluster)).toBe(expected);
  });

  it('keeps the string-width of every cluster, so Ink layout is unchanged', () => {
    const line = '• ⚠️ warn 🚀 go 👍🏽 ok 👨‍👩‍👧 fam 🇹🇷 tr 1️⃣ one ❤️ love 中文 ① ★ ✓ ⚡ é ©';
    const stable = stabilizeGraphemes(line);
    expect(displayWidth(unpin(stable))).toBe(displayWidth(line));
    // Every emoji sequence is gone: no joiner, selector, modifier or keycap.
    expect(unpin(stable)).not.toMatch(/\u200D|\uFE0F|\u20E3|[\u{1F3FB}-\u{1F3FF}]/u);
  });

  it('returns text without pictographs unchanged', () => {
    const text = '中文字符 ① ← → ± × ÷ ° § plain ascii';
    expect(stabilizeGraphemes(text)).toBe(text);
  });

  it('leaves regional-indicator flags alone: every table gives them two columns', () => {
    expect(stabilizeGraphemes('🇹🇷')).toBe('🇹🇷');
  });
});

describe('stabilizeTerminalOutput', () => {
  it('rewrites text between escape sequences and never inside one', () => {
    const link = '\x1b]8;;https://example.test/⚠️\x07';
    const chunk = `\x1b[1;1H\x1b[J\x1b[38;2;1;2;3m⚠️ warn\x1b[39m ${link}🚀\x1b]8;;\x07\n`;
    const out = stabilizeTerminalOutput(chunk);
    expect(out.startsWith('\x1b[1;1H\x1b[J\x1b[38;2;1;2;3m⚠  warn\x1b[39m ')).toBe(true);
    expect(out).toContain(link);
    expect(out).toContain('\x1b7  \x1b8🚀\x1b8\x1b[2C\x1b]8;;\x07\n');
  });

  it('returns the same string for a chunk with nothing to rewrite', () => {
    const chunk = '\x1b[2K│ plain row │\n';
    expect(stabilizeTerminalOutput(chunk)).toBe(chunk);
  });
});

describe('resolveGraphemePolicy', () => {
  const native = (kind: string | null) => ({ host: 'native' as const, kind, remoteClient: false });

  it.each([
    [{}, { host: 'browser' as const, kind: 'vscode', remoteClient: false }, 'safe'],
    [{}, native(null), 'safe'],
    [{}, native('tmux'), 'safe'],
    [{}, native('alacritty'), 'safe'],
    [{}, native('apple-terminal'), 'safe'],
    [{}, native('kitty'), 'full'],
    [{}, native('wezterm'), 'full'],
    [{}, native('windows-terminal'), 'full'],
    [{ WRONGSTACK_TUI_GRAPHEMES: 'safe' }, native('kitty'), 'safe'],
    [{ WRONGSTACK_TUI_GRAPHEMES: 'full' }, native(null), 'full'],
  ])('%j on %j → %s', (env, host, policy) => {
    expect(resolveGraphemePolicy(env, host)).toBe(policy);
  });
});

describe('createGraphemeStableStdout', () => {
  it('writes the stable form and passes untouched chunks through as given', () => {
    const write = vi.fn(() => true);
    const target = { write, columns: 80 } as unknown as NodeJS.WriteStream;
    const stream = createGraphemeStableStdout(target);
    const done = vi.fn();
    stream.write('row ⚠️\n', done);
    expect(write).toHaveBeenLastCalledWith('row ⚠ \n', done);
    const bytes = Buffer.from('plain');
    stream.write(bytes);
    expect(write).toHaveBeenLastCalledWith(bytes);
    expect(stream.columns).toBe(80);
  });

  it('returns the target itself when disabled', () => {
    const target = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    expect(createGraphemeStableStdout(target, { enabled: false })).toBe(target);
  });
});
