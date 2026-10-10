#!/usr/bin/env bun
/**
 * Prove that the publishable providers tarball has a finite, valid npm 10
 * dependency graph. This specifically guards the 1.0.8 regression where
 * ai-gateway-provider pulled an AI SDK 6 OpenRouter peer into an AI SDK 7 tree
 * and npm Arborist cycled through repeated REPLACE operations.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildWin32CmdShimInvocation } from '@wrongstack/core/utils';

const repoRoot = resolve(import.meta.dirname, '..');
const npmCommand = process.execPath;
const npmArgs = ['x', '--bun', 'npm@10.9.8'];
const tempRoot = mkdtempSync(join(tmpdir(), 'wrongstack-npm-install-'));

try {
  const coreStub = createWorkspaceStub('packages/core');
  const providersTarball = pack('packages/providers');
  writeFileSync(
    join(tempRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'wrongstack-npm-install-smoke',
        private: true,
        dependencies: {
          '@wrongstack/core': fileSpec(coreStub),
          '@wrongstack/providers': fileSpec(providersTarball),
        },
      },
      null,
      2,
    )}\n`,
  );

  run(npmCommand, [
    ...npmArgs,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ]);

  const lock = JSON.parse(readFileSync(join(tempRoot, 'package-lock.json'), 'utf8'));
  const installed = Object.entries(lock.packages ?? {});
  const openRouter = installed.filter(([path]) =>
    path.endsWith('node_modules/@openrouter/ai-sdk-provider'),
  );
  const incompatibleAi = installed.filter(
    ([path, manifest]) =>
      path.endsWith('node_modules/ai') &&
      typeof manifest === 'object' &&
      manifest !== null &&
      !String(manifest.version).startsWith('7.'),
  );
  if (openRouter.length > 0 || incompatibleAi.length > 0) {
    throw new Error(
      `invalid AI SDK graph: OpenRouter=${openRouter.length}, non-v7 ai=${incompatibleAi.length}`,
    );
  }

  console.log(
    'npm-package-install: PASS — npm@10.9.8 installed packed providers with AI SDK 7 only',
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function createWorkspaceStub(relativeDir) {
  const sourceManifest = JSON.parse(
    readFileSync(join(repoRoot, relativeDir, 'package.json'), 'utf8'),
  );
  const stubDir = join(tempRoot, 'core-stub');
  mkdirSync(stubDir);
  writeFileSync(
    join(stubDir, 'package.json'),
    `${JSON.stringify({
      name: sourceManifest.name,
      version: sourceManifest.version,
      private: true,
    })}\n`,
  );
  return stubDir;
}

function pack(relativeDir) {
  const packageDir = join(repoRoot, relativeDir);
  run(process.execPath, ['pm', 'pack', '--destination', tempRoot], packageDir);
  const packageName = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name;
  const expectedPrefix = packageName.replace(/^@/, '').replace('/', '-').replaceAll('@', '-');
  const matches = readdirSync(tempRoot).filter(
    (name) => name.startsWith(`${expectedPrefix}-`) && name.endsWith('.tgz'),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one tarball for ${packageName}, found ${matches.join(', ') || 'none'}`,
    );
  }
  return join(tempRoot, matches[0]);
}

function fileSpec(path) {
  return `file:${path.replaceAll('\\', '/')}`;
}

function run(command, args, cwd = tempRoot) {
  const invocation =
    process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
      ? buildWin32CmdShimInvocation(command, args)
      : { command, args, windowsVerbatimArguments: false };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 120_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
}
