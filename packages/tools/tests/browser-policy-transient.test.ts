import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  browserPrivateOrigins,
  setBrowserPrivateOrigin,
  withTransientPrivateOrigin,
} from '../src/browser/policy.js';

let root: string;
let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env['WRONGSTACK_HOME'];
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-policy-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-policy-root-'));
  process.env['WRONGSTACK_HOME'] = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = prevHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

describe('withTransientPrivateOrigin', () => {
  it('allows the origin only while the call runs, survives a policy save, and never persists', async () => {
    const live = browserPrivateOrigins(root);
    const origin = 'http://127.0.0.1:45123';
    await withTransientPrivateOrigin(root, origin, async () => {
      expect(live).toContain(origin);
      // A policy write mid-call rewrites the live array; the transient origin stays.
      await setBrowserPrivateOrigin(root, 'http://localhost:3000', true);
      expect(browserPrivateOrigins(root)).toEqual(
        expect.arrayContaining([origin, 'http://localhost:3000']),
      );
    });
    expect(browserPrivateOrigins(root)).not.toContain(origin);
    expect(browserPrivateOrigins(root)).toContain('http://localhost:3000');
    const policyFiles = await fs.readdir(home, { recursive: true });
    for (const rel of policyFiles.filter((f) => String(f).endsWith('browser-policy.json'))) {
      expect(await fs.readFile(path.join(home, String(rel)), 'utf8')).not.toContain('45123');
    }
  });

  it('removes the origin when the call throws', async () => {
    const origin = 'http://127.0.0.1:45124';
    await expect(
      withTransientPrivateOrigin(root, origin, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(browserPrivateOrigins(root)).not.toContain(origin);
  });

  it('canonicalizes uppercase or trailing-slash transient origins', async () => {
    await withTransientPrivateOrigin(root, 'HTTP://LOCALHOST:45125/', async () => {
      expect(browserPrivateOrigins(root)).toContain('http://localhost:45125');
      expect(browserPrivateOrigins(root)).not.toContain('HTTP://LOCALHOST:45125/');
    });
    expect(browserPrivateOrigins(root)).not.toContain('http://localhost:45125');
  });
});
