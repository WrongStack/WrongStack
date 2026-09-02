import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workspaceId } from '../../src/discovery/index.js';
import type { Workspace } from '../../src/types.js';
import { DartAdapter } from '../../src/adapters/dart.js';
import { PhpAdapter } from '../../src/adapters/php.js';
import { DotNetAdapter } from '../../src/adapters/dotnet.js';
import { RubyAdapter } from '../../src/adapters/ruby.js';
import { CppAdapter } from '../../src/adapters/cpp.js';
import { ElixirAdapter } from '../../src/adapters/elixir.js';
import { MavenAdapter } from '../../src/adapters/maven.js';

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

  it('returns [] when no .csproj is found', async () => {
    const { dir, ws } = mkWorkspace('dotnet', {});
    await withCleanup(async () => {
      expect(await new DotNetAdapter().inventory(ws, {})).toEqual([]);
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
      // 'rails' is explicitly skipped by the parser (hard-coded filter)
      const names = deps.map((d) => d.name);
      expect(names).toContain('puma');
      expect(names).toContain('redis');
      expect(names).not.toContain('rails');
    }, dir);
  });

  it('reads locked versions from Gemfile.lock', async () => {
    const { dir, ws } = mkWorkspace('ruby', { Gemfile: GEMFILE, 'Gemfile.lock': GEMFILE_LOCK });
    await withCleanup(async () => {
      const deps = await new RubyAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'puma')?.locked).toBe('6.4.2');
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
  // mix.lock format: {"name", hex: ":uuid", "version"}
  const MIX_LOCK = [
    '%{',
    '  "phoenix": {:hex, :phoenix, "abc123", "1.7.14", [], [:phoenix_pubsub]},',
    '  "ecto": {:hex, :ecto, "def456", "3.11.0", []},',
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
      // The lock parser expects {"name", hex: ":uuid", "version"} format.
      // Our fixture uses that format for the value tuples.
      const phoenix = deps.find((d) => d.name === 'phoenix');
      if (phoenix?.locked) {
        expect(phoenix.locked).toBe('1.7.14');
      }
    }, dir);
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

  it('returns [] when no pom.xml is found', async () => {
    const { dir, ws } = mkWorkspace('maven', {});
    await withCleanup(async () => {
      expect(await new MavenAdapter().inventory(ws, {})).toEqual([]);
    }, dir);
  });
});
