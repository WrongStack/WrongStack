import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deployBunWorkspace } from '../../../../scripts/lib/deploy-bun-workspace.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Bun workspace deployment', () => {
  it('packs local workspace dependencies and installs them without contacting the registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrongstack-bun-deploy-proof-'));
    directories.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(root, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 3,
        configVersion: 1,
        workspaces: { '': { name: 'fixture' } },
        packages: {},
        overrides: {},
      }),
    );
    for (const name of ['app', 'dependency']) {
      const dir = join(root, 'packages', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: `@fixture/${name}`,
          version: '1.0.0',
          main: 'index.js',
          files: ['index.js'],
          ...(name === 'app' ? { dependencies: { '@fixture/dependency': 'workspace:*' } } : {}),
        }),
      );
      writeFileSync(
        join(dir, 'index.js'),
        name === 'app'
          ? "module.exports = require('@fixture/dependency');"
          : "module.exports = 'local workspace';",
      );
    }
    execFileSync(process.execPath, ['install', '--lockfile-only', '--ignore-scripts'], {
      cwd: root,
      stdio: 'inherit',
    });
    const result = deployBunWorkspace('@fixture/app', join(root, 'deployed'), root);
    directories.push(result.scratch);
    const pkg = JSON.parse(
      readFileSync(
        join(result.destination, 'node_modules/@fixture/dependency/package.json'),
        'utf8',
      ),
    );
    expect(pkg.version).toBe('1.0.0');
    expect(readFileSync(join(result.destination, 'index.js'), 'utf8')).toContain(
      '@fixture/dependency',
    );
  }, 30_000);
  it('rejects an unknown workspace package before staging anything', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrongstack-bun-deploy-unknown-'));
    directories.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
    expect(() => deployBunWorkspace('@fixture/missing', join(root, 'deploy'), root)).toThrow(
      'Unknown workspace package',
    );
  });
});

import { execFileSync } from 'node:child_process';
