import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hqAuthAuditPath,
  hqAuthContentHash,
  hqAuthFilePath,
  readHqAuthFile,
} from '@wrongstack/core/hq';
import type { ContentBlock, TextBlock } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hqCmd } from '../src/subcommands/handlers/hq.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

/**
 * Tests for the `wstack hq audit verify` subcommand.
 *
 * The command re-derives the contentHash from the on-disk `auth.json`
 * so an operator can compare it against a `contentHash` field in an
 * audit entry. These tests pin the output format and the two exit-code
 * paths (0 when the hash computes, 1 when auth.json is missing) against
 * a temp data dir.
 */

const startHqServerMock = vi.hoisted(() => vi.fn());

vi.mock('../src/hq-server.js', () => ({
  startHqServer: startHqServerMock,
}));

let tmpHome: string;
let dataDir: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-audit-'));
  dataDir = path.join(tmpHome, 'hq');
  startHqServerMock.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

interface CapturedRenderer {
  out: string[];
  err: string[];
  warn: string[];
}

type RendererWithCapture = SubcommandDeps['renderer'] & {
  write: ((input: string | TextBlock) => void) & ReturnType<typeof vi.fn>;
  writeError: ((text: string) => void) & ReturnType<typeof vi.fn>;
  writeWarning: ((text: string) => void) & ReturnType<typeof vi.fn>;
  writeInfo: ((text: string) => void) & ReturnType<typeof vi.fn>;
  writeLine: ((text?: string) => void) & ReturnType<typeof vi.fn>;
  writeBlock: ((block: ContentBlock) => void) & ReturnType<typeof vi.fn>;
  writeToolCall: ((name: string, input: unknown) => void) & ReturnType<typeof vi.fn>;
  writeToolResult: ((name: string, content: unknown, isError: boolean) => void) &
    ReturnType<typeof vi.fn>;
  writeDiff: ((unifiedDiff: string) => void) & ReturnType<typeof vi.fn>;
  clear: (() => void) & ReturnType<typeof vi.fn>;
  captured: CapturedRenderer;
};
type TestDeps = SubcommandDeps & { renderer: RendererWithCapture };

function renderText(input: string | TextBlock): string {
  return typeof input === 'string' ? input : input.text;
}

function makeDeps(overrides: Partial<SubcommandDeps> = {}): TestDeps {
  return {
    config: {} as SubcommandDeps['config'],
    renderer: makeStubRenderer(),
    reader: { readLine: vi.fn(), readKey: vi.fn(), readSecret: vi.fn(), close: vi.fn() } as never,
    modelsRegistry: { providers: {}, customModels: {} } as never,
    paths: {} as SubcommandDeps['paths'],
    vault: { encrypt: vi.fn((s: string) => s), decrypt: vi.fn((s: string) => s) } as never,
    cwd: tmpHome,
    projectRoot: tmpHome,
    userHome: tmpHome,
    flags: { 'data-dir': dataDir },
    ...overrides,
  } as TestDeps;
}

function makeStubRenderer(): RendererWithCapture {
  const captured: CapturedRenderer = { out: [], err: [], warn: [] };
  return {
    write: vi.fn((input: string | TextBlock) => {
      captured.out.push(renderText(input));
    }),
    writeLine: vi.fn((text = '') => {
      captured.out.push(text ? `${text}\n` : '\n');
    }),
    writeBlock: vi.fn((block: ContentBlock) => {
      if (block.type === 'text') captured.out.push(block.text);
    }),
    writeToolCall: vi.fn((name: string) => {
      captured.out.push(name);
    }),
    writeToolResult: vi.fn((name: string, content: unknown) => {
      captured.out.push(typeof content === 'string' ? `${name}:${content}` : name);
    }),
    writeDiff: vi.fn((diff: string) => {
      captured.out.push(diff);
    }),
    writeError: vi.fn((s: string) => {
      captured.err.push(s);
    }),
    writeWarning: vi.fn((s: string) => {
      captured.warn.push(s);
    }),
    writeInfo: vi.fn((s: string) => {
      captured.out.push(s);
    }),
    clear: vi.fn(),
    captured,
  } as RendererWithCapture;
}

