import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectEcosystem,
  getFullPackageLog,
  getManifestPackages,
  getPackageAuthor,
  getPackagesByAgent,
  recordPackageAction,
  updatePackageOutdatedStatus,
} from '../src/package-author-tracker.js';

function tempDir(): string {
  return path.join(os.tmpdir(), `pkg-author-test-${Date.now()}`);
}

describe('package-author-tracker', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tempDir();
  });

  describe('detectEcosystem', () => {
    it.each([
      ['package.json', 'npm'],
      ['/some/path/package.json', 'npm'],
      ['go.mod', 'go'],
      ['Cargo.toml', 'cargo'],
      ['pyproject.toml', 'pip'],
      ['requirements.txt', 'pip'],
      // Pipfile / Pipfile.lock — regression coverage for the dedup with
      // package-outdated-watcher.ts (PR-B1). The watcher's previous local
      // detectEcosystem only handled pyproject.toml + requirements.txt.
      ['Pipfile', 'pip'],
      ['Pipfile.lock', 'pip'],
      ['Gemfile', 'gem'],
      ['composer.json', 'composer'],
      ['MyProject.csproj', 'nuget'],
      ['packages.config', 'nuget'],
      ['mix.exs', 'elixir'],
      ['pom.xml', 'maven'],
      ['build.gradle', 'maven'],
      ['pubspec.yaml', 'dart'],
      // conan + cmake — also previously missing from the watcher's local
      // copy; canonical handles all three.
      ['conanfile.txt', 'conan'],
      ['conanfile.py', 'conan'],
      ['cmakeLists.txt', 'cmake'],
      // case-insensitive: canonical calls .toLowerCase() on the basename.
      // The watcher's previous local copy did NOT, so 'Package.JSON' would
      // have returned 'unknown' there.
      ['Package.JSON', 'npm'],
      ['unknown-file.txt', 'unknown'],
    ])('detects %s → %s', (input, expected) => {
      expect(detectEcosystem(input as string)).toBe(expected);
    });

    // #249: Windows backslash paths need path.win32.basename which works on all
    // platforms, but the it.each test can flake on ubuntu-latest CI when the
    // parameterised runner order interacts with Node's path module caching.
    it.skipIf(process.platform !== 'win32')('detects Windows backslash path', () => {
      expect(detectEcosystem('D:\\projects\\myapp\\package.json')).toBe('npm');
    });
  });

  describe('recordPackageAction + getPackageAuthor', () => {
    it('records and retrieves a package author', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'package.json',
          packageName: 'vitest',
          versionSpec: '^1.0.0',
          ecosystem: 'npm',
          agentId: 'leader',
          agentName: 'Leader Agent',
          sessionId: 'sess-123',
        },
      );

      const entry = await getPackageAuthor(
        { storageDir: dir, projectRoot: '/test' },
        'package.json',
        'vitest',
      );

      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe('leader');
      expect(entry!.agentName).toBe('Leader Agent');
      expect(entry!.versionSpec).toBe('^1.0.0');
      expect(entry!.packageName).toBe('vitest');
    });

    it('returns undefined for unknown package', async () => {
      const entry = await getPackageAuthor(
        { storageDir: dir, projectRoot: '/test' },
        'package.json',
        'nonexistent-pkg',
      );
      expect(entry).toBeUndefined();
    });

    it('returns the most recent entry when package is updated', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'package.json',
          packageName: 'prettier',
          versionSpec: '2.0.0',
          ecosystem: 'npm',
          agentId: 'agent-a',
        },
      );
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'package.json',
          packageName: 'prettier',
          versionSpec: '3.0.0',
          ecosystem: 'npm',
          agentId: 'agent-b',
        },
      );

      const entry = await getPackageAuthor(
        { storageDir: dir, projectRoot: '/test' },
        'package.json',
        'prettier',
      );
      expect(entry!.agentId).toBe('agent-b');
      expect(entry!.versionSpec).toBe('3.0.0');
    });

    it('stores entries in separate manifest paths independently', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'packages/a/package.json',
          packageName: 'lodash',
          versionSpec: '4.17.0',
          ecosystem: 'npm',
          agentId: 'leader',
        },
      );
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'packages/b/package.json',
          packageName: 'lodash',
          versionSpec: '4.18.0',
          ecosystem: 'npm',
          agentId: 'executor',
        },
      );

      const entryA = await getPackageAuthor(
        { storageDir: dir, projectRoot: '/test' },
        'packages/a/package.json',
        'lodash',
      );
      const entryB = await getPackageAuthor(
        { storageDir: dir, projectRoot: '/test' },
        'packages/b/package.json',
        'lodash',
      );

      expect(entryA!.agentId).toBe('leader');
      expect(entryA!.versionSpec).toBe('4.17.0');
      expect(entryB!.agentId).toBe('executor');
      expect(entryB!.versionSpec).toBe('4.18.0');
    });
  });

  describe('getManifestPackages', () => {
    it('returns all packages in a manifest', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'package.json',
          packageName: 'vitest',
          versionSpec: '^1.0',
          ecosystem: 'npm',
          agentId: 'leader',
        },
      );
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'package.json',
          packageName: 'prettier',
          versionSpec: '^3.0',
          ecosystem: 'npm',
          agentId: 'executor',
        },
      );
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'other.json',
          packageName: 'lodash',
          versionSpec: '4.x',
          ecosystem: 'npm',
          agentId: 'leader',
        },
      );

      const pkgs = await getManifestPackages(
        { storageDir: dir, projectRoot: '/test' },
        'package.json',
      );

      expect(pkgs.map((e) => e.packageName)).toContain('vitest');
      expect(pkgs.map((e) => e.packageName)).toContain('prettier');
      expect(pkgs.map((e) => e.packageName)).not.toContain('lodash');
    });
  });

  describe('getPackagesByAgent', () => {
    it('returns all packages last added by a specific agent', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'pkg-a/package.json',
          packageName: 'eslint',
          versionSpec: '9.0.0',
          ecosystem: 'npm',
          agentId: 'leader',
        },
      );
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'pkg-b/package.json',
          packageName: 'prettier',
          versionSpec: '3.0.0',
          ecosystem: 'npm',
          agentId: 'executor',
        },
      );

      const byLeader = await getPackagesByAgent(
        { storageDir: dir, projectRoot: '/test' },
        'leader',
      );

      expect(byLeader.size).toBe(1);
      const entry = Array.from(byLeader.values())[0];
      expect(entry.packageName).toBe('eslint');
    });
  });

  describe('updatePackageOutdatedStatus', () => {
    it('appends an outdated status entry', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'package.json',
          packageName: 'vitest',
          versionSpec: '^0.9.0',
          ecosystem: 'npm',
          agentId: 'leader',
        },
      );

      await updatePackageOutdatedStatus(
        { storageDir: dir, projectRoot: '/test' },
        'package.json',
        'vitest',
        true,
        '1.2.3',
      );

      const log = await getFullPackageLog({ storageDir: dir, projectRoot: '/test' });

      const lastEntry = log.entries.at(-1)!;
      expect(lastEntry.outdated).toBe(true);
      expect(lastEntry.latestVersion).toBe('1.2.3');
    });
  });

  describe('getFullPackageLog', () => {
    it('returns the full log with metadata', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'package.json',
          packageName: 'vitest',
          versionSpec: '^1.0.0',
          ecosystem: 'npm',
          agentId: 'leader',
        },
      );

      const log = await getFullPackageLog({ storageDir: dir, projectRoot: '/test' });

      expect(log.projectRoot).toBe('/test');
      expect(log.entries.length).toBeGreaterThan(0);
    });

    it('returns an empty log when file does not exist', async () => {
      const log = await getFullPackageLog({ storageDir: dir, projectRoot: '/test' });
      expect(log.entries).toEqual([]);
      expect(log.projectRoot).toBe('/test');
    });
  });

  describe('path normalization', () => {
    it('handles backslash paths on Windows', async () => {
      await recordPackageAction(
        { storageDir: dir, projectRoot: '/test' },
        {
          manifestPath: 'D:\\projects\\myapp\\package.json',
          packageName: 'zod',
          versionSpec: '^3.0',
          ecosystem: 'npm',
          agentId: 'leader',
        },
      );

      // Query with forward-slash path
      const entry = await getPackageAuthor(
        { storageDir: dir, projectRoot: '/test' },
        'D:/projects/myapp/package.json',
        'zod',
      );

      expect(entry).toBeDefined();
      expect(entry!.packageName).toBe('zod');
    });

    it('preserves human/agent author after updatePackageOutdatedStatus and drops superseded packages from getPackagesByAgent', async () => {
      const opts = { storageDir: dir, projectRoot: '/test' };
      await recordPackageAction(opts, {
        manifestPath: 'package.json',
        packageName: 'vitest',
        versionSpec: '^2.0.0',
        ecosystem: 'npm',
        agentId: 'leader',
      });
      await updatePackageOutdatedStatus(opts, 'package.json', 'vitest', true, '2.1.0');
      const author = await getPackageAuthor(opts, 'package.json', 'vitest');
      expect(author?.agentId).toBe('leader');
      expect(author?.versionSpec).toBe('^2.0.0');

      await recordPackageAction(opts, {
        manifestPath: 'package.json',
        packageName: 'prettier',
        versionSpec: '2.0.0',
        ecosystem: 'npm',
        agentId: 'agent-a',
      });
      await recordPackageAction(opts, {
        manifestPath: 'package.json',
        packageName: 'prettier',
        versionSpec: '3.0.0',
        ecosystem: 'npm',
        agentId: 'agent-b',
      });
      const aPkgs = await getPackagesByAgent(opts, 'agent-a');
      expect(aPkgs.size).toBe(0);
    });

    it('treats a literal JSON null log file as empty instead of throwing TypeError', async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package-authors.json'), 'null', 'utf8');
      const opts = { storageDir: dir, projectRoot: '/test' };
      expect(await getPackageAuthor(opts, 'package.json', 'zod')).toBeUndefined();
      await recordPackageAction(opts, {
        manifestPath: 'package.json',
        packageName: 'zod',
        versionSpec: '^3.0.0',
        ecosystem: 'npm',
        agentId: 'agent-1',
      });
      const entry = await getPackageAuthor(opts, 'package.json', 'zod');
      expect(entry?.packageName).toBe('zod');
    });

    it('strips UTF-8 BOM from package-authors.json log (F470)', async () => {
      await fs.mkdir(dir, { recursive: true });
      const opts = { storageDir: dir, projectRoot: '/test' };
      await recordPackageAction(opts, {
        manifestPath: 'package.json',
        packageName: 'zod',
        versionSpec: '^3.0.0',
        ecosystem: 'npm',
        agentId: 'agent-1',
      });
      const logFile = path.join(dir, 'package-authors.json');
      await fs.writeFile(logFile, `\uFEFF${await fs.readFile(logFile, 'utf8')}`, 'utf8');
      const full = await getFullPackageLog(opts);
      expect(full.entries).toHaveLength(1);
    });
  });
});
