/**
 * Cross-language dependency edges.
 *
 * The Code Atlas used to draw edges for TypeScript only: every other language
 * contributed symbols but no relations, so a Go or Python repo rendered as
 * disconnected dots. These tests pin the pieces that changed — regex import
 * extraction, ecosystem-aware project structure, module resolution — and then
 * prove the whole chain end to end by indexing a real polyglot tree and asking
 * for the graphs the WebUI asks for.
 */

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from '@wrongstack/core/agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractImports } from '../src/codebase-index/import-extractor.js';
import { runIndexer } from '../src/codebase-index/indexer.js';
import { ModuleResolver } from '../src/codebase-index/module-resolver.js';
import { assignPackageLabels, detectModuleRoots } from '../src/codebase-index/module-roots.js';
import { IndexStore } from '../src/codebase-index/writer.js';

const ctx = {} as Context;

describe('import extraction for languages without an AST parser', () => {
  it.each([
    ['java' as const, 'import com.example.util.Helper;', 'com.example.util.Helper', 'Helper'],
    ['csharp' as const, 'using Example.Util;', 'Example.Util', 'Example.Util'],
    ['rs' as const, 'use crate::parser::Token;', 'crate::parser::Token', 'Token'],
    ['rs' as const, 'pub mod lexer;', 'lexer', 'lexer'],
    ['c' as const, '#include "engine/core.h"', 'engine/core.h', 'core'],
    ['ruby' as const, "require_relative 'lib/thing'", 'lib/thing', 'thing'],
    ['php' as const, 'use App\\Models\\User;', 'App\\Models\\User', 'User'],
    ['swift' as const, 'import Foundation', 'Foundation', 'Foundation'],
    ['elixir' as const, 'alias MyApp.Repo', 'MyApp.Repo', 'MyApp.Repo'],
    ['haskell' as const, 'import qualified Data.Map', 'Data.Map', 'Data.Map'],
    ['zig' as const, 'const std = @import("std");', 'std', 'std'],
    ['dart' as const, "import 'package:app/model.dart';", 'package:app/model.dart', 'model'],
    ['proto' as const, 'import "common/types.proto";', 'common/types.proto', 'types'],
    ['css' as const, '@import "theme/dark.css";', 'theme/dark.css', 'dark'],
  ])('%s: %s', (lang, source, expectedModule, expectedName) => {
    const refs = extractImports({ content: source, lang });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      callType: 'import',
      module: expectedModule,
      toName: expectedName,
      lang,
    });
  });

  it('ignores angle-bracket includes, which name no file in the project', () => {
    expect(extractImports({ content: '#include <stdio.h>', lang: 'c' })).toEqual([]);
  });

  it('reports the line each import appears on', () => {
    const refs = extractImports({
      content: 'package demo;\n\nimport a.B;\nimport c.D;\n',
      lang: 'java',
    });
    expect(refs.map((ref) => ref.line)).toEqual([3, 4]);
  });

  it('caps runaway files instead of scanning without bound', () => {
    const content = Array.from({ length: 900 }, (_, i) => `import p.M${i};`).join('\n');
    expect(extractImports({ content, lang: 'java', maxImports: 50 })).toHaveLength(50);
  });
});

// ─── Polyglot fixture ─────────────────────────────────────────────────────────

/**
 * A small repository containing four ecosystems, each with a real manifest and
 * a genuine cross-file dependency.
 */