describe('wstack hq audit verify', () => {
  it('exits 1 and reports unavailable when auth.json is missing', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['audit', 'verify'], deps);
    expect(code).toBe(1);
    const out = deps.renderer.captured.out.join('');
    expect(out).toContain('contentHash: (unavailable');
    // Still prints the resolved paths so the operator can find the
    // audit log for historical comparison.
    expect(out).toContain(`auth file:   ${hqAuthFilePath(dataDir)}`);
    expect(out).toContain(`audit log:   ${hqAuthAuditPath(dataDir)}`);
  });

  it('exits 0 and prints a 64-char hex hash when auth.json exists', async () => {
    const deps = makeDeps();
    // Seed an auth file by minting a token through the real handler —
    // this produces a valid on-disk auth.json the verify path can read.
    await hqCmd(['token', 'create', 'audit-fixture'], deps);
    // Fresh renderer so only the verify output is captured.
    const verifyDeps = makeDeps();
    const code = await hqCmd(['audit', 'verify'], verifyDeps);
    expect(code).toBe(0);
    const out = verifyDeps.renderer.captured.out.join('');
    const match = out.match(/contentHash:\s+([0-9a-f]{64})/);
    expect(match, `expected a 64-char hex hash in output:\n${out}`).not.toBeNull();
    expect(match?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the printed hash matches hqAuthContentHash(readHqAuthFile(dataDir))', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'tie-back'], deps);
    const verifyDeps = makeDeps();
    const code = await hqCmd(['audit', 'verify'], verifyDeps);
    expect(code).toBe(0);
    const out = verifyDeps.renderer.captured.out.join('');
    const printed = out.match(/contentHash:\s+([0-9a-f]{64})/)?.[1];
    // Re-derive independently via the core helpers — this is the exact
    // one-liner an operator would run by hand. The CLI output must agree.
    const expected = hqAuthContentHash(await readHqAuthFile(dataDir));
    expect(printed).toBe(expected);
  });

  it('output includes both resolved paths and the comparison guidance', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'format-check'], deps);
    const verifyDeps = makeDeps();
    await hqCmd(['audit', 'verify'], verifyDeps);
    const out = verifyDeps.renderer.captured.out.join('');
    // The two path lines anchor the operator to the exact files involved.
    expect(out).toContain(`auth file:   ${hqAuthFilePath(dataDir)}`);
    expect(out).toContain(`audit log:   ${hqAuthAuditPath(dataDir)}`);
    // The closing guidance explains what a match means — without it the
    // operator has to recall the redaction model from memory.
    expect(out).toContain("contentHash' field");
    expect(out).toContain('non-secret shape is hashed');
  });

  it('bare `wstack hq audit` defaults to verify (ergonomic alias)', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'bare-alias'], deps);
    const verifyDeps = makeDeps();
    const code = await hqCmd(['audit'], verifyDeps);
    expect(code).toBe(0);
    expect(verifyDeps.renderer.captured.out.join('')).toMatch(/contentHash:\s+[0-9a-f]{64}/);
  });

  it('unknown audit action exits 1 with usage', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['audit', 'bogus'], deps);
    expect(code).toBe(1);
    const err = deps.renderer.captured.err.join('');
    expect(err).toContain('Unknown hq audit subcommand: bogus');
    // The usage hint follows the hqTokenCmd pattern: error to stderr,
    // usage to stdout.
    const out = deps.renderer.captured.out.join('');
    expect(out).toContain('Usage: wstack hq audit <verify>');
  });

  it('hash is stable across repeated invocations (deterministic projection)', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'stable'], deps);
    const run1 = makeDeps();
    await hqCmd(['audit', 'verify'], run1);
    const hash1 = run1.renderer.captured.out.join('').match(/contentHash:\s+([0-9a-f]{64})/)?.[1];
    const run2 = makeDeps();
    await hqCmd(['audit', 'verify'], run2);
    const hash2 = run2.renderer.captured.out.join('').match(/contentHash:\s+([0-9a-f]{64})/)?.[1];
    expect(hash1).toBe(hash2);
  });
});
