import { describe, expect, it } from 'vitest';
import {
  diffDeclaredDependencies,
  hasDependencyChanges,
  parseDeclaredDependencies,
} from '../src/manifest-deps.js';

describe('parseDeclaredDependencies', () => {
  it('parses npm runtime and dev dependencies', () => {
    const content = JSON.stringify({
      dependencies: { react: '^18.3.1' },
      devDependencies: { vitest: '2.1.9' },
    });
    const deps = parseDeclaredDependencies(content, 'packages/web/package.json');
    expect(deps.get('react')).toEqual({
      name: 'react',
      range: '^18.3.1',
      section: 'dependencies',
    });
    expect(deps.get('vitest')?.section).toBe('devDependencies');
  });

  it('returns an empty map for a half-written manifest instead of throwing', () => {
    // An editor mid-save produces exactly this. A throw here would wedge the
    // watcher loop permanently on the first bad save.
    const deps = parseDeclaredDependencies('{"dependencies": {"react": ', 'package.json');
    expect(deps.size).toBe(0);
  });

  it('returns an empty map for a format it does not parse', () => {
    const deps = parseDeclaredDependencies('<project/>', 'pom.xml');
    expect(deps.size).toBe(0);
  });

  it('attributes a package declared twice to its first (runtime) section', () => {
    const content = JSON.stringify({
      dependencies: { vite: '^5.0.0' },
      devDependencies: { vite: '^4.0.0' },
    });
    const deps = parseDeclaredDependencies(content, 'package.json');
    expect(deps.get('vite')?.section).toBe('dependencies');
    expect(deps.get('vite')?.range).toBe('^5.0.0');
  });

  it('parses cargo dependencies from both string and table form', () => {
    const content = [
      '[package]',
      'name = "app"',
      '',
      '[dependencies]',
      'serde = "1.0"',
      'tokio = { version = "1.35", features = ["full"] }',
      '',
      '[dev-dependencies]',
      'criterion = "0.5"',
      '# comment = "ignored"',
    ].join('\n');
    const deps = parseDeclaredDependencies(content, 'Cargo.toml');
    expect(deps.get('serde')?.range).toBe('1.0');
    expect(deps.get('tokio')?.range).toBe('1.35');
    expect(deps.get('criterion')?.section).toBe('dev-dependencies');
  });

  it('parses go.mod single-line and block requires', () => {
    const content = [
      'module example.com/app',
      '',
      'go 1.22',
      '',
      'require github.com/gin-gonic/gin v1.9.1',
      '',
      'require (',
      '\tgolang.org/x/sys v0.15.0 // indirect',
      ')',
    ].join('\n');
    const deps = parseDeclaredDependencies(content, 'go.mod');
    expect(deps.get('github.com/gin-gonic/gin')?.range).toBe('v1.9.1');
    expect(deps.get('golang.org/x/sys')?.range).toBe('v0.15.0');
  });

  it('parses pip requirements with constraints', () => {
    const content = ['# comment', 'requests==2.31.0', 'urllib3>=2.0', 'flask', '-e .'].join('\n');
    const deps = parseDeclaredDependencies(content, 'requirements.txt');
    expect(deps.get('requests')?.range).toBe('==2.31.0');
    expect(deps.get('urllib3')?.range).toBe('>=2.0');
    expect(deps.get('flask')?.range).toBe('');
  });

  it('parses composer require but skips platform constraints', () => {
    const content = JSON.stringify({
      require: {
        php: '>=8.1',
        'ext-json': '*',
        'laravel/framework': '^11.0',
      },
    });
    const deps = parseDeclaredDependencies(content, 'composer.json');
    expect(deps.has('php')).toBe(false);
    expect(deps.has('ext-json')).toBe(false);
    expect(deps.get('laravel/framework')?.range).toBe('^11.0');
  });

  it('parses gemfile declarations', () => {
    const content = ["source 'https://rubygems.org'", "gem 'rails', '~> 7.1'", 'gem "puma"'].join(
      '\n',
    );
    const deps = parseDeclaredDependencies(content, 'Gemfile');
    expect(deps.get('rails')?.range).toBe('~> 7.1');
    expect(deps.get('puma')?.range).toBe('');
  });

  it('parses pubspec dependencies', () => {
    const content = [
      'name: app',
      '',
      'dependencies:',
      '  http: ^1.2.0',
      '',
      'dev_dependencies:',
      '  test: ^1.24.0',
    ].join('\n');
    const deps = parseDeclaredDependencies(content, 'pubspec.yaml');
    expect(deps.get('http')?.range).toBe('^1.2.0');
    expect(deps.get('test')?.section).toBe('dev_dependencies');
  });
});

describe('diffDeclaredDependencies', () => {
  it('reports a genuinely new dependency', () => {
    const before = parseDeclaredDependencies(
      JSON.stringify({ dependencies: { a: '1.0.0' } }),
      'package.json',
    );
    const after = parseDeclaredDependencies(
      JSON.stringify({ dependencies: { a: '1.0.0', b: '2.0.0' } }),
      'package.json',
    );
    const delta = diffDeclaredDependencies(before, after);
    expect(delta.added.map((d) => d.name)).toEqual(['b']);
    expect(delta.changed).toHaveLength(0);
    expect(hasDependencyChanges(delta)).toBe(true);
  });

  it('reports a version change as changed, not added', () => {
    const before = parseDeclaredDependencies(
      JSON.stringify({ dependencies: { a: '1.0.0' } }),
      'package.json',
    );
    const after = parseDeclaredDependencies(
      JSON.stringify({ dependencies: { a: '1.1.0' } }),
      'package.json',
    );
    const delta = diffDeclaredDependencies(before, after);
    expect(delta.added).toHaveLength(0);
    expect(delta.changed).toEqual([{ name: 'a', from: '1.0.0', to: '1.1.0' }]);
  });

  it('reports removals', () => {
    const before = parseDeclaredDependencies(
      JSON.stringify({ dependencies: { a: '1.0.0', b: '2.0.0' } }),
      'package.json',
    );
    const after = parseDeclaredDependencies(
      JSON.stringify({ dependencies: { a: '1.0.0' } }),
      'package.json',
    );
    const delta = diffDeclaredDependencies(before, after);
    expect(delta.removed.map((d) => d.name)).toEqual(['b']);
    // A removal alone is not a reason to spend a research audit.
    expect(hasDependencyChanges(delta)).toBe(false);
  });

  it('claims nothing is new on the first sighting of a manifest', () => {
    // The guard that stops every session from auditing the whole repository.
    const after = parseDeclaredDependencies(
      JSON.stringify({ dependencies: { a: '1.0.0', b: '2.0.0' } }),
      'package.json',
    );
    const delta = diffDeclaredDependencies(undefined, after);
    expect(delta.added).toHaveLength(0);
    expect(hasDependencyChanges(delta)).toBe(false);
  });

  it('produces no delta when nothing changed', () => {
    const content = JSON.stringify({ dependencies: { a: '1.0.0' } });
    const before = parseDeclaredDependencies(content, 'package.json');
    const after = parseDeclaredDependencies(content, 'package.json');
    expect(hasDependencyChanges(diffDeclaredDependencies(before, after))).toBe(false);
  });

  it('strips UTF-8 BOM from JSON manifests (F472)', () => {
    const content = `\uFEFF${JSON.stringify({ dependencies: { zod: '^3.23.0' } })}`;
    const parsed = parseDeclaredDependencies(content, 'package.json');
    expect(parsed.get('zod')?.range).toBe('^3.23.0');
  });
});
