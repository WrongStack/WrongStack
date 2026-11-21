import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmAdapter } from '../../src/adapters/npm.js';
import { parseYarnLockVersions } from '../../src/adapters/npm-lockfile-parse.js';
import { PythonAdapter, parsePoetryLock } from '../../src/adapters/python.js';
import { RustAdapter } from '../../src/adapters/rust.js';
import type { SourceType, Workspace } from '../../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ts-quoting-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function workspace(
  relativeRoot: string,
  ecosystem: Workspace['ecosystem'],
  manifests: string[],
  lockfiles: string[] = [],
): Workspace {
  return {
    id: `ws-${ecosystem}`,
    relativeRoot,
    ecosystem,
    manifests,
    lockfiles,
    confidence: 0.9,
    coverage: 'full',
  };
}

const CARGO_LOCK =
  '[[package]]\nname = "serde"\nversion = "1.0.215"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n' +
  '[[package]]\nname = "tokio"\nversion = "1.40.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';

describe('manifest quoting and section boundaries', () => {
  it('F995: a Poetry group settings table is not a dependency table', async () => {
    const dir = fixture({
      'pyproject.toml':
        '[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^5.2"\n' +
        '[tool.poetry.group.docs]\noptional = true\n' +
        '[tool.poetry.group.docs.dependencies]\nmkdocs = "^1.6"\n',
    });
    const deps = await new PythonAdapter().inventory(
      workspace(dir, 'python', ['pyproject.toml']),
      {},
    );
    expect(deps.map((d) => d.name).sort()).toEqual(['django', 'mkdocs']);
  });

  it('F996: a yarn npm alias is inventoried under the package it installs', async () => {
    const lock =
      '"ts5@npm:typescript@5.9.3":\n  version "5.9.3"\n\n' +
      '"string-width-cjs@npm:string-width@^4.2.0":\n  version "4.2.3"\n';
    const parsed = parseYarnLockVersions(lock);
    expect([...parsed.versions.keys()].sort()).toEqual(['string-width', 'typescript']);
    expect(parsed.specs.get('ts5@typescript@5.9.3')).toBe('5.9.3');

    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { ts5: 'npm:typescript@5.9.3' },
      }),
      'yarn.lock': lock,
    });
    const deps = await new NpmAdapter().inventory(
      workspace(dir, 'npm', ['package.json'], ['yarn.lock']),
      { includeTransitive: true },
    );
    expect(deps.map((d) => d.purl).sort()).toEqual([
      'pkg:npm/string-width@4.2.3',
      'pkg:npm/typescript@5.9.3',
    ]);
  });

  it('F997: Cargo.toml literal strings keep the dependency and its version', async () => {
    const dir = fixture({
      'Cargo.toml':
        "[package]\nname = 'x'\n\n[dependencies]\nserde = '1.0'\ntokio = { version = '1.40' }\n",
      'Cargo.lock': CARGO_LOCK,
    });
    const deps = await new RustAdapter().inventory(
      workspace(dir, 'rust', ['Cargo.toml'], ['Cargo.lock']),
      {},
    );
    expect(deps.map((d) => `${d.name}:${d.requested}:${d.purl}`).sort()).toEqual([
      'serde:1.0:pkg:cargo/serde@1.0.215',
      'tokio:1.40:pkg:cargo/tokio@1.40.0',
    ]);
  });

  it('F998: a commented [workspace] header still marks the Cargo workspace root', async () => {
    const root = fixture({
      'Cargo.toml':
        '[workspace]  # members below\nmembers = ["crates/app"]\n\n[workspace.dependencies]\nserde = "1.0"\n',
      'Cargo.lock': CARGO_LOCK,
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n\n[dependencies]\nserde = { workspace = true }\n',
    });
    const deps = await new RustAdapter().inventory(
      workspace('crates/app', 'rust', ['Cargo.toml']),
      { projectRoot: root },
    );
    expect(deps.find((d) => d.name === 'serde')).toMatchObject({
      requested: '1.0',
      locked: '1.0.215',
      purl: 'pkg:cargo/serde@1.0.215',
    });
  });

  it("F999: a version-less uv.lock entry's source is not filed under the previous package", () => {
    const sources = new Map<string, SourceType>();
    const versions = parsePoetryLock(
      'version = 1\n\n' +
        '[[package]]\nname = "idna"\nversion = "3.10"\nsource = { registry = "https://pypi.org/simple" }\n\n' +
        '[[package]]\nname = "myproj"\nsource = { editable = "." }\n',
      sources,
    );
    expect(versions.get('idna')).toBe('3.10');
    expect(sources.get('idna')).toBe('registry');
  });
});
