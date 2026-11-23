import { describe, expect, it } from 'vitest';
import { color, stripAnsi } from '../../src/index.js';

describe('color helpers', () => {
  it('produces strings (with or without escapes depending on TTY)', () => {
    const out = color.red('x');
    expect(typeof out).toBe('string');
    expect(out).toContain('x');
  });

  it('stripAnsi removes escapes', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[39m')).toBe('hello');
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('stripAnsi handles compound sequences', () => {
    expect(stripAnsi('\x1b[1;33;41mWARN\x1b[0m')).toBe('WARN');
  });

  it('strips OSC, DCS and two-character escapes', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x07click\x1b]8;;\x07')).toBe('click');
    expect(stripAnsi('\x1bP1;2;3qpayload\x1b\\text')).toBe('text');
    expect(stripAnsi('\x1bcreset')).toBe('reset');
  });

  it('leaves no escape introducer for an unterminated OSC body', () => {
    const out = stripAnsi('\x1b]8;;https://example.com\nnext');
    expect(out).not.toContain('\x1b');
    expect(out).toContain('next');
  });

  it('exposes all expected colour helpers', () => {
    const keys = [
      'reset',
      'bold',
      'dim',
      'italic',
      'underline',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'gray',
      'amber',
      'pink',
      'bgRed',
      'bgGreen',
    ] as const;
    for (const k of keys) {
      expect(typeof (color as Record<string, unknown>)[k]).toBe('function');
    }
  });
});