const FIXTURE: Record<string, string> = {
  // Go: module path from go.mod, package == directory.
  'go/go.mod': 'module example.com/demo\n\ngo 1.22\n',
  'go/cmd/main.go': [
    'package main',
    '',
    'import "example.com/demo/internal/util"',
    '',
    'func main() {',
    '\tutil.Helper()',
    '}',
    '',
  ].join('\n'),
  'go/internal/util/util.go': ['package util', '', 'func Helper() {}', ''].join('\n'),

  // Python: src layout, dotted packages from the __init__.py chain.
  'py/pyproject.toml': '[project]\nname = "demo"\n',
  'py/src/demo/__init__.py': '',
  'py/src/demo/api.py': 'from demo.sub.core import run\n\n\ndef handle():\n    return run()\n',
  'py/src/demo/sub/__init__.py': '',
  'py/src/demo/sub/core.py': 'def run():\n    return 1\n',

  // Rust: crate from Cargo.toml, modules relative to src/.
  'rust/Cargo.toml': '[package]\nname = "demo-rs"\nversion = "0.1.0"\n',
  'rust/src/lib.rs': 'mod parser;\n\npub use crate::parser::Token;\n',
  'rust/src/parser.rs': 'pub struct Token;\n',

  // JVM: Maven layout, package path mirrors the directory tree.
  'java/pom.xml': '<project><artifactId>demo-java</artifactId></project>',
  'java/src/main/java/com/example/App.java': [
    'package com.example;',
    '',
    'import com.example.util.Helper;',
    '',
    'public class App {',
    '  public void run() { Helper.go(); }',
    '}',
    '',
  ].join('\n'),
  'java/src/main/java/com/example/util/Helper.java': [
    'package com.example.util;',
    '',
    'public class Helper {',
    '  public static void go() {}',
    '}',
    '',
  ].join('\n'),

  // C#: `using` names a namespace, which no path can be derived from — it
  // resolves against the indexed `namespace` declaration instead.
  'cs/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
  'cs/Program.cs': [
    'using Example.Services;',
    '',
    'namespace Example.Cli;',
    '',
    'class Program { void Main() { } }',
    '',
  ].join('\n'),
  'cs/Services/Service.cs': [
    'namespace Example.Services;',
    '',
    'public class Service { }',
    '',
  ].join('\n'),
};

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-multilang-'));
  for (const [relative, contents] of Object.entries(FIXTURE)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const at = (relative: string): string => path.join(root, relative);

describe('project structure detection', () => {
  it('labels files by the grouping their own ecosystem uses', async () => {
    const files = Object.keys(FIXTURE).map(at);
    const structure = await detectModuleRoots(root, files);
    const labels = assignPackageLabels(structure, files);

    // Go: one package per directory, named by import path.
    expect(labels.get(at('go/cmd/main.go'))).toBe('example.com/demo/cmd');
    expect(labels.get(at('go/internal/util/util.go'))).toBe('example.com/demo/internal/util');

    // Python: the dotted package from the __init__.py chain.
    expect(labels.get(at('py/src/demo/api.py'))).toBe('py:demo');
    expect(labels.get(at('py/src/demo/sub/core.py'))).toBe('py:demo.sub');

    // Cargo and Maven: one node per crate / project.
    expect(labels.get(at('rust/src/parser.rs'))).toBe('crate:demo-rs');
    expect(labels.get(at('java/src/main/java/com/example/App.java'))).toBe('mvn:demo-java');
  });
});

describe('module resolution', () => {
  it('resolves specifiers to files across ecosystems', async () => {
    const files = Object.keys(FIXTURE).map(at);
    const structure = await detectModuleRoots(root, files);
    const resolver = new ModuleResolver(structure, files);

    expect(resolver.resolve(at('go/cmd/main.go'), 'go', 'example.com/demo/internal/util')).toBe(
      at('go/internal/util/util.go'),
    );

    expect(resolver.resolve(at('py/src/demo/api.py'), 'py', 'demo.sub.core')).toBe(
      at('py/src/demo/sub/core.py'),
    );

    expect(resolver.resolve(at('rust/src/lib.rs'), 'rs', 'parser')).toBe(at('rust/src/parser.rs'));
    expect(resolver.resolve(at('rust/src/lib.rs'), 'rs', 'crate::parser::Token')).toBe(
      at('rust/src/parser.rs'),
    );

    expect(
      resolver.resolve(
        at('java/src/main/java/com/example/App.java'),
        'java',
        'com.example.util.Helper',
      ),
    ).toBe(at('java/src/main/java/com/example/util/Helper.java'));
  });

  it('resolves namespace specifiers against declarations, not paths', async () => {
    const files = Object.keys(FIXTURE).map(at);
    const structure = await detectModuleRoots(root, files);
    const namespaces = [
      { name: 'Example.Services', file: at('cs/Services/Service.cs') },
      { name: 'Example.Cli', file: at('cs/Program.cs') },
    ];
    const resolver = new ModuleResolver(structure, files, namespaces);

    expect(resolver.resolve(at('cs/Program.cs'), 'csharp', 'Example.Services')).toBe(
      at('cs/Services/Service.cs'),
    );
    // `using Example.Services.Thing` names a type inside the namespace; the
    // declared prefix is what resolves.
    expect(resolver.resolve(at('cs/Program.cs'), 'csharp', 'Example.Services.Thing')).toBe(
      at('cs/Services/Service.cs'),
    );
    expect(resolver.resolve(at('cs/Program.cs'), 'csharp', 'System.Linq')).toBeUndefined();
  });

  it('does not match a namespace declared by an unrelated language', async () => {
    const files = Object.keys(FIXTURE).map(at);
    const structure = await detectModuleRoots(root, files);
    // `package util` in Go and `# util` in Markdown are both indexed with kind
    // 'namespace'. A C# `using util` must not bind to either.
    const resolver = new ModuleResolver(structure, files, [
      { name: 'util', file: at('go/internal/util/util.go') },
    ]);
    expect(resolver.resolve(at('cs/Program.cs'), 'csharp', 'util')).toBeUndefined();
  });

  it('leaves external and stdlib modules unresolved rather than guessing', async () => {
    const files = Object.keys(FIXTURE).map(at);
    const structure = await detectModuleRoots(root, files);
    const resolver = new ModuleResolver(structure, files);

    expect(resolver.resolve(at('go/cmd/main.go'), 'go', 'fmt')).toBeUndefined();
    expect(resolver.resolve(at('go/cmd/main.go'), 'go', 'github.com/other/pkg')).toBeUndefined();
    expect(resolver.resolve(at('py/src/demo/api.py'), 'py', 'os.path')).toBeUndefined();
  });
});

describe('schema self-repair', () => {
  /** Tables in the shape an older build creates, with no v5 columns. */
  const LEGACY_TABLES = [
    'CREATE TABLE files (file TEXT PRIMARY KEY, lang TEXT NOT NULL, mtime_ms INTEGER NOT NULL, symbol_count INTEGER NOT NULL DEFAULT 0, last_indexed INTEGER NOT NULL)',
    "CREATE TABLE symbols (id INTEGER PRIMARY KEY, lang TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL, signature TEXT NOT NULL DEFAULT '', doc_comment TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '')",
    'CREATE TABLE refs (id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_name TEXT NOT NULL, to_id INTEGER, call_type TEXT NOT NULL, line INTEGER NOT NULL)',
  ];
  /** The v4 shape: symbols carried a redundant file_fk column + index. */
  const V4_SYMBOLS =
    "CREATE TABLE symbols (id INTEGER PRIMARY KEY, lang TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL, signature TEXT NOT NULL DEFAULT '', doc_comment TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', file_fk TEXT NOT NULL)";

  function legacyIndex(version: string | null): { projectRoot: string; indexDir: string } {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'ws-legacy-'));
    const indexDir = path.join(projectRoot, '.idx');
    mkdirSync(indexDir, { recursive: true });
    const db = new DatabaseSync(path.join(indexDir, 'index.db'));
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (version !== null) {
      db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('version', version);
    }
    for (const sql of LEGACY_TABLES) db.exec(sql);
    db.close();
    return { projectRoot, indexDir };
  }

  // Regression: several wstack processes share one index database. During a
  // version rollout an older build can drop and recreate the tables from its
  // own DDL while the metadata version already reads the new number, so the
  // version check never fires again and every query for a new column fails
  // with `no such column: package` — permanently, reindexing included.
  it.each([
    ['the stored version already matches', '5'],
    ['the stored version is missing entirely', null],
  ])('adds columns an older build left out when %s', (_label, version) => {
    const { projectRoot, indexDir } = legacyIndex(version);
    const store = new IndexStore(projectRoot, { indexDir });
    try {
      expect(() => store.getFilePackages()).not.toThrow();
      expect(() => store.getPackageGraph()).not.toThrow();
      expect(() => store.resolveRefs()).not.toThrow();
      expect(() => store.getUnresolvedImports()).not.toThrow();
    } finally {
      store.close();
    }
    expect(existsSync(path.join(indexDir, 'index.db'))).toBe(true);
  });

  it('preserves existing rows rather than rebuilding the index', () => {
    const { projectRoot, indexDir } = legacyIndex('5');
    const db = new DatabaseSync(path.join(indexDir, 'index.db'));
    db.prepare(
      'INSERT INTO files(file, lang, mtime_ms, symbol_count, last_indexed) VALUES (?,?,?,?,?)',
    ).run('/repo/a.ts', 'ts', 1, 0, 1);
    db.close();

    const store = new IndexStore(projectRoot, { indexDir });
    try {
      expect(store.getAllFileMetas().map((meta) => meta.file)).toEqual(['/repo/a.ts']);
      // The added column starts blank; the next index run fills it in.
      expect(store.getFilePackages().size).toBe(0);
    } finally {
      store.close();
    }
  });

  // P4.13: v4 DBs carried symbols.file_fk (a redundant duplicate of file) and
  // idx_s_file_fk. A version mismatch wipes and rebuilds the derived index,
  // so opening a v4 DB must leave a v5-shaped symbols table with no file_fk
  // column or index — writes and searches work through `file` alone.
  it('rebuilds a v4 database with file_fk into the v5 shape', () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'ws-legacy-v4-'));
    const indexDir = path.join(projectRoot, '.idx');
    mkdirSync(indexDir, { recursive: true });
    const db = new DatabaseSync(path.join(indexDir, 'index.db'));
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('version', '4');
    db.exec(
      'CREATE TABLE files (file TEXT PRIMARY KEY, lang TEXT NOT NULL, mtime_ms INTEGER NOT NULL, symbol_count INTEGER NOT NULL DEFAULT 0, last_indexed INTEGER NOT NULL)',
    );
    db.exec(V4_SYMBOLS);
    db.exec('CREATE INDEX idx_s_file_fk ON symbols(file_fk)');
    db.prepare(
      "INSERT INTO symbols(id, lang, kind, name, file, line, col, file_fk) VALUES (1, 'ts', 'function', 'stale', '/repo/old.ts', 1, 1, '/repo/old.ts')",
    ).run();
    db.close();

    const store = new IndexStore(projectRoot, { indexDir });
    store.close();
    // Schema assertions over a raw connection — never reach into store.db
    // (private); the shape is identical before and after close.
    const raw = new DatabaseSync(path.join(indexDir, 'index.db'));
    try {
      const columns = (
        raw.prepare('PRAGMA table_info(symbols)').all() as Array<{ name?: unknown }>
      ).flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
      expect(columns).not.toContain('file_fk');
      const indexes = (
        raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbols'")
          .all() as Array<{ name?: unknown }>
      ).flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
      expect(indexes).not.toContain('idx_s_file_fk');
      const version = raw.prepare("SELECT value FROM metadata WHERE key = 'version'").get() as {
        value?: unknown;
      };
      expect(String(version.value)).toBe('5');
    } finally {
      raw.close();
    }
    // Wiped, not carried over: the stale v4 row must be gone from a freshly
    // reopened store (also proves the rebuilt index is queryable).
    const verify = new IndexStore(projectRoot, { indexDir });
    try {
      expect(verify.searchRanked('stale', undefined, 10).total).toBe(0);
    } finally {
      verify.close();
    }
  });
});

