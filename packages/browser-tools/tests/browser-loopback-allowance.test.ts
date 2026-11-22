import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPrivateOrigins, setBrowserPrivateOrigin } from '../src/policy.js';
import { runBrowserPolicyCommand } from '../src/policy-command.js';
import {
  assertBrowserUrlAllowed,
  isPrivateOriginApproved,
  LOOPBACK_ALLOWANCE,
  networkAllowHint,
  parsePrivateOriginAllowlist,
  resolvePinnedBrowserTarget,
} from '../src/security.js';

let root: string;
beforeEach(async () => {
  vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', '');
  root = await mkdtemp(join(tmpdir(), 'browser-loopback-'));
  vi.stubEnv('WRONGSTACK_HOME', join(root, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('loopback allowance', () => {
  const loopback = [LOOPBACK_ALLOWANCE];

  it('approves every loopback host and port, and nothing else', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:3000/',
      'http://127.4.5.6:9/',
      'https://app.localhost:8443/',
      'http://[::1]:24678/',
      'http://[::ffff:127.0.0.1]:80/',
    ]) {
      expect(isPrivateOriginApproved(new URL(url), loopback), url).toBe(true);
    }
    for (const url of [
      'http://192.168.1.10:3000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[fd00::1]/',
      'http://localtest.me:3000/',
    ]) {
      expect(isPrivateOriginApproved(new URL(url), loopback), url).toBe(false);
    }
  });

  it('lets the browser guard through every local port once allowed', async () => {
    const opts = { allowedPrivateOrigins: loopback, navigation: true };
    await expect(assertBrowserUrlAllowed('http://127.0.0.1:5173/', opts)).resolves.toBeInstanceOf(
      URL,
    );
    await expect(assertBrowserUrlAllowed('http://localhost:8080/', opts)).resolves.toBeInstanceOf(
      URL,
    );
    await expect(assertBrowserUrlAllowed('http://192.168.0.2:8080/', opts)).rejects.toThrow(
      '/browser allow http://192.168.0.2:8080',
    );
  });

  it('suggests the loopback allowance only for loopback refusals', async () => {
    const opts = { allowedPrivateOrigins: [], navigation: true };
    await expect(assertBrowserUrlAllowed('http://127.0.0.1:5173/', opts)).rejects.toThrow(
      '/browser allow loopback',
    );
    const lan = await assertBrowserUrlAllowed('http://10.1.2.3/', opts).catch(
      (error: Error) => error,
    );
    expect(lan).toBeInstanceOf(Error);
    expect((lan as Error).message).toContain('/browser allow http://10.1.2.3');
    expect((lan as Error).message).not.toContain('/browser allow loopback');
  });

  it('pins an approved *.localhost name to loopback when the OS resolver does not know it (F1258)', async () => {
    // Windows getaddrinfo (and glibc without nss-myhostname) answer ENOTFOUND
    // for `app.localhost`; RFC 6761 makes every localhost name loopback.
    const enotfound = async (host: string) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    };
    await expect(
      resolvePinnedBrowserTarget('http://app.localhost:5173/', {
        allowedPrivateOrigins: loopback,
        lookup: enotfound,
      }),
    ).resolves.toMatchObject({
      address: '127.0.0.1',
      candidates: [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
    });
    // Unapproved localhost names and unknown public names still fail.
    await expect(
      resolvePinnedBrowserTarget('http://app.localhost:5173/', {
        allowedPrivateOrigins: [],
        lookup: enotfound,
      }),
    ).rejects.toThrow('blocked localhost target');
    await expect(
      resolvePinnedBrowserTarget('http://missing.example/', {
        allowedPrivateOrigins: loopback,
        lookup: enotfound,
      }),
    ).rejects.toThrow('DNS resolution failed');
  });

  it('pins a loopback-approved name only to loopback addresses (no rebinding)', async () => {
    const lookup = async () => [{ address: '10.0.0.5', family: 4 }];
    await expect(
      resolvePinnedBrowserTarget('http://dev.localhost:3000/', {
        allowedPrivateOrigins: loopback,
        lookup,
      }),
    ).rejects.toThrow('non-loopback');
    await expect(
      resolvePinnedBrowserTarget('http://dev.localhost:3000/', {
        allowedPrivateOrigins: loopback,
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).resolves.toMatchObject({ address: '127.0.0.1' });
    // A public name that resolves to loopback is the rebinding shape.
    await expect(
      resolvePinnedBrowserTarget('http://evil.example:3000/', {
        allowedPrivateOrigins: loopback,
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('private address');
  });

  it('offers the loopback allowance in fetch refusals for local hosts only', () => {
    expect(networkAllowHint(new URL('http://127.0.0.1:5173/'))).toContain(
      '/network allow loopback',
    );
    expect(networkAllowHint(new URL('http://10.0.0.9/'))).not.toContain('loopback');
  });

  it('parses the keyword from the environment allowlist', () => {
    expect(parsePrivateOriginAllowlist('Loopback, http://10.0.0.2:80')).toEqual([
      LOOPBACK_ALLOWANCE,
      'http://10.0.0.2',
    ]);
  });

  it('persists through /browser allow loopback and revokes with remove', async () => {
    expect(await runBrowserPolicyCommand(root, 'allow loopback')).toContain('policy saved');
    expect(browserPrivateOrigins(root)).toEqual([LOOPBACK_ALLOWANCE]);
    expect(await runBrowserPolicyCommand(root, 'remove loopback')).toContain('(none)');
    expect(browserPrivateOrigins(root)).toEqual([]);
  });
});

describe('policy file refresh', () => {
  it('picks up an allowance another process wrote, in the same live array', async () => {
    const live = browserPrivateOrigins(root);
    expect(live).toEqual([]);
    const dir = resolveWstackPaths({ projectRoot: root }).projectDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'browser-policy.json'),
      JSON.stringify({ privateOrigins: ['http://127.0.0.1:41789'] }),
    );
    const refreshed = browserPrivateOrigins(root);
    expect(refreshed).toBe(live);
    expect(live).toEqual(['http://127.0.0.1:41789']);
  });

  it('keeps an in-process allowance without re-reading on every call', async () => {
    await setBrowserPrivateOrigin(root, 'http://localhost:4100', true);
    expect(browserPrivateOrigins(root)).toEqual(['http://localhost:4100']);
  });
});
