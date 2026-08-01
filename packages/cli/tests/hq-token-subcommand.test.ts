import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hqTokenVerifier, readHqAuthFile } from '@wrongstack/core/hq';
import type { ContentBlock, TextBlock } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hqCmd } from '../src/subcommands/handlers/hq.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

/**
 * Tests for the `wstack hq` subcommand group (Phase 3).
 *
 * Covers token create/list/revoke against a temp data dir. Server lifecycle
 * (`serve` / `wstack hq` alone) is exercised in hq-server.test.ts via
 * startHqServer directly; here we only verify the subcommand dispatcher
 * routes to startHqServer (mocked) — driving a real long-lived server in
 * a unit test would block the runner.
 */

const startHqServerMock = vi.hoisted(() => vi.fn());

vi.mock('../src/hq-server.js', () => ({
  startHqServer: startHqServerMock,
  // type re-export passthrough
}));

let tmpHome: string;
let dataDir: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-subcmd-'));
  dataDir = path.join(tmpHome, 'hq');
  startHqServerMock.mockReset();
  startHqServerMock.mockResolvedValue({
    host: '127.0.0.1',
    port: 3499,
    close: vi.fn(async () => {}),
  });
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
    writeToolCall: vi.fn((name: string, _input: unknown) => {
      captured.out.push(name);
    }),
    writeToolResult: vi.fn((name: string, content: unknown, _isError: boolean) => {
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

describe('wstack hq — token create', () => {
  it('creates a token and writes it to <dataDir>/auth.json', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'create', 'my-laptop'], deps);
    expect(code).toBe(0);
    const auth = await readHqAuthFile(dataDir);
    expect(auth.browserTokens).toHaveLength(1);
    const token = auth.browserTokens?.[0];
    expect(token?.label).toBe('my-laptop');
    expect(token?.capabilities).toEqual(['control.enqueue']);
    // WS-044: the secret is not persisted — only `sha256(secret)`. The printed
    // output is now the only place it ever exists, which is why `create` has
    // always printed it once. This assertion used to read the secret back off
    // disk, i.e. it asserted the exact property that was the finding.
    expect(token?.token).toBe('');
    expect(token?.verifier).toMatch(/^[0-9a-f]{64}$/);

    const written = deps.renderer.captured.out.join('');
    expect(written).toContain('Created browser token.');
    const printed = written.match(/[0-9a-f]{32,}/)?.[0];
    expect(printed).toBeDefined();
    expect(printed?.length).toBeGreaterThanOrEqual(32);
    // The printed secret is the one the stored verifier was derived from.
    expect(hqTokenVerifier(printed ?? '')).toBe(token?.verifier);
  });

  it('works without a label (label field omitted)', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'create'], deps);
    expect(code).toBe(0);
    const auth = await readHqAuthFile(dataDir);
    expect(auth.browserTokens).toHaveLength(1);
    expect(auth.browserTokens?.[0]?.label).toBeUndefined();
  });

  it('appends to an existing token list (does not clobber)', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'first'], deps);
    await hqCmd(['token', 'create', 'second'], deps);
    const auth = await readHqAuthFile(dataDir);
    expect(auth.browserTokens).toHaveLength(2);
    expect(auth.browserTokens?.[0]?.label).toBe('first');
    expect(auth.browserTokens?.[1]?.label).toBe('second');
  });

  it('accepts only browser capabilities for browser tokens', async () => {
    const deps = makeDeps({ flags: { 'data-dir': dataDir, capabilities: 'control.enqueue' } });
    expect(await hqCmd(['token', 'create', 'dashboard'], deps)).toBe(0);
    expect((await readHqAuthFile(dataDir)).browserTokens?.[0]?.capabilities).toEqual([
      'control.enqueue',
    ]);

    const invalidDeps = makeDeps({
      flags: { 'data-dir': dataDir, capabilities: 'control.execute' },
    });
    expect(await hqCmd(['token', 'create', 'too-powerful'], invalidDeps)).toBe(1);
    expect(invalidDeps.renderer.captured.err.join('')).toContain(
      'Invalid browser token capabilities',
    );
  });
});

