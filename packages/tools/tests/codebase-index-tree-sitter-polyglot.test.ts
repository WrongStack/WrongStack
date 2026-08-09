/**
 * Day 14 polyglot fixture — end-to-end runIndexer over a 10-ecosystem
 * polyglot tree, asserting that the tree-sitter parser produces indexed
 * symbols for every language P1 wired to it.
 *
 * Scope is intentionally narrower than the existing
 * `codebase-index-multilang-relations.test.ts`:
 *  - that test verifies cross-file edges for ecosystems with a project
 *    manifest detector (Maven, .NET, Cargo, Go, Python);
 *  - this test verifies *symbol emission* per ecosystem, which is the
 *    sole new contract P1 introduces. The languages P1 wires to
 *    tree-sitter (C/C++/PHP/Ruby/Swift/Kotlin/Elixir/Shell) have no
 *    manifest detector, so the indexer groups them under a single
 *    `(root)` package and never draws a file-graph edge — meaning
 *    cross-file edges would be untestable here even if the AST
 *    visitor later learns to emit import refs.
 *
 * The Day 2-3 smoke spec (`codebase-index-tree-sitter-smoke.test.ts`)
 * still verifies the per-language query tables in isolation.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIndexer } from '../src/codebase-index/indexer.js';
import { IndexStore } from '../src/codebase-index/writer.js';

const ctx = {} as Context;

interface EcosystemEntry {
  /** Short language id used in test names. */
  root: string;
  files: Record<string, string>;
  /**
   * Minimum number of indexed symbols the ecosystem must produce.
   * Aggregated across all files in the fixture rather than per-file
   * because a Ruby script that is just `require_relative + puts` has
   * zero declarations by design — non-zero per-file would be wrong.
   */
  minSymbols: number;
}

const FIXTURE: EcosystemEntry[] = [
  {
    root: 'c',
    files: {
      'engine/core.h': 'int helper(int x);\n',
      'engine/core.c': '#include "engine/core.h"\nint helper(int x) { return x + 1; }\n',
    },
    minSymbols: 2,
  },
  {
    root: 'cpp',
    files: {
      'src/parser.h': 'namespace app { class Parser; }\n',
      'src/parser.cpp':
        '#include "src/parser.h"\nnamespace app { class Parser { public: int parse(); }; }\n',
    },
    minSymbols: 2,
  },
  {
    root: 'java',
    files: {
      'src/main/java/com/example/Helper.java': [
        'package com.example;',
        '',
        'public class Helper {',
        '  public static int go() { return 1; }',
        '}',
        '',
      ].join('\n'),
      'src/main/java/com/example/App.java': [
        'package com.example;',
        '',
        'public class App {',
        '  public static void main(String[] args) { Helper.go(); }',
        '}',
        '',
      ].join('\n'),
    },
    minSymbols: 4,
  },
  {
    root: 'cs',
    files: {
      'Services/Service.cs': ['namespace Demo.Services;', '', 'public class Service { }', ''].join(
        '\n',
      ),
      'Program.cs': [
        'using Demo.Services;',
        '',
        'namespace Demo.Cli;',
        '',
        'class Program { }',
        '',
      ].join('\n'),
    },
    minSymbols: 4,
  },
  {
    root: 'php',
    files: {
      'src/util.php':
        '<?php\nnamespace App\\Util;\nfunction greet(string $name): string { return "hi $name"; }\n',
      'src/app.php':
        '<?php\nnamespace App;\nuse App\\Util\\greet;\nrequire_once __DIR__ . "/util.php";\necho greet("world");\n',
    },
    minSymbols: 1,
  },
  {
    root: 'ruby',
    files: {
      'lib/greet.rb': 'module App\n  def self.greet(name)\n    "hi #{name}"\n  end\nend\n',
      'bin/app.rb': 'require_relative "../lib/greet"\nputs App.greet("world")\n',
    },
    minSymbols: 1,
  },
  {
    root: 'swift',
    files: {
      'Sources/App/main.swift': 'class App {\n  func greet() -> String { return "hi" }\n}\n',
    },
    minSymbols: 2,
  },
  {
    root: 'kotlin',
    files: {
      'src/main/kotlin/Greet.kt': 'fun greet(name: String): String = "hi $name"\nclass App\n',
    },
    minSymbols: 2,
  },
  {
    root: 'elixir',
    files: {
      'lib/greet.ex': 'defmodule App.Greet do\n  def greet(name), do: "hi #{name}"\nend\n',
    },
    minSymbols: 2,
  },
  {
    root: 'shell',
    files: {
      'bin/greet.sh': '#!/usr/bin/env bash\ngreet() {\n  echo "hi"\n}\n\ngreet\n',
    },
    minSymbols: 1,
  },
];

let root: string;
let indexDir: string;
let store: IndexStore;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ts-polyglot-'));
  for (const eco of FIXTURE) {
    for (const [rel, content] of Object.entries(eco.files)) {
      const target = path.join(root, eco.root, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
  }
  indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ts-polyglot-idx-'));
  const result = await runIndexer(ctx, { projectRoot: root, indexDir });
  expect(result.errors).toEqual([]);
  store = new IndexStore(root, { indexDir });
});

afterAll(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(indexDir, { recursive: true, force: true });
});

describe('tree-sitter polyglot fixture — symbol coverage per ecosystem', () => {
  /**
   * The indexer assigns every file to a package. Lacking a manifest
   * detector, the tree-sitter languages all fall under `(root)`, so the
   * test aggregates across all packages rather than asserting each
   * ecosystem ended up in its own group.
   */
  for (const eco of FIXTURE) {
    it(`${eco.root}: indexes at least ${eco.minSymbols} symbols across the fixture`, () => {
      const allMetas = store.getAllFileMetas();
      const ecoFiles = new Set(Object.keys(eco.files).map((rel) => path.join(root, eco.root, rel)));
      const ecoMetas = allMetas.filter((m) => ecoFiles.has(m.file));
      expect(ecoMetas.length).toBeGreaterThan(0);
      const totalSymbols = ecoMetas.reduce((sum, m) => sum + m.symbolCount, 0);
      expect(totalSymbols).toBeGreaterThanOrEqual(eco.minSymbols);
    });
  }
});
