import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CppAdapter } from '../../src/adapters/cpp.js';
import { DartAdapter } from '../../src/adapters/dart.js';
import { DotNetAdapter } from '../../src/adapters/dotnet.js';
import { ElixirAdapter } from '../../src/adapters/elixir.js';
import { MavenAdapter } from '../../src/adapters/maven.js';
import { PhpAdapter } from '../../src/adapters/php.js';
import { RubyAdapter } from '../../src/adapters/ruby.js';
import { workspaceId } from '../../src/discovery/index.js';
import { parsePurlEcosystem } from '../../src/registry/purl.js';
import type { Workspace } from '../../src/types.js';

function mkWorkspace(
  ecosystem: Workspace['ecosystem'],
  files: Record<string, string>,
  manifestFilter?: (f: string) => boolean,
): { dir: string; ws: Workspace } {
  const dir = join(
    tmpdir(),
    `ts-${ecosystem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  // Adapters that read from workspace.manifests directly (dart/php/ruby/cpp/elixir/maven)
  // expect absolute paths. Adapters that resolve via workspaceRoot + join (rust/npm/go/python)
  // also work with absolute paths since join(root, abs) is abs on POSIX/Windows resolve.
  const allFiles = Object.keys(files);
  const manifests = manifestFilter
    ? allFiles.filter(manifestFilter)
    : allFiles.filter((f) => !f.includes('.lock') && !f.includes('project.assets'));
  const lockfiles = allFiles.filter((f) => f.includes('.lock') || f.includes('project.assets'));
  return {
    dir,
    ws: {
      id: workspaceId('', ecosystem),
      relativeRoot: dir,
      ecosystem,
      manifests: manifests.map((f) => join(dir, f)),
      lockfiles: lockfiles.map((f) => join(dir, f)),
      confidence: 0.9,
      coverage: 'full',
    },
  };
}

function withCleanup<T>(fn: (dir: string) => Promise<T>, dir: string): Promise<T> {
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ── Dart adapter ──────────────────────────────────────────────────────

describe('DartAdapter', () => {
  const PUBSPEC = [
    'name: my_app',
    'environment:',
    '  sdk: ">=3.0.0 <4.0.0"',
    'dependencies:',
    '  http: ^1.2.0',
    '  flutter:',
    '    sdk: flutter',
    'dev_dependencies:',
    '  test: ^1.24.0',
  ].join('\n');
  const PUBSPEC_LOCK = [
    'packages:',
    '  http:',
    '    version: "1.2.2"',
    '  test:',
    '    version: "1.25.0"',
  ].join('\n');

  it('extracts runtime and dev dependencies from pubspec.yaml', async () => {
    const { dir, ws } = mkWorkspace('dart', { 'pubspec.yaml': PUBSPEC });
    await withCleanup(async () => {
      const deps = await new DartAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('http');
      expect(names).toContain('test');
      expect(deps.find((d) => d.name === 'http')?.scope).toBe('runtime');
      expect(deps.find((d) => d.name === 'test')?.scope).toBe('development');
    }, dir);
  });

  it('reads locked versions from pubspec.lock', async () => {
    const { dir, ws } = mkWorkspace('dart', {
      'pubspec.yaml': PUBSPEC,
      'pubspec.lock': PUBSPEC_LOCK,
    });
    await withCleanup(async () => {
      const deps = await new DartAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'http')?.locked).toBe('1.2.2');
    }, dir);
  });

  it('skips sdk: flutter dependencies', async () => {
    const { dir, ws } = mkWorkspace('dart', { 'pubspec.yaml': PUBSPEC });
    await withCleanup(async () => {
      const deps = await new DartAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'flutter')).toBeUndefined();
    }, dir);
  });

  it('emits purls with the canonical pub type that parsePurlEcosystem resolves', async () => {
    const { dir, ws } = mkWorkspace('dart', {
      'pubspec.yaml': PUBSPEC,
      'pubspec.lock': PUBSPEC_LOCK,
    });
    await withCleanup(async () => {
      const deps = await new DartAdapter().inventory(ws, {});
      const http = deps.find((d) => d.name === 'http');
      expect(http!.purl).toMatch(/^pkg:pub\//);
      // Regression (round r20): the adapter used to emit `pkg:dart/…` — a
      // purl type this package's own identity resolver cannot resolve, so
      // SBOM identities and OSV advisory queries silently failed.
      expect(parsePurlEcosystem(http!.purl!)).toEqual({
        ecosystem: 'dart',
        name: 'http',
        version: '1.2.2',
      });
    }, dir);
  });

  // A constraint written anywhere but inline (bare `name:`, the block `version:`
  // key, a flow mapping, or a custom-host mapping) used to leave the parser's
  // `*` placeholder in place, which the adapter then discarded as if it were an
  // SDK entry — the dependency disappeared from the inventory.
  it('inventories bare, map-form and hosted declarations', async () => {
    const PUBSPEC_FORMS = [
      'name: my_app',
      'dependencies:',
      '  http: ^1.2.0',
      '  collection:',
      '  archive:',
      '    version: ^3.4.0',
      '  intl: {version: ^0.19.0}',
      '  private_pkg:',
      '    hosted: https://pub.example.com',
      '    version: ^2.0.0',
      '  flutter:',
      '    sdk: flutter',
      'dev_dependencies:',
      '  test: ^1.24.0',
    ].join('\n');
    const LOCK_FORMS = [
      'packages:',
      '  http:',
      '    version: "1.2.2"',
      '  collection:',
      '    version: "1.19.0"',
      '  archive:',
      '    version: "3.6.1"',
      '  intl:',
      '    version: "0.19.0"',
      '  private_pkg:',
      '    version: "2.0.1"',
      '  test:',
      '    version: "1.25.0"',
    ].join('\n');
    const { dir, ws } = mkWorkspace('dart', {
      'pubspec.yaml': PUBSPEC_FORMS,
      'pubspec.lock': LOCK_FORMS,
    });
    await withCleanup(async () => {
      const deps = await new DartAdapter().inventory(ws, {});
      expect(deps.map((d) => d.name).sort()).toEqual([
        'archive',
        'collection',
        'http',
        'intl',
        'private_pkg',
        'test',
      ]);
      expect(deps.find((d) => d.name === 'archive')).toMatchObject({
        requested: '^3.4.0',
        locked: '3.6.1',
      });
      expect(deps.find((d) => d.name === 'intl')?.requested).toBe('^0.19.0');
      expect(deps.find((d) => d.name === 'private_pkg')).toMatchObject({
        requested: '^2.0.0',
        locked: '2.0.1',
      });
      // A bare declaration reports no requested version and no invented `@*`.
      expect(deps.find((d) => d.name === 'collection')?.requested).toBeUndefined();
      expect(deps.find((d) => d.name === 'collection')?.locked).toBe('1.19.0');
      expect(deps.every((d) => !(d.purl ?? '').includes('@*'))).toBe(true);
      // SDK-provided packages stay excluded.
      expect(deps.find((d) => d.name === 'flutter')).toBeUndefined();
    }, dir);
  });

  it('has manifest evidence on every dep', async () => {
    const { dir, ws } = mkWorkspace('dart', { 'pubspec.yaml': PUBSPEC });
    await withCleanup(async () => {
      const deps = await new DartAdapter().inventory(ws, {});
      for (const d of deps) expect(d.evidence.some((e) => e.kind === 'manifest')).toBe(true);
    }, dir);
  });

  it('returns [] when no pubspec.yaml is found', async () => {
    const { dir, ws } = mkWorkspace('dart', {});
    await withCleanup(async () => {
      expect(await new DartAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });
});

// ── PHP adapter ───────────────────────────────────────────────────────

describe('PhpAdapter', () => {
  const COMPOSER_JSON = JSON.stringify({
    require: { 'monolog/monolog': '^3.0', 'ext-json': '*' },
    'require-dev': { 'phpunit/phpunit': '^10.0' },
  });
  const COMPOSER_LOCK = JSON.stringify({
    packages: [{ name: 'monolog/monolog', version: '3.5.0' }],
    'packages-dev': [{ name: 'phpunit/phpunit', version: '10.5.0' }],
  });

  it('extracts runtime and dev dependencies from composer.json', async () => {
    const { dir, ws } = mkWorkspace('php', { 'composer.json': COMPOSER_JSON });
    await withCleanup(async () => {
      const deps = await new PhpAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('monolog/monolog');
      expect(names).toContain('phpunit/phpunit');
      expect(deps.find((d) => d.name === 'monolog/monolog')?.scope).toBe('runtime');
      expect(deps.find((d) => d.name === 'phpunit/phpunit')?.scope).toBe('development');
    }, dir);
  });

  it('reads locked versions from composer.lock', async () => {
    const { dir, ws } = mkWorkspace('php', {
      'composer.json': COMPOSER_JSON,
      'composer.lock': COMPOSER_LOCK,
    });
    await withCleanup(async () => {
      const deps = await new PhpAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'monolog/monolog')?.locked).toBe('3.5.0');
    }, dir);
  });

  it('emits purls with the canonical composer type that parsePurlEcosystem resolves', async () => {
    const { dir, ws } = mkWorkspace('php', {
      'composer.json': COMPOSER_JSON,
      'composer.lock': COMPOSER_LOCK,
    });
    await withCleanup(async () => {
      const deps = await new PhpAdapter().inventory(ws, {});
      const monolog = deps.find((d) => d.name === 'monolog/monolog');
      expect(monolog!.purl).toMatch(/^pkg:composer\//);
      // Regression (round r20): the adapter used to emit
      // `pkg:php/monolog%2Fmonolog@3.5.0` — a purl type this package's own
      // identity resolver cannot resolve. The canonical form splits the
      // composer vendor/package into namespace/name.
      expect(parsePurlEcosystem(monolog!.purl!)).toEqual({
        ecosystem: 'php',
        name: 'monolog/monolog',
        version: '3.5.0',
      });
    }, dir);
  });

  it('does not inventory Composer platform requirements as packages', async () => {
    const { dir, ws } = mkWorkspace('php', {
      'composer.json': JSON.stringify({
        require: {
          php: '>=8.2',
          'ext-json': '*',
          'lib-openssl': '*',
          'composer-runtime-api': '^2.2',
          'monolog/monolog': '^3.0',
          // Vendor-prefixed name: a real package, not a platform package.
          'composer/composer': '^2.7',
        },
        'require-dev': { 'ext-xdebug': '*', 'phpunit/phpunit': '^10.0' },
      }),
      'composer.lock': JSON.stringify({
        packages: [
          { name: 'monolog/monolog', version: '3.5.0' },
          { name: 'composer/composer', version: '2.7.7' },
        ],
        'packages-dev': [{ name: 'phpunit/phpunit', version: '10.5.0' }],
        platform: { php: '>=8.2', 'ext-json': '*' },
        'platform-dev': { 'ext-xdebug': '*' },
      }),
    });
    await withCleanup(async () => {
      const deps = await new PhpAdapter().inventory(ws, {});
      expect(deps.map((d) => d.name).sort()).toEqual([
        'composer/composer',
        'monolog/monolog',
        'phpunit/phpunit',
      ]);
      for (const platform of [
        'php',
        'ext-json',
        'ext-xdebug',
        'lib-openssl',
        'composer-runtime-api',
      ]) {
        expect(deps.find((d) => d.name === platform)).toBeUndefined();
      }
      // Platform requirements never resolve to a lockfile package.
      expect(deps.filter((d) => d.locked === undefined)).toEqual([]);
    }, dir);
  });

  it('classifies path and git specs correctly', async () => {
    const cj = JSON.stringify({
      require: {
        'local/pkg': 'path:/some/local',
        'git/pkg': 'git@github.com:org/repo.git',
        'normal/pkg': '^1.0',
      },
    });
    const { dir, ws } = mkWorkspace('php', { 'composer.json': cj });
    await withCleanup(async () => {
      const deps = await new PhpAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'local/pkg')?.status).toBe('local_path');
      expect(deps.find((d) => d.name === 'local/pkg')?.sourceType).toBe('path');
      expect(deps.find((d) => d.name === 'git/pkg')?.status).toBe('git_dependency');
      expect(deps.find((d) => d.name === 'git/pkg')?.sourceType).toBe('git');
      expect(deps.find((d) => d.name === 'normal/pkg')?.status).toBe('current');
      expect(deps.find((d) => d.name === 'normal/pkg')?.sourceType).toBe('registry');
    }, dir);
  });

  it('returns [] when no composer.json is found', async () => {
    const { dir, ws } = mkWorkspace('php', {});
    await withCleanup(async () => {
      expect(await new PhpAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });
});

// ── .NET adapter ──────────────────────────────────────────────────────

describe('DotNetAdapter', () => {
  const CSPROJ = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <ItemGroup>',
    '    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
    '    <PackageReference Include="Serilog" Version="4.2.0">',
    '      <PrivateAssets>all</PrivateAssets>',
    '    </PackageReference>',
    '    <PackageReference Include="Microsoft.AspNetCore.App" />',
    '  </ItemGroup>',
    '</Project>',
  ].join('\n');
  const ASSETS = JSON.stringify({
    libraries: {
      'Newtonsoft.Json/13.0.3': { type: 'package' },
      'Serilog/4.2.0': { type: 'package' },
    },
  });

  it('extracts PackageReferences from .csproj', async () => {
    const { dir, ws } = mkWorkspace('dotnet', { 'App.csproj': CSPROJ });
    await withCleanup(async () => {
      const deps = await new DotNetAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('Newtonsoft.Json');
      expect(names).toContain('Serilog');
      expect(names).toContain('Microsoft.AspNetCore.App');
    }, dir);
  });

  it('reads locked versions from project.assets.json', async () => {
    const { dir, ws } = mkWorkspace('dotnet', {
      'App.csproj': CSPROJ,
      'project.assets.json': ASSETS,
    });
    await withCleanup(async () => {
      const deps = await new DotNetAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'Newtonsoft.Json')?.locked).toBe('13.0.3');
    }, dir);
  });

  // NuGet writes the restore graph to <project>/obj/project.assets.json. These
  // fixtures resolve a version DIFFERENT from the declaration, so the assertion
  // can only pass when the graph was actually read (the older fixture above
  // declares the same version and cannot tell the read from the fallback).
  const ASSETS_SDK = JSON.stringify({
    libraries: { 'Newtonsoft.Json/13.0.3': { type: 'package' } },
  });

  function writeRestoreGraph(dir: string): string {
    mkdirSync(join(dir, 'obj'), { recursive: true });
    const graphPath = join(dir, 'obj', 'project.assets.json');
    writeFileSync(graphPath, ASSETS_SDK);
    return graphPath;
  }

  it('reads the restore graph from the SDK location obj/project.assets.json', async () => {
    const { dir, ws } = mkWorkspace('dotnet', { 'App.csproj': CSPROJ });
    await withCleanup(async () => {
      const graphPath = writeRestoreGraph(dir);
      const deps = await new DotNetAdapter().inventory({ ...ws, lockfiles: [graphPath] }, {});
      const dep = deps.find((d) => d.name === 'Newtonsoft.Json');
      expect(dep).toMatchObject({
        requested: '13.0.3',
        locked: '13.0.3',
        purl: 'pkg:nuget/Newtonsoft.Json@13.0.3',
      });
      expect(dep?.evidence.some((e) => e.kind === 'lockfile')).toBe(true);
    }, dir);
  });

  it('reports the resolved version instead of a floating declaration', async () => {
    const CSProj_FLOATING = CSPROJ.replace('Version="13.0.3"', 'Version="13.*"');
    const { dir, ws } = mkWorkspace('dotnet', { 'App.csproj': CSProj_FLOATING });
    await withCleanup(async () => {
      writeRestoreGraph(dir);
      const deps = await new DotNetAdapter().inventory(ws, {});
      const dep = deps.find((d) => d.name === 'Newtonsoft.Json');
      expect(dep).toMatchObject({
        requested: '13.*',
        locked: '13.0.3',
        purl: 'pkg:nuget/Newtonsoft.Json@13.0.3',
      });
    }, dir);
  });

  // The test above resolves the float via the restore graph. This is the other
  // half: with NO graph (a fresh clone, or CI analysing a source tree before
  // `dotnet restore`) the `|| ref.version` fallback fired and reported the
  // CONSTRAINT as the resolved version — `pkg:nuget/Newtonsoft.Json@13.*`, a
  // glob where an identity belongs, unmatchable by any advisory lookup.
  it('does not report a floating declaration as locked when no restore graph exists', async () => {
    const CSProj_FLOATING = CSPROJ.replace('Version="13.0.3"', 'Version="13.*"');
    const { dir, ws } = mkWorkspace('dotnet', { 'App.csproj': CSProj_FLOATING });
    await withCleanup(async () => {
      const deps = await new DotNetAdapter().inventory(ws, {});
      const dep = deps.find((d) => d.name === 'Newtonsoft.Json');
      // Nothing resolved it, so there is no locked version — and no glob in the
      // purl. The declaration is still available as `requested`.
      expect(dep?.locked).toBeUndefined();
      expect(dep?.purl).toBe('pkg:nuget/Newtonsoft.Json');
      expect(dep?.requested).toBe('13.*');
    }, dir);
  });

  it('does not report a range declaration as locked when no restore graph exists', async () => {
    const { dir, ws } = mkWorkspace('dotnet', {
      'App.csproj': CSPROJ.replace('Version="13.0.3"', 'Version="[5.0.0,6.0.0)"'),
    });
    await withCleanup(async () => {
      const deps = await new DotNetAdapter().inventory(ws, {});
      const dep = deps.find((d) => d.name === 'Newtonsoft.Json');
      expect(dep?.locked).toBeUndefined();
      expect(dep?.purl).not.toContain('[');
      expect(dep?.requested).toBe('[5.0.0,6.0.0)');
    }, dir);
  });

  // A CONCRETE declaration is still a usable stand-in with no graph, so the
  // fix must not empty out every versionless-restore inventory.
  it('still reports a concrete declaration as locked when no restore graph exists', async () => {
    const { dir, ws } = mkWorkspace('dotnet', { 'App.csproj': CSPROJ });
    await withCleanup(async () => {
      const deps = await new DotNetAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'Newtonsoft.Json')).toMatchObject({
        locked: '13.0.3',
        purl: 'pkg:nuget/Newtonsoft.Json@13.0.3',
      });
    }, dir);
  });

  it('returns [] when no .csproj is found', async () => {
    const { dir, ws } = mkWorkspace('dotnet', {});
    await withCleanup(async () => {
      expect(await new DotNetAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });

  it('emits purls with the canonical nuget type that parsePurlEcosystem resolves', async () => {
    const { dir, ws } = mkWorkspace('dotnet', { 'App.csproj': CSPROJ });
    await withCleanup(async () => {
      const deps = await new DotNetAdapter().inventory(ws, {});
      const dep = deps.find((d) => d.name === 'Newtonsoft.Json');
      expect(dep!.purl).toMatch(/^pkg:nuget\//);
      // Regression (round r20): the adapter used to emit `pkg:dotnet/…` — a
      // purl type this package's own identity resolver cannot resolve, so
      // SBOM identities and OSV advisory queries silently failed.
      expect(parsePurlEcosystem(dep!.purl!)).toEqual({
        ecosystem: 'dotnet',
        name: 'Newtonsoft.Json',
        version: '13.0.3',
      });
    }, dir);
  });
});

// ── Ruby adapter ──────────────────────────────────────────────────────

describe('RubyAdapter', () => {
  const GEMFILE = [
    "source 'https://rubygems.org'",
    "gem 'rails', '7.1.0'",
    "gem 'puma'",
    "gem 'redis', '~> 5.0'",
  ].join('\n');
  const GEMFILE_LOCK = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    puma (6.4.2)',
    '    redis (5.2.0)',
    '    rails (7.1.0)',
  ].join('\n');

  it('extracts gems from Gemfile', async () => {
    const { dir, ws } = mkWorkspace('ruby', { Gemfile: GEMFILE });
    await withCleanup(async () => {
      const deps = await new RubyAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('puma');
      expect(names).toContain('redis');
      expect(names).toContain('rails');
      expect(deps.find((d) => d.name === 'rails')?.requested).toBe('7.1.0');
    }, dir);
  });

  it('reads locked versions from Gemfile.lock', async () => {
    const { dir, ws } = mkWorkspace('ruby', { Gemfile: GEMFILE, 'Gemfile.lock': GEMFILE_LOCK });
    await withCleanup(async () => {
      const deps = await new RubyAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'puma')?.locked).toBe('6.4.2');
      const rails = deps.find((d) => d.name === 'rails');
      expect(rails?.locked).toBe('7.1.0');
      expect(rails?.purl).toBe('pkg:gem/rails@7.1.0');
    }, dir);
  });

  // Comments are not declarations, and an inline comment is not part of the
  // declaration it trails.
  const GEMFILE_WITH_COMMENTS = [
    "source 'https://rubygems.org'",
    "gem 'rack', '~> 3.1'",
    "gem 'redis' # git: https://example.test/not-a-source",
    "# gem 'nokogiri', '~> 1.16'",
    "#gem 'byebug'",
    "#  gem 'pry'",
    "# gem 'evil', git: 'https://example.test/evil'",
    'group :development do',
    "  # gem 'rubocop'",
    "  gem 'rspec'",
    'end',
  ].join('\n');

  it('ignores commented-out gem declarations', async () => {
    const { dir, ws } = mkWorkspace('ruby', { Gemfile: GEMFILE_WITH_COMMENTS });
    await withCleanup(async () => {
      const deps = await new RubyAdapter().inventory(ws, {});
      expect(deps.map((d) => d.name).sort()).toEqual(['rack', 'redis', 'rspec']);
      // A live gem inside a group block is still a dependency.
      expect(deps.find((d) => d.name === 'rack')?.requested).toBe('~> 3.1');
    }, dir);
  });

  it('does not let an inline comment forge the dependency source type', async () => {
    const { dir, ws } = mkWorkspace('ruby', { Gemfile: GEMFILE_WITH_COMMENTS });
    await withCleanup(async () => {
      const deps = await new RubyAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'redis')).toMatchObject({
        sourceType: 'registry',
        status: 'current',
      });
    }, dir);
  });

  // Real Bundler shape: specs at 4-space indent, each spec's own requirements
  // nested one level deeper (6 spaces) under an alphabetically-later gem.
  const GEMFILE_LOCK_NESTED = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    actionpack (7.1.4)',
    '      rack (>= 2.2.4)',
    '    puma (6.4.2)',
    '    rack (3.1.8)',
    '    rails (7.1.4)',
    '      actionpack (= 7.1.4)',
    '      rack (>= 2.2.4)',
    '',
    'PLATFORMS',
    '  ruby',
    '',
    'DEPENDENCIES',
    '  actionpack',
    '  puma',
    '  rack',
  ].join('\n');
  const GEMFILE_NESTED = [
    "source 'https://rubygems.org'",
    "gem 'actionpack'",
    "gem 'puma'",
    "gem 'rack'",
  ].join('\n');

  it('ignores nested requirement lines when reading resolved versions', async () => {
    const { dir, ws } = mkWorkspace('ruby', {
      Gemfile: GEMFILE_NESTED,
      'Gemfile.lock': GEMFILE_LOCK_NESTED,
    });
    await withCleanup(async () => {
      const deps = await new RubyAdapter().inventory(ws, {});
      // `rails` requires these two; its requirement lines are not versions.
      expect(deps.find((d) => d.name === 'actionpack')).toMatchObject({
        locked: '7.1.4',
        purl: 'pkg:gem/actionpack@7.1.4',
      });
      expect(deps.find((d) => d.name === 'rack')).toMatchObject({
        locked: '3.1.8',
        purl: 'pkg:gem/rack@3.1.8',
      });
      // A gem nothing depends on was never affected.
      expect(deps.find((d) => d.name === 'puma')?.locked).toBe('6.4.2');
    }, dir);
  });

  it('never records a constraint operator as a locked version', async () => {
    const { dir, ws } = mkWorkspace('ruby', {
      Gemfile: GEMFILE_NESTED,
      'Gemfile.lock': GEMFILE_LOCK_NESTED,
    });
    await withCleanup(async () => {
      const deps = await new RubyAdapter().inventory(ws, {});
      for (const dep of deps) {
        if (dep.locked !== undefined) expect(dep.locked).not.toMatch(/^[<>=~!^]/);
      }
    }, dir);
  });

  it('returns [] when no Gemfile is found', async () => {
    const { dir, ws } = mkWorkspace('ruby', {});
    await withCleanup(async () => {
      expect(await new RubyAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });
});

// ── C++ adapter ───────────────────────────────────────────────────────

describe('CppAdapter', () => {
  const CONANFILE = ['[requires]', 'boost/1.84.0', 'openssl/3.2.1', '[generators]', 'cmake'].join(
    '\n',
  );
  const VCPKG_JSON = JSON.stringify({
    dependencies: ['fmt', { name: 'spdlog', version: '1.13.0' }],
  });

  it('parses conanfile.txt [requires] section', async () => {
    const { dir, ws } = mkWorkspace('cpp', { 'conanfile.txt': CONANFILE });
    await withCleanup(async () => {
      const deps = await new CppAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('boost');
      expect(names).toContain('openssl');
      expect(deps.find((d) => d.name === 'boost')?.requested).toBe('1.84.0');
    }, dir);
  });

  it('parses vcpkg.json dependencies array', async () => {
    const { dir, ws } = mkWorkspace('cpp', { 'vcpkg.json': VCPKG_JSON });
    await withCleanup(async () => {
      const deps = await new CppAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('fmt');
      expect(names).toContain('spdlog');
    }, dir);
  });

  it('retains vcpkg minimum-version constraints without claiming an exact resolved version', async () => {
    const { dir, ws } = mkWorkspace('cpp', {
      'vcpkg.json': JSON.stringify({
        dependencies: [{ name: 'fmt', 'version>=': '10.2.1' }, 'zlib'],
      }),
    });
    await withCleanup(async () => {
      const deps = await new CppAdapter().inventory(ws, {});
      const fmt = deps.find((dep) => dep.name === 'fmt');
      expect(fmt?.requested).toBe('10.2.1');
      expect(fmt?.purl).not.toContain('@10.2.1');
      expect(deps.find((dep) => dep.name === 'zlib')?.requested).toBeUndefined();
    }, dir);
  });

  it('deduplicates across manifests', async () => {
    const { dir, ws } = mkWorkspace('cpp', {
      'conanfile.txt': CONANFILE,
      'vcpkg.json': VCPKG_JSON,
    });
    await withCleanup(async () => {
      const deps = await new CppAdapter().inventory(ws, {});
      // No duplicate names
      const names = deps.map((d) => d.name);
      expect(new Set(names).size).toBe(names.length);
    }, dir);
  });

  it('returns [] for empty manifests', async () => {
    const { dir, ws } = mkWorkspace('cpp', { 'conanfile.txt': '[requires]\n' });
    await withCleanup(async () => {
      expect(await new CppAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });
});

// ── Elixir adapter ────────────────────────────────────────────────────

describe('ElixirAdapter', () => {
  const MIX_EXS = [
    'defp deps do',
    '  [',
    '    {:phoenix, "~> 1.7.0"},',
    '    {:ecto, "~> 3.10"},',
    '    {:exdoc, "~> 0.30"},',
    '  ]',
    'end',
  ].join('\n');
  // mix.lock is an Elixir map literal written in COLON form, and the tuple
  // carries the version THIRD: {:hex, :name, "version", "outer_checksum", …}.
  // The old fixture put a hash before the version, so even a working parser
  // would have read the hash as the version.
  const MIX_LOCK = [
    '%{',
    '  "phoenix": {:hex, :phoenix, "1.7.14", "abc123", [:mix], [{:jason, "~> 1.0"}], "hexpm", "def456"},',
    '  "ecto": {:hex, :ecto, "3.11.0", "def456", [:mix], [], "hexpm", "aaa111"},',
    '}',
  ].join('\n');

  it('extracts deps from mix.exs', async () => {
    const { dir, ws } = mkWorkspace('elixir', { 'mix.exs': MIX_EXS });
    await withCleanup(async () => {
      const deps = await new ElixirAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('phoenix');
      expect(names).toContain('ecto');
      expect(names).toContain('exdoc');
    }, dir);
  });

  it('reads locked versions from mix.lock', async () => {
    const { dir, ws } = mkWorkspace('elixir', { 'mix.exs': MIX_EXS, 'mix.lock': MIX_LOCK });
    await withCleanup(async () => {
      const deps = await new ElixirAdapter().inventory(ws, {});
      const phoenix = deps.find((d) => d.name === 'phoenix');
      // Unguarded: this assertion used to sit behind `if (phoenix?.locked)`,
      // which passed vacuously whenever the lock parse failed — that is how a
      // mix.lock reading nothing at all could stay green.
      expect(phoenix?.locked).toBe('1.7.14');
    }, dir);
  });

  // The locked version is what advisory matching consumes, so it must reach
  // the purl. When the lock parse failed the purl fell back to the mix.exs
  // CONSTRAINT and emitted `pkg:hex/phoenix@~> 1.7.0` — a requirement operator
  // where a version belongs, which no registry can match.
  it('emits a versioned purl from the resolved mix.lock version', async () => {
    const { dir, ws } = mkWorkspace('elixir', { 'mix.exs': MIX_EXS, 'mix.lock': MIX_LOCK });
    await withCleanup(async () => {
      const deps = await new ElixirAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'phoenix')?.purl).toBe('pkg:hex/phoenix@1.7.14');
      expect(deps.find((d) => d.name === 'ecto')?.purl).toBe('pkg:hex/ecto@3.11.0');
    }, dir);
  });

  // The whole lock, not just the first entry.
  it('resolves every entry in the mix.lock', async () => {
    const { dir, ws } = mkWorkspace('elixir', { 'mix.exs': MIX_EXS, 'mix.lock': MIX_LOCK });
    await withCleanup(async () => {
      const deps = await new ElixirAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'ecto')?.locked).toBe('3.11.0');
    }, dir);
  });

  // Git/path sources carry no Hex release, so they must not be reported as a
  // resolved registry version.
  it('ignores non-hex mix.lock sources when resolving versions', async () => {
    const { dir, ws } = mkWorkspace('elixir', {
      'mix.exs': MIX_EXS,
      'mix.lock': [
        '%{',
        '  "phoenix": {:hex, :phoenix, "1.7.14", "abc123", [:mix], [], "hexpm", "def456"},',
        '  "local_dep": {:path, "deps/local_dep"},',
        '  "git_dep": {:git, "https://github.com/acme/git_dep", "ff00", []},',
        '}',
      ].join('\n'),
    });
    await withCleanup(async () => {
      const deps = await new ElixirAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'phoenix')?.locked).toBe('1.7.14');
      // A git/path source has no version to report, so it stays unresolved
      // rather than borrowing a registry version it never had.
      expect(deps.find((d) => d.name === 'git_dep')?.locked).toBeUndefined();
      expect(deps.find((d) => d.name === 'local_dep')?.locked).toBeUndefined();
    }, dir);
  });

  // `hex: :package` names the Hex package when it differs from the app name,
  // and mix.lock records that package as the tuple's second element. The purl
  // is the identity OSV matches on, so it must name the PACKAGE: the app alias
  // purl'd a different (or nonexistent) Hex package.
  it('purls a hex: aliased dep under its Hex package name', async () => {
    const aliased = [
      'defp deps do',
      '  [',
      '    {:phoenix, "~> 1.7.0"},',
      '    {:my_json, "~> 1.4", hex: :jason},',
      '    {:my_decimal, "2.1.1", hex: "decimal"},',
      '  ]',
      'end',
    ].join('\n');
    const lock = [
      '%{',
      '  "my_json": {:hex, :jason, "1.4.1", "c", [:mix], [], "hexpm", "d"},',
      '  "phoenix": {:hex, :phoenix, "1.7.14", "e", [:mix], [], "hexpm", "f"},',
      '}',
    ].join('\n');
    const locked = mkWorkspace('elixir', { 'mix.exs': aliased, 'mix.lock': lock });
    await withCleanup(async () => {
      const deps = await new ElixirAdapter().inventory(locked.ws, {});
      expect(deps.find((d) => d.name === 'my_json')).toMatchObject({
        locked: '1.4.1',
        purl: 'pkg:hex/jason@1.4.1',
      });
      // Unlocked: the manifest's own `hex:` option (atom or string) names it.
      expect(deps.find((d) => d.name === 'my_decimal')?.purl).toBe('pkg:hex/decimal@2.1.1');
      // Control: an unaliased dep keeps its own name.
      expect(deps.find((d) => d.name === 'phoenix')?.purl).toBe('pkg:hex/phoenix@1.7.14');
    }, locked.dir);
    const unlocked = mkWorkspace('elixir', { 'mix.exs': aliased });
    await withCleanup(async () => {
      const deps = await new ElixirAdapter().inventory(unlocked.ws, {});
      expect(deps.find((d) => d.name === 'my_json')?.purl).toBe('pkg:hex/jason');
    }, unlocked.dir);
  });

  it('returns [] when no mix.exs is found', async () => {
    const { dir, ws } = mkWorkspace('elixir', {});
    await withCleanup(async () => {
      expect(await new ElixirAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });
});

// ── Maven adapter ─────────────────────────────────────────────────────

describe('MavenAdapter', () => {
  const POM_XML = [
    '<project>',
    '  <dependencies>',
    '    <dependency>',
    '      <groupId>org.springframework</groupId>',
    '      <artifactId>spring-core</artifactId>',
    '      <version>6.1.0</version>',
    '    </dependency>',
    '    <dependency>',
    '      <groupId>junit</groupId>',
    '      <artifactId>junit</artifactId>',
    '      <version>4.13.2</version>',
    '      <scope>test</scope>',
    '    </dependency>',
    '  </dependencies>',
    '</project>',
  ].join('\n');

  it('extracts dependencies from pom.xml', async () => {
    const { dir, ws } = mkWorkspace('maven', { 'pom.xml': POM_XML });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      const names = deps.map((d) => d.name);
      expect(names).toContain('org.springframework:spring-core');
      expect(names).toContain('junit:junit');
    }, dir);
  });

  // Maven properties may reference OTHER properties, and the parser stores each
  // property's RAW value. One substitution pass therefore replaced `${a}` with
  // the literal text `${b}` and stopped, leaving the placeholder in the version
  // and so in the purl (`pkg:maven/g/a@${b}`) — an identity no registry can
  // resolve, so the advisory lookup always failed. Chained properties are
  // ordinary practice (one base version, derived artifacts).
  const POM_CHAINED_PROPERTIES = [
    '<project>',
    '  <properties>',
    '    <junit.version>5.10.2</junit.version>',
    '    <junit.jupiter.version>${junit.version}</junit.jupiter.version>',
    '  </properties>',
    '  <dependencies>',
    '    <dependency>',
    '      <groupId>org.junit.jupiter</groupId>',
    '      <artifactId>junit-jupiter</artifactId>',
    '      <version>${junit.jupiter.version}</version>',
    '    </dependency>',
    '  </dependencies>',
    '</project>',
  ].join('\n');

  it('resolves a property that references another property', async () => {
    const { dir, ws } = mkWorkspace('maven', { 'pom.xml': POM_CHAINED_PROPERTIES });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'org.junit.jupiter:junit-jupiter')).toMatchObject({
        requested: '5.10.2',
        purl: 'pkg:maven/org.junit.jupiter/junit-jupiter@5.10.2',
      });
    }, dir);
  });

  it('never emits a placeholder inside a purl for a deep property chain', async () => {
    const { dir, ws } = mkWorkspace('maven', {
      'pom.xml': [
        '<project><properties>',
        '  <base.version>2.0.0</base.version>',
        '  <mid.version>${base.version}</mid.version>',
        '  <top.version>${mid.version}</top.version>',
        '</properties><dependencies><dependency>',
        '  <groupId>org.example</groupId>',
        '  <artifactId>demo</artifactId>',
        '  <version>${top.version}</version>',
        '</dependency></dependencies></project>',
      ].join('\n'),
    });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      const purl = deps.find((d) => d.name === 'org.example:demo')?.purl;
      expect(purl).not.toContain('${');
      expect(purl).toBe('pkg:maven/org.example/demo@2.0.0');
    }, dir);
  });

  // An unknown key is left verbatim on purpose: it is not a resolvable version.
  it('leaves an unknown property reference unresolved', async () => {
    const { dir, ws } = mkWorkspace('maven', {
      'pom.xml': [
        '<project><properties><other.version>1.0</other.version></properties>',
        '<dependencies><dependency>',
        '  <groupId>org.example</groupId>',
        '  <artifactId>demo</artifactId>',
        '  <version>${nope.version}</version>',
        '</dependency></dependencies></project>',
      ].join('\n'),
    });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      const demo = deps.find((d) => d.name === 'org.example:demo');
      // The declaration stays visible, but a placeholder is not a version: the
      // purl carries none rather than `@${nope.version}`.
      expect(demo?.requested).toBe('${nope.version}');
      expect(demo?.purl).toBe('pkg:maven/org.example/demo');
    }, dir);
  });

  // Boundary: a mutually recursive pair must terminate, not hang.
  it('terminates on mutually recursive property references', async () => {
    const { dir, ws } = mkWorkspace('maven', {
      'pom.xml': [
        '<project><properties>',
        '  <a.version>${b.version}</a.version>',
        '  <b.version>${a.version}</b.version>',
        '</properties><dependencies><dependency>',
        '  <groupId>org.example</groupId>',
        '  <artifactId>demo</artifactId>',
        '  <version>${a.version}</version>',
        '</dependency></dependencies></project>',
      ].join('\n'),
    });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'org.example:demo')?.purl).toBeDefined();
    }, dir);
  });

  it('resolves a relative manifest against the supplied project root', async () => {
    const { dir, ws } = mkWorkspace('maven', {});
    const nested = join(dir, 'services', 'api');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'pom.xml'), POM_XML);
    const relativeWorkspace: Workspace = {
      ...ws,
      relativeRoot: join('services', 'api'),
      manifests: ['pom.xml'],
    };

    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(relativeWorkspace, { projectRoot: dir });
      expect(deps.map((d) => d.name)).toContain('org.springframework:spring-core');
    }, dir);
  });

  it('maps Maven scopes to TechStack scopes', async () => {
    const { dir, ws } = mkWorkspace('maven', { 'pom.xml': POM_XML });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'junit:junit')?.scope).toBe('development');
      expect(deps.find((d) => d.name === 'org.springframework:spring-core')?.scope).toBe('runtime');
    }, dir);
  });

  it('records requested version from pom.xml', async () => {
    const { dir, ws } = mkWorkspace('maven', { 'pom.xml': POM_XML });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'org.springframework:spring-core')?.requested).toBe(
        '6.1.0',
      );
    }, dir);
  });

  it('emits purls with the canonical maven namespace that parsePurlEcosystem resolves', async () => {
    const { dir, ws } = mkWorkspace('maven', { 'pom.xml': POM_XML });
    await withCleanup(async () => {
      const deps = await new MavenAdapter().inventory(ws, {});
      const spring = deps.find((d) => d.name === 'org.springframework:spring-core');
      expect(spring!.purl).toBe('pkg:maven/org.springframework/spring-core@6.1.0');
      // Regression (round r22): the adapter used to emit the raw coordinate as
      // one name segment (`pkg:maven/org.springframework:spring-core@6.1.0`) —
      // a non-canonical purl that spec-conformant consumers (OSV) cannot match.
      expect(parsePurlEcosystem(spring!.purl!)).toEqual({
        ecosystem: 'maven',
        name: 'org.springframework/spring-core',
        version: '6.1.0',
      });
    }, dir);
  });

  it('returns [] when no pom.xml is found', async () => {
    const { dir, ws } = mkWorkspace('maven', {});
    await withCleanup(async () => {
      expect(await new MavenAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });

  it('strips UTF-8 BOM from NuGet packages.lock.json', async () => {
    const { dir, ws } = mkWorkspace('dotnet', {
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Serilog" Version="4.*" /></ItemGroup></Project>',
      'packages.lock.json': `\uFEFF${JSON.stringify({
        version: 1,
        dependencies: {
          'net8.0': { Serilog: { type: 'Direct', requested: '[4.0.0, )', resolved: '4.2.0' } },
        },
      })}`,
    });
    await withCleanup(async () => {
      const deps = await new DotNetAdapter().inventory(ws, { projectRoot: dir });
      expect(deps[0]?.locked).toBe('4.2.0');
    }, dir);
  });
});
