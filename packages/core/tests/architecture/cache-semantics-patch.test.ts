import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readBunLock } from '../../../../scripts/lib/read-bun-lock.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const advisory = 'GHSA-ch52-4w7c-c8xp';
const dependency = 'http-cache-semantics@4.2.0';
describe('cache security advisory exception is tied to an active fix', () => {
  it('requires a pinned patch and refuses any unpatched cache-policy version', async () => {
    const workspace = parse(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
    const lock = readBunLock(path.join(root, 'bun.lock'));
    expect(lock).toBeDefined();
    expect(workspace.auditConfig.ignoreGhsas).toContain(advisory);
    expect(workspace.patchedDependencies[dependency]).toBe(
      'patches/http-cache-semantics@4.2.0.patch',
    );
    const patch = await readFile(
      path.join(root, workspace.patchedDependencies[dependency]),
      'utf8',
    );
    expect(patch).toContain('+            if (this.maxAge() === 0) {');
    expect(patch).toContain('+                return this._evaluateRequestMissResult(req);');
    const hash = lock.patchedDependencies[dependency];
    expect(hash).toEqual(expect.any(String));
    const snapshots = Object.values(lock.packages).filter((pkg) =>
      pkg[0].startsWith('http-cache-semantics@'),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) expect(snapshot[0]).toBe(dependency);
  });
  it('checks the actual downstream resolution without executing dependency code', async () => {
    const require = createRequire(path.join(root, 'apps/desktop/package.json'));
    const builder = createRequire(require.resolve('electron-builder/package.json')).resolve(
      'app-builder-lib/package.json',
    );
    const get = createRequire(builder).resolve('@electron/get/package.json');
    const got = createRequire(get).resolve('got/package.json');
    const cache = createRequire(got).resolve('cacheable-request/package.json');
    const policy = createRequire(cache).resolve('http-cache-semantics');
    const source = await readFile(policy, 'utf8');
    expect(source).toContain(advisory);
    expect(source).toMatch(
      /if \(this\.stale\(\)\) \{\s*\/\/[^\n]+\n\s*if \(this\.maxAge\(\) === 0\) \{\s*return this\._evaluateRequestMissResult\(req\);/,
    );
  });
});