describe('wstack hq — token list', () => {
  it('reports OPEN MODE when no tokens exist', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'list'], deps);
    expect(code).toBe(0);
    const out = deps.renderer.captured.out.join('');
    expect(out).toContain('OPEN MODE');
    expect(out).toContain('wstack hq token create');
  });

  it('lists issued tokens with masked token strings', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'laptop'], deps);
    // Reset captured (each call writes via the same renderer)
    const deps2 = makeDeps();
    const code = await hqCmd(['token', 'list'], deps2);
    expect(code).toBe(0);
    const out = deps2.renderer.captured.out.join('');
    expect(out).toContain('TOKEN MODE');
    expect(out).toContain('1)');
    expect(out).toMatch(/…/); // masked
    expect(out).toContain('"laptop"');
  });

  it('accepts `ls` as an alias', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'ls'], deps);
    expect(code).toBe(0);
  });
});

describe('wstack hq — token revoke', () => {
  it('revokes by exact id', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'first'], deps);
    const before = await readHqAuthFile(dataDir);
    const id = before.browserTokens?.[0]?.id;
    expect(id).toBeDefined();
    const code = await hqCmd(['token', 'revoke', id!], deps);
    expect(code).toBe(0);
    const after = await readHqAuthFile(dataDir);
    expect(after.browserTokens).toHaveLength(0);
  });

  it('revokes by id prefix', async () => {
    const deps = makeDeps();
    await hqCmd(['token', 'create', 'first'], deps);
    const before = await readHqAuthFile(dataDir);
    const prefix = before.browserTokens?.[0]?.id.slice(0, 8);
    expect(prefix).toBeDefined();
    const code = await hqCmd(['token', 'revoke', prefix!], deps);
    expect(code).toBe(0);
    const after = await readHqAuthFile(dataDir);
    expect(after.browserTokens).toHaveLength(0);
  });

  it('exits 1 + error when no token matches the prefix', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'revoke', 'nonexistent-id'], deps);
    expect(code).toBe(1);
    const err = deps.renderer.captured.err.join('');
    expect(err).toContain('No browser token found');
  });

  it('exits 1 with usage when revoke has no id argument', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'revoke'], deps);
    expect(code).toBe(1);
    const err = deps.renderer.captured.err.join('');
    expect(err).toContain('Usage: wstack hq token revoke');
  });
});

describe('wstack hq — dispatch + help', () => {
  it('`wstack hq` alone routes to startHqServer (mocked)', async () => {
    const deps = makeDeps();
    // startHqServer blocks; the mock resolves immediately but we still need
    // the SIGINT/SIGTERM block to be short-circuited. The mock returns a
    // close() that resolves, but the await new Promise... never fires.
    // Send a SIGTERM-like exit by registering a fake shutdown we control.
    const realOn = process.on;
    const handlers: { type: string; cb: () => void }[] = [];
    process.on = ((type: string, cb: () => void) => {
      if (type === 'SIGINT' || type === 'SIGTERM') handlers.push({ type, cb });
      return process;
    }) as never;
    try {
      const promise = hqCmd([], deps);
      // Give the await startHqServer + Promise setup a tick.
      await new Promise((r) => setImmediate(r));
      for (const h of handlers) h.cb();
      const code = await promise;
      expect(code).toBe(0);
      expect(startHqServerMock).toHaveBeenCalledTimes(1);
      expect(startHqServerMock.mock.calls[0]?.[0]).toMatchObject({
        // The HQ CLI opts into the wide bind on purpose; startHqServer's own
        // default stays loopback for programmatic callers.
        host: '0.0.0.0',
        port: 3499,
        dataDir,
      });
    } finally {
      process.on = realOn;
    }
  });

  it('`wstack hq serve` routes to startHqServer (explicit form)', async () => {
    const realOn = process.on;
    const handlers: { type: string; cb: () => void }[] = [];
    process.on = ((type: string, cb: () => void) => {
      if (type === 'SIGINT' || type === 'SIGTERM') handlers.push({ type, cb });
      return process;
    }) as never;
    try {
      const deps = makeDeps();
      const promise = hqCmd(['serve'], deps);
      await new Promise((r) => setImmediate(r));
      for (const h of handlers) h.cb();
      const code = await promise;
      expect(code).toBe(0);
      expect(startHqServerMock).toHaveBeenCalled();
    } finally {
      process.on = realOn;
    }
  });

  it('unknown subcommand exits 1 and prints help', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['bogus'], deps);
    expect(code).toBe(1);
    const err = deps.renderer.captured.err.join('');
    expect(err).toContain('Unknown hq subcommand: bogus');
    const out = deps.renderer.captured.out.join('');
    expect(out).toContain('Usage: wstack hq');
  });

  it('`wstack hq help` prints help and exits 0', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['help'], deps);
    expect(code).toBe(0);
    const out = deps.renderer.captured.out.join('');
    expect(out).toContain('wstack hq token create');
    expect(out).toContain('--data-dir');
  });
});
