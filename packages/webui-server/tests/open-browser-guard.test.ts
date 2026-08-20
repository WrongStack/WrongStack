import { describe, expect, it } from 'vitest';
import { browserOpenCommand, isSafeBrowserUrl } from '../src/server/open-browser.js';

/**
 * Regression for the OS-opener command injection found by the 2026-08-20
 * security-check audit.
 *
 * The win32 branch builds `cmd /c start "" <url>`, and the code comment claimed
 * the empty title slot made `&` "pass through intact". It does not: Node only
 * quotes a spawn argument that contains WHITESPACE, so a space-free URL reaches
 * cmd.exe with `&` as a live command separator. The sibling `shell-open.ts`
 * already enforced exactly this metacharacter set; this path never adopted it.
 */

describe('URLs carrying shell metacharacters are refused', () => {
  it.each([
    'https://example.com/?x=1&whoami',
    'https://example.com/|calc',
    'https://example.com/;id',
    'https://example.com/%USERPROFILE%',
    'https://example.com/`id`',
    'https://example.com/(sub)',
    'https://example.com/^caret',
    'https://example.com/\nsecond-line',
  ])('refuses %s', (url) => {
    expect(isSafeBrowserUrl(url)).toBe(false);
  });
});

describe('non-http(s) schemes are refused', () => {
  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'ms-msdt:/id',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '\\\\attacker\\share\\payload.exe',
    'not a url at all',
  ])('refuses %s', (url) => {
    expect(isSafeBrowserUrl(url)).toBe(false);
  });
});

describe('ordinary URLs still open', () => {
  it.each([
    'http://127.0.0.1:3456/',
    'https://localhost:3499/#/dashboard',
    'https://github.com/login/device',
    'https://example.com/path?a=1',
  ])('accepts %s', (url) => {
    expect(isSafeBrowserUrl(url)).toBe(true);
  });

  it('still builds the expected win32 invocation', () => {
    expect(browserOpenCommand('https://example.com/', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'https://example.com/'],
    });
  });

  it('still builds the expected darwin and linux invocations', () => {
    expect(browserOpenCommand('https://example.com/', 'darwin')).toEqual({
      command: 'open',
      args: ['https://example.com/'],
    });
    expect(browserOpenCommand('https://example.com/', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com/'],
    });
  });
});
