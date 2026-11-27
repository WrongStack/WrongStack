import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMocks = vi.hoisted(() => ({ spawnStream: vi.fn() }));
vi.mock('../src/_spawn-stream.js', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return { ...actual, spawnStream: spawnMocks.spawnStream };
});

import { languageTool } from '../src/languages/execute-tool.js';

let root: string;
const opts = { signal: new AbortController().signal };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-language-tool-'));
  spawnMocks.spawnStream.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function context() {
  return {
    cwd: root,
    workingDir: root,
    projectRoot: root,
    recordSideEffect: vi.fn(),
  } as any;
}

function fakeSpawn(stdout: string, exitCode = 0) {
  return async function* () {
    yield { type: 'partial_output', text: stdout } as const;
    return { stdout, stderr: '', exitCode, truncated: false };
  };
}

describe('languageTool', () => {
  it('is confirm-gated and declares the conservative code-execution capabilities', () => {
    expect(languageTool).toMatchObject({
      name: 'language',
      permission: 'confirm',
      mutating: true,
      riskTier: 'standard',
      capabilities: ['shell.restricted', 'fs.write'],
    });
  });

  it('validates action-specific inputs', () => {
    expect(languageTool.validate?.({ action: 'lint', check: 'all' })).toContain(
      'check is only valid when action=check',
    );
    expect(languageTool.validate?.({ action: 'test', filter: 'x\ny' })?.join(' ')).toContain(
      'contain no shell/control characters',
    );
    expect(languageTool.validate?.({ action: 'test', coverage: true })).toContain(
      'coverage is not supported by the language tool; for JS/TS use the test tool with coverage: true',
    );
  });

  it('runs a predefined Go test plan and records a side effect', async () => {
    await fs.writeFile(path.join(root, 'go.mod'), 'module x');
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok example.com/x 0.01s'));
    const ctx = context();
    const result = await languageTool.execute({ action: 'test', language: 'go' }, ctx, opts);
    expect(result).toMatchObject({ status: 'passed', summary: { runs: 1, passed: 1 } });
    expect(spawnMocks.spawnStream).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'go', args: ['test', './...'] }),
    );
    expect(ctx.recordSideEffect).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'language', risk: 'shell' }),
    );
  });

  it('runs syntax then semantic for check=all and stops after a fast failure', async () => {
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
    const target = path.join(root, 'bad.ts');
    await fs.writeFile(target, 'const x = ;');
    const result = await languageTool.execute(
      { action: 'check', check: 'all', language: 'typescript', target },
      context(),
      opts,
    );
    expect(result.status).toBe('failed');
    expect(result.runs).toHaveLength(1);
    expect(spawnMocks.spawnStream).not.toHaveBeenCalled();
  });

  it('passes validated filters as literal argv elements', async () => {
    await fs.writeFile(path.join(root, 'go.mod'), 'module x');
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await languageTool.execute(
      { action: 'test', language: 'go', filter: 'TestWidget' },
      context(),
      opts,
    );
    expect(spawnMocks.spawnStream).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['test', '-run', 'TestWidget', './...'] }),
    );
  });

  it('requires a target for Go formatting instead of executing an invalid directory plan', async () => {
    await fs.writeFile(path.join(root, 'go.mod'), 'module x');
    const result = await languageTool.execute(
      { action: 'format', language: 'go' },
      context(),
      opts,
    );
    expect(result.status).toBe('unavailable');
    expect(result.output).toMatch(/explicit target/);
    expect(spawnMocks.spawnStream).not.toHaveBeenCalled();
  });

  it('executes an explicit format-write plan', async () => {
    await fs.writeFile(path.join(root, 'Cargo.toml'), '[package]');
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    const result = await languageTool.execute(
      { action: 'format', language: 'rust', formatCheck: false },
      context(),
      opts,
    );
    expect(result.status).toBe('passed');
    expect(spawnMocks.spawnStream).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'cargo', args: ['fmt'] }),
    );
  });

  it('returns structured unavailable output when no profile operation exists', async () => {
    await fs.writeFile(path.join(root, 'composer.json'), '{}');
    const result = await languageTool.execute({ action: 'lint', language: 'php' }, context(), opts);
    expect(result).toMatchObject({ status: 'unavailable', summary: { runs: 0 } });
  });

  it('serializes normalized diagnostics compactly', () => {
    const output = languageTool.serialize?.(
      {
        status: 'failed',
        language: 'go',
        workspace: root,
        runs: [],
        diagnostics: [
          {
            severity: 'error',
            message: 'undefined: x',
            file: path.join(root, 'main.go'),
            range: { start: { line: 3, column: 2 } },
            source: 'go',
          },
        ],
        summary: { runs: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
        output: 'failed',
      },
      { action: 'test' },
    );
    expect(output).toContain('ERROR');
    expect(output).toContain('main.go:3:2');
  });
});
