/**
 * Tests: legacy tools delegate through the language planner for non-JS
 * ecosystems (Go, Rust, PHP, C#) while preserving their output shapes.
 *
 * Each test creates a temporary workspace with an ecosystem marker file,
 * mocks spawnStream, calls the legacy tool, and verifies delegation.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMocks = vi.hoisted(() => ({ spawnStream: vi.fn() }));
vi.mock('../src/_spawn-stream.js', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return { ...actual, spawnStream: spawnMocks.spawnStream };
});

import { typecheckTool } from '../src/typecheck.js';
import { lintTool } from '../src/lint.js';
import { formatTool } from '../src/format.js';
import { testTool } from '../src/test.js';
import { installTool } from '../src/install.js';
import { auditTool } from '../src/audit.js';
import { outdatedTool } from '../src/outdated.js';

let root: string;
const opts = { signal: new AbortController().signal };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-legacy-bridge-'));
  spawnMocks.spawnStream.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function ctx(dir = root) {
  return {
    cwd: dir,
    workingDir: dir,
    projectRoot: dir,
    tools: [],
    recordSideEffect: vi.fn(),
  } as any;
}

function fakeSpawn(stdout: string, exitCode = 0, stderr = '', error?: string) {
  return async function* () {
    yield { type: 'partial_output', text: stdout } as const;
    return { stdout, stderr, exitCode, truncated: false, ...(error ? { error } : {}) };
  };
}

/** Quick helpers: write a marker file for the ecosystem. */
async function go(): Promise<void> {
  await fs.writeFile(path.join(root, 'go.mod'), 'module x');
}
async function rust(): Promise<void> {
  await fs.writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "x"');
}
async function php(): Promise<void> {
  await fs.writeFile(path.join(root, 'composer.json'), '{}');
}
async function csharp(): Promise<void> {
  await fs.writeFile(path.join(root, 'App.csproj'), '<Project/>');
}

const _NPM_AUDIT = JSON.stringify({
  vulnerabilities: {
    'lodash@4.17.20': {
      name: 'lodash',
      severity: 'high',
      title: 'T',
      url: 'https://t.test',
      range: '<4.17.21',
      patched_versions: '>=4.17.21',
    },
  },
});
const CARGO_AUDIT = JSON.stringify({
  vulnerabilities: {
    found: [
      {
        id: 'RUSTSEC-2024-0001',
        package: 'crate-x',
        title: 'Test vuln',
        severity: 'high',
        patched_versions: ['>=1.2.0'],
        url: { long: 'https://rustsec.test' },
        advisory: { id: 'RUSTSEC-2024-0001' },
      },
    ],
  },
});

// ─── TYPE CHECK ────────────────────────────────────────────────────────────
describe('typecheckTool — non-JS delegation', () => {
  it('Go', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await go();
    const r = await typecheckTool.execute({}, ctx(), opts);
    expect(r.project).toMatch(/go/);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('Rust', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await rust();
    const r = await typecheckTool.execute({}, ctx(), opts);
    expect(r.project).toMatch(/rust/);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('C#', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await csharp();
    const r = await typecheckTool.execute({}, ctx(), opts);
    expect(r.project).toMatch(/csharp/);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('PHP falls through to JS path', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await php();
    const r = await typecheckTool.execute({}, ctx(), opts);
    expect(r.project).toBe('default');
  });
  it('JS path for empty workspace', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    const r = await typecheckTool.execute({}, ctx(), opts);
    expect(r.project).toBe('default');
  });
});

// ─── LINT ──────────────────────────────────────────────────────────────────
describe('lintTool — non-JS delegation', () => {
  it('Go', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await go();
    const r = await lintTool.execute({}, ctx(), opts);
    expect(r.linter).toBe('go');
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('Rust', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await rust();
    const r = await lintTool.execute({}, ctx(), opts);
    expect(r.linter).toBe('rust');
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('C#', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await csharp();
    const r = await lintTool.execute({}, ctx(), opts);
    expect(r.linter).toBe('csharp');
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('PHP falls through to biome', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await php();
    const r = await lintTool.execute({}, ctx(), opts);
    expect(r.linter).toBe('biome');
  });
  it('bypasses bridge when explicit linter', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await go();
    await lintTool.execute({ linter: 'biome' }, ctx(), opts);
    expect(spawnMocks.spawnStream).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'biome' }));
  });
  it('bypasses bridge when explicit files', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await go();
    await lintTool.execute({ files: '*.ts' }, ctx(), opts);
    expect(spawnMocks.spawnStream).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'biome' }));
  });
});

