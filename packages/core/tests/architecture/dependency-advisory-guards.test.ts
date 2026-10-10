import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readBunLock } from '../../../../scripts/lib/read-bun-lock.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');

describe('dependency advisory guards', () => {
  it('retains patched source-map-js and removes the sprintf-js chain without audit exemptions', async () => {
    const workspace = parse(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
    const packageNames = Object.values(readBunLock(path.join(root, 'bun.lock')).packages).map(
      (pkg) => pkg[0],
    );
    const versions = packageNames.filter((name) => name.startsWith('source-map-js@'));
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const [major = 0, minor = 0, patch = 0] = version
        .slice('source-map-js@'.length)
        .split('.')
        .map(Number);
      expect(major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 2)))).toBe(true);
    }
    expect(packageNames.some((name) => name.startsWith('sprintf-js@'))).toBe(false);
    for (const advisory of ['GHSA-68fv-2mgg-jv7q', 'GHSA-hp3w-g68c-fv3c']) {
      expect(workspace.auditConfig.ignoreGhsas).not.toContain(advisory);
    }
  });

  it('checks the installed downstream resolutions using metadata only', async () => {
    const desktop = createRequire(path.join(root, 'apps/desktop/package.json'));
    const builder = createRequire(desktop.resolve('electron-builder/package.json')).resolve(
      'app-builder-lib/package.json',
    );
    const get = createRequire(builder).resolve('@electron/get/package.json');
    const agent = createRequire(get).resolve('global-agent/package.json');
    const metadata = JSON.parse(await readFile(agent, 'utf8'));
    expect(metadata.version).toBe('4.1.3');
    expect(metadata.dependencies).not.toHaveProperty('roarr');
    expect(metadata.dependencies).not.toHaveProperty('sprintf-js');
    const tui = createRequire(path.join(root, 'packages/tui/package.json'));
    const jsdom = tui.resolve('jsdom/package.json');
    const cssTree = createRequire(jsdom).resolve('css-tree/package.json');
    const sourceMap = createRequire(cssTree).resolve('source-map-js/package.json');
    expect(JSON.parse(await readFile(sourceMap, 'utf8')).version).toBe('1.2.2');
  });
});
