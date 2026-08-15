import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planLanguageOperation } from '../src/languages/index.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-language-plan-'));
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

async function planned(
  language: 'typescript' | 'go' | 'rust' | 'php' | 'csharp',
  operation: Parameters<typeof planLanguageOperation>[0]['operation'],
  target?: string,
) {
  const result = await planLanguageOperation({
    projectRoot: root,
    language,
    operation,
    ...(target ? { target } : {}),
  });
  expect(result.status).toBe('planned');
  if (result.status !== 'planned') throw new Error(JSON.stringify(result));
  return result.plan;
}

describe('planLanguageOperation', () => {
  it('returns an internal TypeScript syntax plan and exact compiler plan', async () => {
    await file('package.json', JSON.stringify({ packageManager: 'pnpm@10' }));
    await file('pnpm-lock.yaml');
    await file('tsconfig.json', '{}');
    const target = await file('src/index.ts', 'const x = 1');

    const syntax = await planned('typescript', 'syntax', target);
    expect(syntax).toMatchObject({
      kind: 'internal',
      command: null,
      args: [],
      parser: 'typescript-parser',
      mutating: false,
      network: false,
      executesProjectCode: false,
    });
    const semantic = await planned('typescript', 'semantic', target);
    expect(semantic).toMatchObject({
      command: 'pnpm',
      args: ['exec', 'tsc', '--noEmit', '--pretty', 'false'],
      parser: 'typescript',
      network: false,
    });
  });

  it('returns exact Go, Rust, PHP, and C# plans', async () => {
    const goTarget = await file('go/main.go', 'package main');
    await file('go/go.mod', 'module x');
    await file('rust/Cargo.toml', '[package]');
    await file('php/composer.json', '{}');
    const phpTarget = await file('php/index.php', '<?php');
    await file('dotnet/App.csproj', '<Project/>');

    const go = await planLanguageOperation({
      projectRoot: root,
      cwd: path.join(root, 'go'),
      language: 'go',
      operation: 'syntax',
      target: goTarget,
    });
    expect(go.status === 'planned' && go.plan).toMatchObject({
      command: 'gofmt',
      args: ['-e', '-d', goTarget],
    });

    const rust = await planLanguageOperation({
      projectRoot: root,
      cwd: path.join(root, 'rust'),
      language: 'rust',
      operation: 'semantic',
    });
    expect(rust.status === 'planned' && rust.plan).toMatchObject({
      command: 'cargo',
      args: ['check', '--message-format=json'],
      mutating: true,
      executesProjectCode: true,
    });

    const php = await planLanguageOperation({
      projectRoot: root,
      cwd: path.join(root, 'php'),
      language: 'php',
      operation: 'syntax',
      target: phpTarget,
    });
    expect(php.status === 'planned' && php.plan).toMatchObject({
      command: 'php',
      args: ['-l', phpTarget],
      mutating: false,
    });

    const dotnet = await planLanguageOperation({
      projectRoot: root,
      cwd: path.join(root, 'dotnet'),
      language: 'csharp',
      operation: 'semantic',
    });
    expect(dotnet.status === 'planned' && dotnet.plan).toMatchObject({
      command: 'dotnet',
      args: ['build', '--no-restore'],
      mutating: true,
      executesProjectCode: true,
    });
  });

  it('returns unavailable for an unsupported configured operation', async () => {
    await file('composer.json', '{}');
    const result = await planLanguageOperation({
      projectRoot: root,
      language: 'php',
      operation: 'semantic',
    });
    expect(result).toMatchObject({ status: 'unavailable', unavailable: { operation: 'semantic' } });
  });

  it('reports equal-confidence workspaces as ambiguous without a target', async () => {
    await file('a/go.mod', 'module a');
    await file('b/go.mod', 'module b');
    const result = await planLanguageOperation({
      projectRoot: root,
      language: 'go',
      operation: 'test',
    });
    expect(result).toMatchObject({ status: 'ambiguous' });
    if (result.status === 'ambiguous') expect(result.candidates).toHaveLength(2);
  });

  it('selects the target-containing workspace', async () => {
    await file('a/go.mod', 'module a');
    const target = await file('b/main.go', 'package b');
    await file('b/go.mod', 'module b');
    const result = await planLanguageOperation({
      projectRoot: root,
      language: 'go',
      operation: 'test',
      target,
    });
    expect(result.status === 'planned' && result.workspace.root).toBe(path.join(root, 'b'));
  });

  it.each(['--evil', '../local', 'file:../local', 'https://evil.test/x', 'x;calc'])(
    'rejects unsafe package identifier %s',
    async (name) => {
      await file('package.json', '{}');
      await expect(
        planLanguageOperation({
          projectRoot: root,
          language: 'javascript',
          operation: 'package-add',
          operationOptions: { packages: [name] },
        }),
      ).rejects.toThrow(/Invalid package|not supported/);
    },
  );

  it('returns unavailable instead of guessing across conflicting Node lockfiles', async () => {
    await file('package.json', '{}');
    await file('pnpm-lock.yaml');
    await file('yarn.lock');
    const result = await planLanguageOperation({
      projectRoot: root,
      language: 'javascript',
      operation: 'test',
    });
    expect(result).toMatchObject({
      status: 'unavailable',
      unavailable: { reason: expect.stringMatching(/Conflicting Node lockfiles/) },
    });
  });

  it('accepts ecosystem package identifiers as literal argv elements', async () => {
    await file('composer.json', '{}');
    const result = await planLanguageOperation({
      projectRoot: root,
      language: 'php',
      operation: 'package-add',
      operationOptions: { packages: ['vendor/package:^2.0'] },
    });
    expect(result.status === 'planned' && result.plan.args.at(-1)).toBe('vendor/package:^2.0');
  });
});