// ─── FORMAT ────────────────────────────────────────────────────────────────
describe('formatTool — non-JS delegation', () => {
  it('Rust format-check', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await rust();
    const r = await formatTool.execute({}, ctx(), opts);
    expect(r.fixer).toBe('rust');
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('Rust format-write', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await rust();
    const r = await formatTool.execute({ check: false }, ctx(), opts);
    expect(r.fixer).toBe('rust');
    expect(spawnMocks.spawnStream.mock.calls[0]?.[0]?.args).not.toContain('--check');
  });
  it('C# format-check', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await csharp();
    const r = await formatTool.execute({}, ctx(), opts);
    expect(r.fixer).toBe('csharp');
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('Go falls through to biome', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await go();
    const r = await formatTool.execute({}, ctx(), opts);
    expect(r.fixer).toBe('biome');
  });
  it('PHP falls through to biome', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await php();
    const r = await formatTool.execute({}, ctx(), opts);
    expect(r.fixer).toBe('biome');
  });
});

// ─── TEST ──────────────────────────────────────────────────────────────────
describe('testTool — non-JS delegation', () => {
  it('Go', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await go();
    const r = await testTool.execute({}, ctx(), opts);
    expect(r.runner).toBe('go');
    expect(r.exit_code).toBe(0);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('Rust', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await rust();
    const r = await testTool.execute({}, ctx(), opts);
    expect(r.runner).toBe('rust');
    expect(r.exit_code).toBe(0);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('PHP', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await php();
    const r = await testTool.execute({}, ctx(), opts);
    expect(r.runner).toBe('php');
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('C#', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await csharp();
    const r = await testTool.execute({}, ctx(), opts);
    expect(r.runner).toBe('csharp');
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('bypasses bridge when explicit runner', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await fs.writeFile(path.join(root, 'vitest.config.ts'), 'export default {}');
    await go();
    await testTool.execute({ runner: 'vitest' }, ctx(), opts);
    expect(spawnMocks.spawnStream).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'vitest' }));
  });
});

// ─── INSTALL ───────────────────────────────────────────────────────────────
describe('installTool — non-JS delegation', () => {
  it('Go', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await go();
    const r = await installTool.execute({}, ctx(), opts);
    expect(r.exit_code).toBe(0);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('Rust', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await rust();
    const r = await installTool.execute({}, ctx(), opts);
    expect(r.exit_code).toBe(0);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('PHP', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await php();
    const r = await installTool.execute({}, ctx(), opts);
    expect(r.exit_code).toBe(0);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('C#', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('ok'));
    await csharp();
    const r = await installTool.execute({}, ctx(), opts);
    expect(r.exit_code).toBe(0);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
});

// ─── AUDIT ─────────────────────────────────────────────────────────────────
describe('auditTool — non-JS delegation', () => {
  it('Rust', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(CARGO_AUDIT));
    await rust();
    const r = await auditTool.execute({}, ctx(), opts);
    expect(r.total).toBe(1);
    expect(spawnMocks.spawnStream).toHaveBeenCalledOnce();
  });
  it('Go falls through to npm audit', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('{}'));
    await go();
    const r = await auditTool.execute({}, ctx(), opts);
    expect(r.total).toBe(0);
  });
  it('PHP falls through to npm audit', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn('{}'));
    await php();
    const r = await auditTool.execute({}, ctx(), opts);
    expect(r.total).toBe(0);
  });
});

// ─── OUTDATED ──────────────────────────────────────────────────────────────
describe('outdatedTool — non-JS delegation', () => {
  it('falls through to npm for Go', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(JSON.stringify({})));
    await go();
    const r = await outdatedTool.execute({}, ctx(), opts);
    expect(r.total).toBe(0);
  });
  it('falls through for Rust', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(JSON.stringify({})));
    await rust();
    const r = await outdatedTool.execute({}, ctx(), opts);
    expect(r.total).toBe(0);
  });
  it('falls through for PHP', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(JSON.stringify({})));
    await php();
    const r = await outdatedTool.execute({}, ctx(), opts);
    expect(r.total).toBe(0);
  });
});

// ─── BOUNDED BYPASS ────────────────────────────────────────────────────────
describe('legacy bridge — bounded conditions', () => {
  it('empty dir falls through to tsc', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await typecheckTool.execute({}, ctx(), opts);
    expect(spawnMocks.spawnStream).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'npx' }));
  });
  it('JS workspace skips bridge', async () => {
    spawnMocks.spawnStream.mockImplementation(fakeSpawn(''));
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await typecheckTool.execute({}, ctx(), opts);
    for (const call of spawnMocks.spawnStream.mock.calls)
      expect(call[0]?.cmd).not.toMatch(/^(go|cargo|dotnet|composer|gofmt|php)$/);
  });
});
