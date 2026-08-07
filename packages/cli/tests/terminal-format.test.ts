import { afterEach, describe, expect, it } from 'vitest';
import { writeHqStartupInfo } from '../src/hq-server/startup.js';
import { terminalFormattingEnabled, terminalLink, terminalText } from '../src/terminal-format.js';

const originalNoColor = process.env.NO_COLOR;
const originalForceColor = process.env.FORCE_COLOR;

afterEach(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
});

describe('terminal formatting', () => {
  it('uses NO_COLOR before FORCE_COLOR and TTY capability', { timeout: 5000 }, () => {
    expect(terminalFormattingEnabled({ NO_COLOR: '', FORCE_COLOR: '1' }, true)).toBe(false);
    expect(terminalFormattingEnabled({ FORCE_COLOR: '0' }, false)).toBe(true);
    expect(terminalFormattingEnabled({}, true)).toBe(true);
    expect(terminalFormattingEnabled({}, false)).toBe(false);
  });

  it('preserves plain text and URLs when formatting is disabled', { timeout: 5000 }, () => {
    expect(terminalText('WebUI', 'success', { bold: true, enabled: false })).toBe('WebUI');
    expect(terminalLink('http://127.0.0.1:4040', { enabled: false })).toBe('http://127.0.0.1:4040');
  });

  it('renders semantic color and an OSC 8 hyperlink when enabled', { timeout: 5000 }, () => {
    expect(terminalText('HQ', 'success', { bold: true, enabled: true })).toBe(
      '\u001B[1m\u001B[32mHQ\u001B[0m',
    );
    expect(terminalLink('http://127.0.0.1:4040', { enabled: true })).toBe(
      '\u001B]8;;http://127.0.0.1:4040\u001B\\\u001B[36mhttp://127.0.0.1:4040\u001B[0m\u001B]8;;\u001B\\',
    );
  });

  it('wires plain and clickable colored links into the HQ startup banner', {
    timeout: 5000,
  }, () => {
    const writeBanner = (): string => {
      const lines: string[] = [];
      writeHqStartupInfo((line) => lines.push(line), { host: '127.0.0.1', port: 3210 });
      return lines.join('');
    };

    process.env.NO_COLOR = '1';
    delete process.env.FORCE_COLOR;
    const plain = writeBanner();
    expect(plain).toContain('WrongStack HQ listening on http://127.0.0.1:3210');
    expect(plain).not.toContain('\u001B');

    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    const formatted = writeBanner();
    expect(formatted).toContain('\u001B[35mWrongStack HQ\u001B[0m');
    expect(formatted).toContain('\u001B]8;;http://127.0.0.1:3210/\u001B\\');
    expect(formatted).toContain('\u001B[36mhttp://127.0.0.1:3210/\u001B[0m');
  });
});
