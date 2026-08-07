import { describe, expect, it } from 'vitest';
import {
  assertBrowserUrlAllowed,
  parsePrivateOriginAllowlist,
  redactBrowserText,
  resolvePinnedBrowserTarget,
  safeBrowserUrl,
} from '../src/browser/security.js';

describe('browser security boundary', () => {
  it('allows public https URLs and removes sensitive URL components from output', async () => {
    await expect(
      assertBrowserUrlAllowed('https://example.com/path?q=secret#fragment', {
        allowPrivateHosts: false,
        navigation: true,
      }),
    ).resolves.toBeInstanceOf(URL);
    expect(safeBrowserUrl('https://user:pass@example.com/path?q=secret#fragment')).toBe(
      'https://example.com/path',
    );
  });

  it('blocks credentials, unsupported protocols, localhost, and private addresses', async () => {
    await expect(
      assertBrowserUrlAllowed('https://user:pass@example.com/', {
        allowPrivateHosts: false,
        navigation: true,
      }),
    ).rejects.toThrow(/credentials/);
    await expect(
      assertBrowserUrlAllowed('file:///etc/passwd', {
        allowPrivateHosts: false,
        navigation: true,
      }),
    ).rejects.toThrow(/unsupported protocol/);
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1/', {
        allowPrivateHosts: false,
        navigation: true,
      }),
    ).rejects.toThrow(/private|loopback/);
    await expect(
      assertBrowserUrlAllowed('http://localhost/', {
        allowPrivateHosts: false,
        navigation: true,
      }),
    ).rejects.toThrow(/localhost/);
  });

  it('allows private fixture hosts only through an explicit host option', async () => {
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:3000/', {
        allowPrivateHosts: true,
        navigation: true,
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('limits private access to an exact normalized origin', async () => {
    const allowedPrivateOrigins = parsePrivateOriginAllowlist('http://127.0.0.1:3000');
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:3000/path', {
        allowedPrivateOrigins,
        navigation: true,
      }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:3001/path', {
        allowedPrivateOrigins,
        navigation: true,
      }),
    ).rejects.toThrow(/private|loopback/);
  });

  it('rejects non-origin private allowlist entries', () => {
    expect(() => parsePrivateOriginAllowlist('http://127.0.0.1:3000/admin')).toThrow(/origin/);
  });

  it('tolerates surrounding quotes on allowlist entries', () => {
    // Windows setx / .env files routinely embed the quotes in the value;
    // rejecting them made every browser tool call throw on such machines.
    expect(parsePrivateOriginAllowlist('"http://127.0.0.1:3456"')).toEqual([
      'http://127.0.0.1:3456',
    ]);
    expect(parsePrivateOriginAllowlist('\'http://10.0.0.5:80\', "http://127.0.0.1:3000"')).toEqual([
      'http://10.0.0.5',
      'http://127.0.0.1:3000',
    ]);
  });

  it('pins one public DNS answer and rejects mixed public/private answers', async () => {
    const lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    await expect(
      resolvePinnedBrowserTarget('https://example.test/path', { lookup }),
    ).resolves.toMatchObject({ address: '203.0.113.10', family: 4 });

    await expect(
      resolvePinnedBrowserTarget('https://example.test/path', {
        lookup: async () => [
          { address: '203.0.113.10', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toThrow(/private address/);
  });

  it('redacts common console credential forms', () => {
    const redacted = redactBrowserText(
      'Authorization Bearer abc.def token=top-secret password=hunter2 api_key=key123',
    );
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('top-secret');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('key123');
  });
});
