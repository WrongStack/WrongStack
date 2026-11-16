import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractImports } from '../src/codebase-index/import-extractor.js';
import { ModuleResolver } from '../src/codebase-index/module-resolver.js';
import { detectModuleRoots, type ProjectStructure } from '../src/codebase-index/module-roots.js';

describe('rust import extraction', () => {
  it('reads restricted-visibility and glob imports', () => {
    const refs = extractImports({
      lang: 'rs',
      content: [
        'pub(crate) use crate::net::Client;',
        'pub(in crate::a) mod http;',
        'use crate::prelude::*;',
      ].join('\n'),
    });
    expect(refs.map((r) => r.module)).toEqual(['crate::net::Client', 'crate::prelude', 'http']);
  });
});

describe('rust module resolution', () => {
  const structure: ProjectStructure = {
    projectRoot: '/r',
    roots: [
      { dir: '/r', kind: 'cargo', name: 'crate:demo', importPath: 'demo', sourceRoots: ['/r/src'] },
    ],
  };
  const resolver = new ModuleResolver(structure, [
    '/r/src/main.rs',
    '/r/src/net.rs',
    '/r/src/net/http.rs',
    '/r/src/net/tls.rs',
    '/r/src/util/mod.rs',
    '/r/src/util/fmt.rs',
  ]);

  it.each([
    ['/r/src/net/http.rs', 'super::tls::Config', '/r/src/net/tls.rs'],
    ['/r/src/net.rs', 'self::http::get', '/r/src/net/http.rs'],
    ['/r/src/net.rs', 'http', '/r/src/net/http.rs'],
    ['/r/src/net/http.rs', 'super::helper', '/r/src/net.rs'],
    ['/r/src/util/mod.rs', 'super::net', '/r/src/net.rs'],
    ['/r/src/util/fmt.rs', 'crate::net::http::Client::new', '/r/src/net/http.rs'],
    ['/r/src/net.rs', 'crate::Config', '/r/src/main.rs'],
  ])('%s: %s', (from, spec, expected) => {
    expect(resolver.resolve(from, 'rs', spec)).toBe(expected);
  });

  it('leaves external crates unresolved', () => {
    expect(resolver.resolve('/r/src/net.rs', 'rs', 'serde::Deserialize')).toBeUndefined();
  });
});

describe('module resolver maps', () => {
  it('never resolves a path three spellings collide on', () => {
    const resolver = new ModuleResolver({ projectRoot: '/r', roots: [] }, [
      '/r/src/Foo.py',
      '/r/src/foo.py',
      '/r/src/FOO.py',
    ]);
    expect(resolver.resolve('/r/main.py', 'py', 'src.foo')).toBeUndefined();
  });

  it('resolves static and nested JVM imports to the declaring file', () => {
    const resolver = new ModuleResolver(
      {
        projectRoot: '/j',
        roots: [{ dir: '/j', kind: 'maven', name: 'mvn:x', sourceRoots: ['/j/src/main/java'] }],
      },
      ['/j/src/main/java/com/ex/Util.java', '/j/src/main/java/com/ex/Outer.java'],
    );
    const from = '/j/src/main/java/com/ex/App.java';
    expect(resolver.resolve(from, 'java', 'com.ex.Util.helper')).toBe(
      '/j/src/main/java/com/ex/Util.java',
    );
    expect(resolver.resolve(from, 'java', 'com.ex.Outer.Inner')).toBe(
      '/j/src/main/java/com/ex/Outer.java',
    );
    expect(resolver.resolve(from, 'java', 'com.ex.Util.*')).toBe(
      '/j/src/main/java/com/ex/Util.java',
    );
    expect(resolver.resolve(from, 'java', 'com.ex.Nope.a.b')).toBeUndefined();
  });
});

describe('npm roots', () => {
  it('only a declared package name is importable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-npm-roots-'));
    const write = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), text);
    };
    try {
      await write('vendor/react/package.json', '{}');
      await write('vendor/react/index.js', 'export {};');
      await write('packages/lib/package.json', '{"name":"@x/lib"}');
      await write('packages/lib/src/index.ts', 'export const a = 1;');
      await write('src/app.ts', "import 'react';");
      const files = ['vendor/react/index.js', 'packages/lib/src/index.ts', 'src/app.ts'].map((f) =>
        path.join(root, f),
      );
      const structure = await detectModuleRoots(root, files);
      const resolver = new ModuleResolver(structure, files);
      const app = path.join(root, 'src/app.ts');
      expect(resolver.resolve(app, 'ts', 'react')).toBeUndefined();
      expect(resolver.resolve(app, 'ts', '@x/lib')).toBe(
        path.join(root, 'packages/lib/src/index.ts'),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('detects every root of a many-package tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-npm-many-'));
    try {
      const files: string[] = [];
      for (let i = 0; i < 120; i++) {
        const dir = path.join(root, 'packages', `p${i}`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `@m/p${i}` }));
        await fs.writeFile(path.join(dir, 'index.ts'), '');
        files.push(path.join(dir, 'index.ts'));
      }
      const structure = await detectModuleRoots(root, files);
      expect(structure.roots.filter((r) => r.kind === 'npm')).toHaveLength(120);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reads package name from BOM-prefixed package.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-npm-bom-'));
    try {
      const dir = path.join(root, 'packages', 'alpha');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'package.json'),
        `\uFEFF${JSON.stringify({ name: '@acme/alpha' })}`,
      );
      const file = path.join(dir, 'index.ts');
      await fs.writeFile(file, '');
      const structure = await detectModuleRoots(root, [file]);
      expect(structure.roots.some((r) => r.name === '@acme/alpha')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
