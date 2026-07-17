import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLanguageWorkspaces } from '../src/languages/index.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-languages-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function file(relative: string, content = ''): Promise<string> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

describe('detectLanguageWorkspaces', () => {
  it('detects a polyglot repository with stable sorted evidence', async () => {
    await Promise.all([
      file('web/package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0' })),
      file('web/tsconfig.json', '{}'),
      file('web/pnpm-lock.yaml'),
      file('web/src/index.ts'),
      file('go/go.mod', 'module example.com/go'),
      file('go/main.go', 'package main'),
      file('rust/Cargo.toml', '[package]\nname="x"'),
      file('rust/src/lib.rs'),
      file('php/composer.json', '{}'),
      file('php/index.php', '<?php'),
      file('dotnet/App.csproj', '<Project />'),
      file('dotnet/Program.cs'),
    ]);

    const first = await detectLanguageWorkspaces({ projectRoot: root });
    const second = await detectLanguageWorkspaces({ projectRoot: root });
    expect(first).toEqual(second);
    expect(first.truncated).toBe(false);
    expect(first.workspaces.map((item) => item.language)).toEqual([
      'javascript',
      'typescript',
      'csharp',
      'go',
      'php',
      'rust',
    ]);
    const ts = first.workspaces.find((item) => item.language === 'typescript')!;
    expect(ts.root).toBe(path.join(root, 'web'));
    expect(ts.packageManager).toBe('pnpm');
    expect(ts.confidence).toBe(1);
    expect(ts.evidence.map((item) => item.path)).toEqual(
      [...ts.evidence.map((item) => item.path)].sort(),
    );
  });

  it('selects the deepest containing same-language workspace for target evidence', async () => {
    await file('package.json', '{}');
    await file('tsconfig.json', '{}');
    await file('packages/app/package.json', '{}');
    await file('packages/app/tsconfig.json', '{}');
    const target = await file('packages/app/src/main.ts');

    const result = await detectLanguageWorkspaces({
      projectRoot: root,
      target,
      language: 'typescript',
    });
    const targeted = result.workspaces.find((item) =>
      item.evidence.some((evidence) => evidence.kind === 'target'),
    );
    expect(targeted?.root).toBe(path.join(root, 'packages', 'app'));
  });

  it('uses source files as bounded fallback without inventing manifests', async () => {
    for (let i = 0; i < 20; i++) await file(`src/file-${i}.go`, 'package p');
    const result = await detectLanguageWorkspaces({ projectRoot: root, language: 'go' });
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.manifests).toEqual([]);
    expect(result.workspaces[0]?.evidence).toHaveLength(5);
    expect(result.workspaces[0]?.confidence).toBe(0.25);
  });

  it('obeys entry/depth bounds and skips symlink traversal', async () => {
    await file('go.mod', 'module x');
    await file('deep/one/two/three/main.go', 'package main');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-languages-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'Cargo.toml'), '[package]');
      try {
        await fs.symlink(outside, path.join(root, 'linked-outside'), 'junction');
      } catch {
        // Symlink creation can be unavailable on constrained Windows runners.
      }
      const result = await detectLanguageWorkspaces({
        projectRoot: root,
        limits: { maxDepth: 1, maxEntries: 3 },
      });
      expect(result.truncated).toBe(true);
      expect(result.scannedEntries).toBeLessThanOrEqual(3);
      expect(result.workspaces.some((item) => item.language === 'rust')).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects cwd and target paths outside the project', async () => {
    await expect(
      detectLanguageWorkspaces({ projectRoot: root, cwd: path.dirname(root) }),
    ).rejects.toThrow(/outside project root/);
    await expect(
      detectLanguageWorkspaces({
        projectRoot: root,
        target: path.join(path.dirname(root), 'outside.ts'),
      }),
    ).rejects.toThrow(/outside project root/);
  });

  it('detects additional language profiles from their markers', async () => {
    await Promise.all([
      file('py/pyproject.toml', '[project]\nname="x"'),
      file('py/src/main.py', 'print("hello")'),
      file('jvm/pom.xml', '<project></project>'),
      file('jvm/src/Main.java', 'class Main {}'),
      file('rb/Gemfile', "source 'https://rubygems.org'"),
      file('rb/app.rb', 'puts "hi"'),
      file('c/CMakeLists.txt', 'cmake_minimum_required(VERSION 3.0)'),
      file('c/main.c', 'int main(void){return 0;}'),
      file('cpp/src/main.cpp', 'int main(){return 0;}'),
      file('swift/Package.swift', '// swift-tools'),
      file('swift/Sources/main.swift', 'print("hi")'),
      file('dart/pubspec.yaml', 'name: x'),
      file('dart/lib/main.dart', 'void main(){}'),
      file('deno/deno.json', '{}'),
      file('deno/main.ts', 'console.log("hi");'),
      file('ex/mix.exs', 'defmodule X.MixProject do end'),
      file('ex/lib/x.ex', 'defmodule X do end'),
      file('sh/script.sh', '#!/bin/bash\necho hi'),
    ]);
    const result = await detectLanguageWorkspaces({ projectRoot: root });
    const detected = new Set(result.workspaces.map((w) => w.language));
    for (const lang of [
      'python',
      'java',
      'ruby',
      'c',
      'cpp',
      'swift',
      'dart',
      'deno',
      'elixir',
      'shell',
    ]) {
      expect(detected.has(lang as any), `expected ${lang} to be detected`).toBe(true);
    }
  });

  it('skips caller-provided ignoredDirectories by basename, but never the root', async () => {
    await file('package.json', '{}');
    await file('tests/fixtures/fake-app/package.json', '{"dependencies":{"zod":"^3.23.0"}}');
    await file('tests/fixtures/fake-app/src/index.ts', 'export {};');

    const result = await detectLanguageWorkspaces({
      projectRoot: root,
      ignoredDirectories: ['fixtures'],
    });
    const roots = result.workspaces.map((item) => item.root);
    expect(roots).toContain(root);
    expect(roots).not.toContain(path.join(root, 'tests', 'fixtures', 'fake-app'));

    // Scanning the ignored directory's subtree directly still works — only
    // child entries are name-checked, never the project root itself.
    const direct = await detectLanguageWorkspaces({
      projectRoot: path.join(root, 'tests', 'fixtures'),
      ignoredDirectories: ['fixtures'],
    });
    expect(direct.workspaces.length).toBeGreaterThanOrEqual(1);
  });

  it('does not guess a package manager when lockfiles conflict', async () => {
    await file('package.json', '{}');
    await file('pnpm-lock.yaml');
    await file('yarn.lock');
    const result = await detectLanguageWorkspaces({ projectRoot: root, language: 'javascript' });
    expect(result.workspaces[0]?.packageManager).toBeUndefined();
  });
});
