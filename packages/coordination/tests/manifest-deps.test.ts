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

  it('parses [workspace.dependencies] from a Cargo virtual workspace root', () => {
    // In a workspace root this table is the ONLY place a declared range
    // exists — member crates write `foo.workspace = true`, which carries no
    // version. Skipping it made the whole manifest report nothing, so the
    // delta stayed empty and the dep-watcher audit gate never opened for a
    // genuinely new Rust dependency.
    const content = [
      '[workspace]',
      'resolver = "2"',
      'members = ["crates/api", "crates/core"]',
      '',
      '[workspace.dependencies]',
      'clap = { version = "4.5.4", features = ["derive"] }',
      'serde = "1.0.200"',
    ].join('\n');
    const deps = parseDeclaredDependencies(content, 'Cargo.toml');
    expect(deps.get('clap')?.range).toBe('4.5.4');
    expect(deps.get('serde')?.range).toBe('1.0.200');
    expect(deps.get('serde')?.section).toBe('workspace.dependencies');
    // `[workspace]`'s own keys are configuration, not packages.
    expect(deps.has('resolver')).toBe(false);
    expect(deps.has('members')).toBe(false);
  });

  it('reports a new or version-changed workspace dependency (audit gate opens)', () => {
    const base = [
      '[workspace]',
      '[workspace.dependencies]',
      'serde = "1.0.200"',
      'tokio = "1.37.0"',
    ].join('\n');
    const before = parseDeclaredDependencies(base, 'Cargo.toml');
    const added = parseDeclaredDependencies(`${base}\nanyhow = "1.0.86"\n`, 'Cargo.toml');
    const addedDelta = diffDeclaredDependencies(before, added);
    expect(addedDelta.added.map((d) => d.name)).toEqual(['anyhow']);
    expect(hasDependencyChanges(addedDelta)).toBe(true);

    const bumped = parseDeclaredDependencies(base.replace('"1.0.200"', '"1.0.201"'), 'Cargo.toml');
    expect(diffDeclaredDependencies(before, bumped).changed).toEqual([
      { name: 'serde', from: '1.0.200', to: '1.0.201' },
    ]);

    // A member crate inheriting the version declares no range: nothing to
    // report, so an unchanged workspace must never look like a change.
    const member = parseDeclaredDependencies(
      ['[package]', 'name = "api"', '', '[dependencies]', 'serde.workspace = true'].join('\n'),
      'Cargo.toml',
    );
    expect(member.size).toBe(0);
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

  it('reads a wheel or sdist filename as the distribution it names', () => {
    // PEP 427 / PEP 527: the file name carries name+version. The generic
    // `name<op>version` pattern used to take the whole filename as the package
    // name, encoding the version INSIDE the identity, so a pinned wheel bump
    // diffed as added+removed churn instead of one version change.
    const deps = parseDeclaredDependencies(
      [
        'numpy-1.26.4-cp311-cp311-win_amd64.whl',
        'wheels/foo-1.0-py3-none-any.whl',
        'zope.interface-5.0.tar.gz',
        'C:\\pkgs\\bar-2.1-py3-none-any.whl',
      ].join('\n'),
      'requirements.txt',
    );
    expect(deps.get('numpy')?.range).toBe('1.26.4');
    expect(deps.get('foo')?.range).toBe('1.0');
    expect(deps.get('zope.interface')?.range).toBe('5.0');
    expect(deps.get('bar')?.range).toBe('2.1');
    expect(deps.has('wheels')).toBe(false);
    expect(deps.has('numpy-1.26.4-cp311-cp311-win_amd64.whl')).toBe(false);
  });

  it('never invents a package from a local directory requirement', () => {
    // A path declares no distribution name (it lives in the target's own
    // metadata). The old parse produced a package literally named "." / "..",
    // which the audit then tried to look up.
    const deps = parseDeclaredDependencies(
      ['./local-package', '../shared-pkg', '~/projects/app'].join('\n'),
      'requirements.txt',
    );
    expect(deps.size).toBe(0);
  });

  it('keeps name-bearing pip forms that merely contain a slash', () => {
    // Guards the path classification: only the FIRST token decides pathness. A
    // hash option carries a '/', and a PEP 508 direct reference names its
    // package before the '@' — neither is a path requirement.
    const deps = parseDeclaredDependencies(
      [
        'foo==1.26.4 --hash=sha256:abcd/ef==',
        'pkg @ https://example.com/y/pkg-1.0-py3-none-any.whl',
        'requests==2.31.0',
      ].join('\n'),
      'requirements.txt',
    );
    expect(deps.has('foo')).toBe(true);
    expect(deps.get('pkg')?.range).toContain('https://example.com');
    expect(deps.get('requests')?.range).toBe('==2.31.0');
    expect(deps.has('sha256:abcd')).toBe(false);
  });

  it('diffs a pinned wheel bump as one version change, not identity churn', () => {
    const before = parseDeclaredDependencies(
      'numpy-1.26.4-cp311-cp311-win_amd64.whl\n',
      'requirements.txt',
    );
    const after = parseDeclaredDependencies(
      'numpy-1.26.5-cp311-cp311-win_amd64.whl\n',
      'requirements.txt',
    );
    const delta = diffDeclaredDependencies(before, after);
    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
    expect(delta.changed).toEqual([{ name: 'numpy', from: '1.26.4', to: '1.26.5' }]);
    expect(hasDependencyChanges(delta)).toBe(true);
  });

  it('parses an inline pyproject array whose PEP 508 range contains a comma', () => {
    // `>=1.21,<2.0` is the ordinary lower-and-upper bound form. The inline
    // branch used to split the array on `,`, which put a quote on each side of
    // that comma; neither fragment then matched the quoted pattern, so numpy
    // vanished while the identical multi-line array parsed it (and a dropped
    // package never reaches the dep-watcher audit gate).
    const content =
      '[project]\nname = "svc"\ndependencies = ["numpy>=1.21,<2.0", "requests>=2.0"]\n';
    const deps = parseDeclaredDependencies(content, 'pyproject.toml');
    expect(deps.get('numpy')).toEqual({
      name: 'numpy',
      range: '>=1.21,<2.0',
      section: 'project.dependencies',
    });
    expect(deps.get('requests')?.range).toBe('>=2.0');
    // The multi-line form of the same manifest must agree with the inline one.
    const multiline = parseDeclaredDependencies(
      '[project]\ndependencies = [\n  "numpy>=1.21,<2.0",\n  "requests>=2.0",\n]\n',
      'pyproject.toml',
    );
    expect([...multiline.keys()].sort()).toEqual([...deps.keys()].sort());
    expect(multiline.get('numpy')?.range).toBe(deps.get('numpy')?.range);
  });

  it('parses pyproject extras, markers and a trailing comma without losing entries', () => {
    const deps = parseDeclaredDependencies(
      '[project]\ndependencies = ["celery[redis]>=5.2,<6", "uvicorn", "pytest>=7; python_version < \'3.12\'"]\n',
      'pyproject.toml',
    );
    expect(deps.get('celery')?.range).toBe('>=5.2,<6');
    expect(deps.get('uvicorn')?.range).toBe('');
    expect(deps.get('pytest')?.range).toBe(`>=7; python_version < '3.12'`);
  });

  it('keeps a comma-bounded package out of no delta (dep-watcher gate opens)', () => {
    const before = parseDeclaredDependencies(
      '[project]\ndependencies = ["requests>=2.0"]\n',
      'pyproject.toml',
    );
    const after = parseDeclaredDependencies(
      '[project]\ndependencies = ["requests>=2.0", "numpy>=1.21,<2.0"]\n',
      'pyproject.toml',
    );
    const delta = diffDeclaredDependencies(before, after);
    expect(delta.added.map((d) => d.name)).toEqual(['numpy']);
    expect(hasDependencyChanges(delta)).toBe(true);
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

  it('parses a pubspec block at any author-chosen indent, not only two spaces', () => {
    // Two spaces is Dart's convention, not a YAML requirement. The entry test
    // used to be "exactly two spaces and a non-empty value", so these files
    // reported NO dependencies at all: an added package produced an empty
    // delta and the dep-watcher audit gate never opened for it.
    const four = [
      'name: app',
      'dependencies:',
      '    http: ^1.2.0',
      '    provider: ^6.0.0',
      'dev_dependencies:',
      '    test: ^1.24.0',
    ].join('\n');
    const deps = parseDeclaredDependencies(four, 'pubspec.yaml');
    expect([...deps.keys()]).toEqual(['http', 'provider', 'test']);
    expect(deps.get('provider')?.range).toBe('^6.0.0');
    expect(deps.get('provider')?.section).toBe('dependencies');
    expect(deps.get('test')?.section).toBe('dev_dependencies');

    const tabbed = 'dependencies:\n\thttp: ^1.2.0\n\tprovider: ^6.0.0\n';
    expect([...parseDeclaredDependencies(tabbed, 'pubspec.yaml').keys()]).toEqual([
      'http',
      'provider',
    ]);

    // The production consequence: a new package in a 4-space block is reported.
    const before = parseDeclaredDependencies('dependencies:\n    http: ^1.2.0\n', 'pubspec.yaml');
    const after = parseDeclaredDependencies(four, 'pubspec.yaml');
    const delta = diffDeclaredDependencies(before, after);
    expect(delta.added.map((d) => d.name).sort()).toEqual(['provider', 'test']);
    expect(hasDependencyChanges(delta)).toBe(true);
  });

  it('reports a map-form pubspec dependency and never its nested option keys', () => {
    // `pkg:` with a nested git/sdk/path map declares a package with no range,
    // exactly like bare `flask` in requirements.txt or `gem "puma"`.
    const deps = parseDeclaredDependencies(
      [
        'dependencies:',
        '  sdk_pkg:',
        '    git:',
        '      url: git@github.com:acme/sdk.git',
        '      ref: v1.0.0',
        '  flutter:',
        '    sdk: flutter',
        '  http: ^1.2.0',
      ].join('\n'),
      'pubspec.yaml',
    );
    expect(deps.get('sdk_pkg')?.range).toBe('');
    expect(deps.get('flutter')?.range).toBe('');
    expect(deps.get('http')?.range).toBe('^1.2.0');
    // The depth model, not a hard-coded indent, keeps options out.
    for (const optionKey of ['git', 'url', 'ref', 'sdk']) {
      expect(deps.has(optionKey)).toBe(false);
    }
  });

  it('ends the pubspec dependency block at the next top-level key', () => {
    // Comment lines are stripped before the indent test, so a whole-line
    // comment cannot be read as ending the block.
    const deps = parseDeclaredDependencies(
      [
        'dependencies:',
        '  # shared tooling',
        '  http: ^1.2.0',
        '  sdk_pkg:',
        '    git: git@github.com:acme/sdk.git',
        'flutter:',
        '  uses-material-design: true',
        'dependency_overrides:',
        '  ffi:',
        '    path: ../ffi',
      ].join('\n'),
      'pubspec.yaml',
    );
    expect([...deps.keys()]).toEqual(['http', 'sdk_pkg']);
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
