import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EcosystemAdapter, InventoryOptions } from '../../src/adapters/interface.js';
import { dartAdapter } from '../../src/adapters/dart.js';
import { dotNetAdapter } from '../../src/adapters/dotnet.js';
import { elixirAdapter } from '../../src/adapters/elixir.js';
import { goAdapter } from '../../src/adapters/go.js';
import { mavenAdapter } from '../../src/adapters/maven.js';
import { npmAdapter } from '../../src/adapters/npm.js';
import { phpAdapter } from '../../src/adapters/php.js';
import { pythonAdapter } from '../../src/adapters/python.js';
import { rubyAdapter } from '../../src/adapters/ruby.js';
import { rustAdapter } from '../../src/adapters/rust.js';
import type { EcosystemId, Workspace } from '../../src/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function inventory(
  adapter: EcosystemAdapter,
  ecosystem: EcosystemId,
  files: Readonly<Record<string, string>>,
  manifests: readonly string[],
  lockfiles: readonly string[] = [],
  options: InventoryOptions = {},
) {
  const root = mkdtempSync(join(tmpdir(), `techstack-${ecosystem}-`));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  const workspace: Workspace = {
    id: `ws-${ecosystem}`,
    relativeRoot: '.',
    ecosystem,
    manifests: manifests.map((path) => join(root, path)),
    lockfiles: lockfiles.map((path) => join(root, path)),
    confidence: 1,
    coverage: 'full',
  };
  return adapter.inventory(workspace, { projectRoot: root, ...options });
}

