import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { behaviorConfigProjection, createSandbox } from '../src/isolation.js';
import { runFailureReason } from '../src/orchestrate.js';
import { runWstack } from '../src/runner.js';
import type { RawRun } from '../src/types.js';

function rawRun(over: Partial<RawRun>): RawRun {
  return {
    status: 'completed',
    finalText: null,
    iterations: 4,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    elapsedMs: 0,
    exitCode: 0,
    ...over,
  };
}

describe('runFailureReason', () => {
  it('names every non-completed outcome so a report row is diagnosable', () => {
    expect(runFailureReason(rawRun({ status: 'completed' }))).toBeUndefined();
    expect(runFailureReason(rawRun({ status: 'timeout' }))).toMatch(/timed out/);
    expect(runFailureReason(rawRun({ status: 'aborted' }))).toBe('agent aborted');
    expect(runFailureReason(rawRun({ status: 'max_iterations', iterations: 40 }))).toBe(
      'agent hit the iteration cap after 40 iterations',
    );
    expect(runFailureReason(rawRun({ status: 'crashed', crashDetail: 'exit 1: boom' }))).toBe(
      'agent crashed: exit 1: boom',
    );
    expect(runFailureReason(rawRun({ status: 'crashed' }))).toMatch(/no --output-json payload/);
    expect(runFailureReason(rawRun({ status: 'failed' }))).toBe('agent reported failure');
    expect(runFailureReason(rawRun({ status: 'failed', errorMessage: 'no key' }))).toBe(
      'agent reported failure: no key',
    );
  });
});

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-diag-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Write a fake CLI that prints one `--output-json` line and exits. */
async function fakeCli(name: string, payload: unknown): Promise<string> {
  const file = path.join(dir, `${name}.js`);
  await fs.writeFile(
    file,
    `process.stdout.write(${JSON.stringify(JSON.stringify(payload))} + "\\n");\n`,
    'utf8',
  );
  return file;
}

describe('runWstack error reporting', () => {
  it('keeps the agent-reported failure reason instead of discarding it', async () => {
    const entry = await fakeCli('failing', {
      status: 'failed',
      finalText: null,
      error: { code: 'PROVIDER_AUTH', message: 'no API key for provider "p"' },
      usage: { input: 10, output: 0, iterations: 1, cost: 0 },
    });

    const run = await runWstack({
      nodeBin: process.execPath,
      wstackEntry: entry,
      homeDir: dir,
      workdir: dir,
      cell: { label: 'c', provider: 'p', model: 'm' },
      prompt: 'go',
      timeoutMs: 30_000,
    });

    expect(run.status).toBe('failed');
    expect(run.errorMessage).toBe('PROVIDER_AUTH: no API key for provider "p"');
  });

  it('leaves errorMessage absent on a clean completion and on a null error', async () => {
    const entry = await fakeCli('clean', {
      status: 'completed',
      finalText: 'done',
      error: null,
      usage: { input: 1, output: 1, iterations: 1, cost: 0 },
    });
    const run = await runWstack({
      nodeBin: process.execPath,
      wstackEntry: entry,
      homeDir: dir,
      workdir: dir,
      cell: { label: 'c', provider: 'p', model: 'm' },
      prompt: 'go',
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('completed');
    expect(run.errorMessage).toBeUndefined();
  });

  it('ignores an error object with no usable message', async () => {
    const entry = await fakeCli('blank-error', {
      status: 'failed',
      error: { code: '', message: '   ' },
      usage: {},
    });
    const run = await runWstack({
      nodeBin: process.execPath,
      wstackEntry: entry,
      homeDir: dir,
      workdir: dir,
      cell: { label: 'c', provider: 'p', model: 'm' },
      prompt: 'go',
      timeoutMs: 30_000,
    });
    expect(run.errorMessage).toBeUndefined();
  });
});

describe('sandbox config fingerprinting', () => {
  it('projects only behavior-affecting keys — never credentials or the model under test', () => {
    const projection = behaviorConfigProjection({
      yolo: true,
      tools: { maxIterations: 40 },
      skills: { mode: 'progressive' },
      systemPrompt: { variant: 'lite' },
      // Excluded: secrets and the variable under test.
      providers: { anthropic: { apiKey: 'enc:secret' } },
      provider: 'anthropic',
      model: 'claude-opus-5',
      favoriteModels: ['a'],
    });

    expect(Object.keys(projection).sort()).toEqual(['skills', 'systemPrompt', 'tools', 'yolo']);
  });

  it('tolerates a non-object config', () => {
    expect(behaviorConfigProjection(undefined)).toEqual({});
    expect(behaviorConfigProjection('nope')).toEqual({});
  });

  it('hashes the config the sandboxed CLI will actually read', async () => {
    const a = await createSandbox({
      baseDir: path.join(dir, 'sb-a'),
      maxIterations: 10,
      yolo: true,
    });
    const b = await createSandbox({
      baseDir: path.join(dir, 'sb-b'),
      maxIterations: 10,
      yolo: true,
    });
    const different = await createSandbox({
      baseDir: path.join(dir, 'sb-c'),
      maxIterations: 99,
      yolo: true,
    });

    expect(a.configHash).toBe(b.configHash);
    // maxIterations lives under `tools`, which is part of the projection.
    expect(different.configHash).not.toBe(a.configHash);
  });

  it('picks the host active profile over the root config', async () => {
    const hostHome = path.join(dir, 'host-home');
    await fs.mkdir(path.join(hostHome, 'profiles', 'work'), { recursive: true });
    await fs.writeFile(
      path.join(hostHome, 'config.json'),
      JSON.stringify({ activeProfile: 'work', skills: { mode: 'eager' } }),
      'utf8',
    );
    await fs.writeFile(
      path.join(hostHome, 'profiles', 'work', 'config.json'),
      JSON.stringify({ skills: { mode: 'progressive' } }),
      'utf8',
    );

    const withProfile = await createSandbox({
      baseDir: path.join(dir, 'sb-profile'),
      maxIterations: 10,
      yolo: true,
      hostHomeDir: hostHome,
    });
    const rootOnly = await createSandbox({
      baseDir: path.join(dir, 'sb-root'),
      maxIterations: 10,
      yolo: true,
    });

    // The active profile's `skills.mode` is what the child runs on, so it —
    // not the root config — must be what the fingerprint reflects.
    expect(withProfile.configHash).not.toBe(rootOnly.configHash);
    const copied = JSON.parse(
      await fs.readFile(path.join(withProfile.homeDir, 'profiles', 'work', 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(copied['skills']).toEqual({ mode: 'progressive' });
  });
});