describe('end-to-end polyglot Code Atlas graphs', () => {
  let store: IndexStore;

  beforeAll(async () => {
    const indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-multilang-idx-'));
    const result = await runIndexer(ctx, { projectRoot: root, indexDir });
    expect(result.errors).toEqual([]);
    expect(result.filesIndexed).toBeGreaterThan(0);
    store = new IndexStore(root, { indexDir });
  });

  afterAll(() => {
    store.close();
  });

  /** Does the file graph for `pkg` contain an edge from `from` to `to`? */
  const hasFileEdge = (pkg: string, from: string, to: string): boolean =>
    store
      .getFileGraph(pkg)
      .edges.some((edge) => edge.source === `file:${at(from)}` && edge.target === `file:${at(to)}`);

  it('draws Go import edges between package directories', () => {
    expect(hasFileEdge('example.com/demo/cmd', 'go/cmd/main.go', 'go/internal/util/util.go')).toBe(
      true,
    );
  });

  it('draws Python import edges between modules', () => {
    expect(hasFileEdge('py:demo', 'py/src/demo/api.py', 'py/src/demo/sub/core.py')).toBe(true);
  });

  it('draws Rust module edges within a crate', () => {
    expect(hasFileEdge('crate:demo-rs', 'rust/src/lib.rs', 'rust/src/parser.rs')).toBe(true);
  });

  it('draws C# edges from namespace declarations', () => {
    expect(hasFileEdge('csproj:App', 'cs/Program.cs', 'cs/Services/Service.cs')).toBe(true);
  });

  it('draws JVM import edges across packages', () => {
    expect(
      hasFileEdge(
        'mvn:demo-java',
        'java/src/main/java/com/example/App.java',
        'java/src/main/java/com/example/util/Helper.java',
      ),
    ).toBe(true);
  });

  it('groups the package graph by ecosystem and connects Go packages', () => {
    const graph = store.getPackageGraph();
    const labels = graph.nodes.map((node) => node.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'example.com/demo/cmd',
        'example.com/demo/internal/util',
        'crate:demo-rs',
        'mvn:demo-java',
      ]),
    );
    // refType is the edge's *dominant* relation. `import "…/util"` plus the
    // `util.Helper()` call that follows contribute one each, so which one wins
    // is a tie — the edge existing is the assertion that matters.
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'pkg:example.com/demo/cmd',
          target: 'pkg:example.com/demo/internal/util',
        }),
      ]),
    );
  });

  it('does not link same-named symbols across languages', () => {
    // `Helper` is declared in both Go and Java here. A global name match would
    // resolve the Go call to the Java class and draw an edge between two files
    // that have nothing to do with each other.
    const goPackage = store.getFileGraph('example.com/demo/cmd');
    const javaFile = at('java/src/main/java/com/example/util/Helper.java');
    expect(goPackage.edges.some((edge) => edge.target === `file:${javaFile}`)).toBe(false);
  });
});