describe('adapter parser edge cases', () => {
  it('parses pnpm importer comments, commit resolutions, links, and CRLF', async () => {
    const deps = await inventory(
      npmAdapter,
      'npm',
      {
        'package.json': JSON.stringify({
          dependencies: { react: '^19.0.0', local: 'workspace:*', commitpkg: '^1.0.0' },
        }),
        'pnpm-lock.yaml': [
          "lockfileVersion: '9.0'",
          'importers:',
          '  .:',
          '    dependencies:',
          '      react:',
          '        specifier: ^19.0.0 # supported range',
          '        version: 19.1.0(react-dom@19.1.0)',
          '      local:',
          '        specifier: workspace:*',
          '        version: link:packages/core',
          '      commitpkg:',
          '        specifier: ^1.0.0',
          '        resolution:',
          '          commit: abcdef1234',
          '        version: 1.0.1',
        ].join('\r\n'),
      },
      ['package.json'],
      ['pnpm-lock.yaml'],
    );

    expect(deps.find((dep) => dep.name === 'react')?.locked).toBe('19.1.0');
    expect(deps.find((dep) => dep.name === 'local')?.sourceType).toBe('path');
    expect(deps.find((dep) => dep.name === 'commitpkg')?.locked).toBe('1.0.1');
  });

  it('parses Python multiline arrays, inline tables, and quoted keys', async () => {
    const deps = await inventory(
      pythonAdapter,
      'python',
      {
        'pyproject.toml': [
          '[project]',
          'dependencies = [',
          '  "requests>=2.31", # HTTP',
          '  "flask>=2.0",',
          ']',
          '[project.optional-dependencies]',
          'test = ["pytest>=8"]',
          '[tool.poetry.dependencies]',
          '"typing-extensions" = { version = ">=4.10", python = ">=3.11" }',
        ].join('\n'),
      },
      ['pyproject.toml'],
    );

    expect(deps.map((dep) => dep.name)).toEqual(
      expect.arrayContaining(['requests', 'flask', 'pytest', 'typing-extensions']),
    );
  });

  it('parses Cargo git sources and duplicate package names deterministically', async () => {
    const deps = await inventory(
      rustAdapter,
      'rust',
      {
        'Cargo.toml':
          '[dependencies]\nserde = "1"\nfoo = { git = "https://example.test/foo", tag = "v1" }\n',
        'Cargo.lock': [
          '[[package]]',
          'name = "serde"',
          'version = "1.0.200"',
          'source = "registry+https://github.com/rust-lang/crates.io-index"',
          '[[package]]',
          'name = "foo"',
          'version = "1.2.0"',
          'source = "git+https://example.test/foo#abc"',
          '[[package]]',
          'name = "foo"',
          'version = "2.0.0"',
        ].join('\n'),
      },
      ['Cargo.toml'],
      ['Cargo.lock'],
    );

    expect(deps.find((dep) => dep.name === 'serde')?.locked).toBe('1.0.200');
    expect(deps.find((dep) => dep.name === 'foo')?.sourceType).toBe('git');
  });

  it('handles go.mod replace, retract, exclude, pseudo-versions, and CRLF', async () => {
    const pseudo = 'v0.0.0-20240701012345-abcdefabcdef';
    const deps = await inventory(
      goAdapter,
      'go',
      {
        'go.mod': [
          'module example.test/app',
          'require (',
          `  example.test/pseudo ${pseudo}`,
          '  example.test/direct v1.2.0',
          ')',
          'replace example.test/direct => ../direct',
          'exclude example.test/direct v1.1.0',
          'retract [v1.0.0, v1.0.1]',
        ].join('\r\n'),
        'go.sum': `example.test/pseudo ${pseudo} h1:abc\r\nexample.test/direct v1.2.0 h1:def\r\n`,
      },
      ['go.mod'],
      ['go.sum'],
    );

    expect(deps.find((dep) => dep.name === 'example.test/pseudo')?.locked).toBe(
      '0.0.0-20240701012345-abcdefabcdef',
    );
    expect(deps.find((dep) => dep.name === 'example.test/direct')?.sourceType).toBe('path');
  });

  it('classifies Flutter SDK, dependency overrides, and git refs', async () => {
    const deps = await inventory(
      dartAdapter,
      'dart',
      {
        'pubspec.yaml': [
          'dependencies:',
          '  flutter:',
          '    sdk: flutter',
          '  http: ^1.2.0',
          '  git_pkg:',
          '    git:',
          '      url: https://example.test/pkg.git',
          '      ref: stable',
          'dependency_overrides:',
          '  http: ^1.3.0',
        ].join('\n'),
        'pubspec.lock': [
          'packages:',
          '  http:',
          '    dependency: direct main',
          '    version: "1.3.0"',
          '  git_pkg:',
          '    dependency: direct main',
          '    version: "2.0.0"',
        ].join('\n'),
      },
      ['pubspec.yaml'],
      ['pubspec.lock'],
    );

    expect(deps.some((dep) => dep.name === 'flutter')).toBe(false);
    expect(deps.find((dep) => dep.name === 'http')?.locked).toBe('1.3.0');
    expect(deps.find((dep) => dep.name === 'git_pkg')?.sourceType).toBe('git');
  });

  it('parses csproj attributes in any order and nested Version elements', async () => {
    const deps = await inventory(
      dotNetAdapter,
      'dotnet',
      {
        'app.csproj': [
          '<Project><ItemGroup>',
          '<PackageReference Condition="$(TargetFramework) == net8.0" Version="13.0.3" Include="Newtonsoft.Json" />',
          '<PackageReference Include="Serilog" Condition="true"><Version>4.2.0</Version></PackageReference>',
          '</ItemGroup></Project>',
        ].join('\n'),
      },
      ['app.csproj'],
    );

    expect(deps.find((dep) => dep.name === 'Newtonsoft.Json')?.requested).toBe('13.0.3');
    expect(deps.find((dep) => dep.name === 'Serilog')?.requested).toBe('4.2.0');
  });

  it('resolves Maven properties, parent properties, and dependencyManagement', async () => {
    const deps = await inventory(
      mavenAdapter,
      'maven',
      {
        'pom.xml': [
          '<project><parent><groupId>org.parent</groupId><artifactId>base</artifactId><version>2.0.0</version></parent>',
          '<properties><junit.version>5.10.2</junit.version></properties>',
          '<dependencyManagement><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version></dependency></dependencies></dependencyManagement>',
          '<dependencies>',
          '<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>' +
            String.fromCharCode(36) +
            '{junit.version}</version><scope>test</scope></dependency>',
          '<dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency>',
          '</dependencies></project>',
        ].join('\n'),
      },
      ['pom.xml'],
    );

    expect(deps.find((dep) => dep.name === 'org.junit.jupiter:junit-jupiter')?.requested).toBe(
      '5.10.2',
    );
    expect(deps.find((dep) => dep.name === 'org.slf4j:slf4j-api')?.requested).toBe('2.0.13');
  });

  it('reads Ruby GEM, GIT, and PATH lock sections', async () => {
    const deps = await inventory(
      rubyAdapter,
      'ruby',
      {
        Gemfile:
          "gem 'rack'\ngem 'gitgem', git: 'https://example.test/gitgem'\ngem 'localgem', path: '../local'\n",
        'Gemfile.lock': [
          'GIT',
          '  remote: https://example.test/gitgem',
          '  specs:',
          '    gitgem (1.2.0)',
          'PATH',
          '  remote: ../local',
          '  specs:',
          '    localgem (0.3.0)',
          'GEM',
          '  remote: https://rubygems.org/',
          '  specs:',
          '    rack (3.1.0)',
        ].join('\n'),
      },
      ['Gemfile'],
      ['Gemfile.lock'],
    );

    expect(deps.find((dep) => dep.name === 'rack')?.locked).toBe('3.1.0');
    expect(deps.find((dep) => dep.name === 'gitgem')?.sourceType).toBe('git');
    expect(deps.find((dep) => dep.name === 'localgem')?.sourceType).toBe('path');
  });

  it('ignores Composer abandoned and notification metadata while parsing packages', async () => {
    const deps = await inventory(
      phpAdapter,
      'php',
      {
        'composer.json': JSON.stringify({ require: { 'vendor/pkg': '^1.0' } }),
        'composer.lock': JSON.stringify({
          packages: [
            {
              name: 'vendor/pkg',
              version: '1.2.3',
              abandoned: true,
              'notification-url': 'https://example.test',
            },
          ],
        }),
      },
      ['composer.json'],
      ['composer.lock'],
    );
    expect(deps.find((dep) => dep.name === 'vendor/pkg')?.locked).toBe('1.2.3');
  });

  it('classifies Elixir git tuples without treating tags as registry constraints', async () => {
    const deps = await inventory(
      elixirAdapter,
      'elixir',
      {
        'mix.exs':
          'defp deps do\n[{:plug, "~> 1.16"}, {:git_dep, git: "https://example.test/git_dep", tag: "1.0.0"}]\nend\n',
        'mix.lock':
          '%{"plug" => {:hex, :plug, "1.16.1"}, "git_dep" => {:git, "https://example.test/git_dep", "abc", [tag: "1.0.0"]}}',
      },
      ['mix.exs'],
      ['mix.lock'],
    );

    expect(deps.find((dep) => dep.name === 'plug')?.locked).toBe('1.16.1');
    expect(deps.find((dep) => dep.name === 'git_dep')?.sourceType).toBe('git');
  });
});
