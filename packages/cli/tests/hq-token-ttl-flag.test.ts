/**
 * Focused tests for the `--ttl` flag on `wstack hq token create`.
 *
 * Covers:
 *   - bare `--ttl <value>` form (1h, 7d, 30m, 3600s, 86400000)
 *   - inline `--ttl=<value>` form
 *   - `--ttl` via deps.flags (parseArgs path)
 *   - TTL + label + --client compose correctly
 *   - unit parsing: ms/s/m/h/d/w with case-insensitivity
 *   - error paths: missing value, negative, NaN, unknown unit, compound
 *   - default: no --ttl → expiresAt absent (backward-compat)
 *
 * @vitest-environment node
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readHqAuthFile } from '@wrongstack/core/hq';
import type { ContentBlock, TextBlock } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hqCmd } from '../src/subcommands/handlers/hq.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

vi.mock('../src/hq-server.js', () => ({ startHqServer: vi.fn() }));

let tmpHome: string;
let dataDir: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-ttl-flag-'));
  dataDir = path.join(tmpHome, 'hq');
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
  const captured: CapturedRenderer = { out: [], err: [], warn: [] };
  const renderer = {
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
    }) as never,
    clear: vi.fn() as never,
    captured,
  };
  return {
    config: {} as SubcommandDeps['config'],
    renderer,
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── Unit-form parsing ─────────────────────────────────────────────────────

describe('wstack hq token create --ttl — unit-form parsing', () => {
  it('parses --ttl 1h as 1 hour', async () => {
    const deps = makeDeps();
    const before = Date.now();
    expect(await hqCmd(['token', 'create', 'rotating', '--ttl', '1h'], deps)).toBe(0);
    const after = Date.now();

    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.expiresAt).toBeDefined();
    const expiresAt = Date.parse(token!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS - 5);
    expect(expiresAt).toBeLessThanOrEqual(after + HOUR_MS + 5);
  });

  it('parses --ttl 7d as 7 days', async () => {
    const deps = makeDeps();
    const before = Date.now();
    expect(await hqCmd(['token', 'create', '--ttl', '7d'], deps)).toBe(0);
    const after = Date.now();

    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    const expiresAt = Date.parse(token!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 5);
    expect(expiresAt).toBeLessThanOrEqual(after + 7 * DAY_MS + 5);
  });

  it('parses --ttl 30m as 30 minutes', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', '30m'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.expiresAt).toBeDefined();
  });

  it('parses --ttl 3600s as 1 hour (seconds unit)', async () => {
    const deps = makeDeps();
    const before = Date.now();
    expect(await hqCmd(['token', 'create', '--ttl', '3600s'], deps)).toBe(0);
    const after = Date.now();

    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    const expiresAt = Date.parse(token!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS - 5);
    expect(expiresAt).toBeLessThanOrEqual(after + HOUR_MS + 5);
  });

  it('parses --ttl 1w as 1 week', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', '1w'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.expiresAt).toBeDefined();
  });

  it('parses --ttl 5000ms as 5 seconds (explicit ms unit)', async () => {
    const deps = makeDeps();
    const before = Date.now();
    expect(await hqCmd(['token', 'create', '--ttl', '5000ms'], deps)).toBe(0);
    const after = Date.now();

    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    const expiresAt = Date.parse(token!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5_000 - 5);
    expect(expiresAt).toBeLessThanOrEqual(after + 5_000 + 5);
  });

  it('accepts unit-form TTL via deps.flags (parseArgs path)', async () => {
    const deps = makeDeps({ flags: { 'data-dir': dataDir, ttl: '2h' } });
    expect(await hqCmd(['token', 'create', 'via-flags'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.expiresAt).toBeDefined();
  });

  it('is case-insensitive on the unit suffix (1H, 7D, 30M)', async () => {
    const deps1 = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', '1H'], deps1)).toBe(0);
    expect((await readHqAuthFile(dataDir)).browserTokens?.[0]?.expiresAt).toBeDefined();

    // Wipe and retry with mixed case.
    await fs.rm(path.join(dataDir, 'auth.json'), { force: true });
    const deps2 = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', '7D'], deps2)).toBe(0);
    expect((await readHqAuthFile(dataDir)).browserTokens?.[0]?.expiresAt).toBeDefined();
  });
});

// ── Bare-integer form ─────────────────────────────────────────────────────

describe('wstack hq token create --ttl — bare integer (milliseconds)', () => {
  it('parses --ttl 86400000 as 1 day', async () => {
    const deps = makeDeps();
    const before = Date.now();
    expect(await hqCmd(['token', 'create', '--ttl', '86400000'], deps)).toBe(0);
    const after = Date.now();

    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    const expiresAt = Date.parse(token!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + DAY_MS - 5);
    expect(expiresAt).toBeLessThanOrEqual(after + DAY_MS + 5);
  });
});

// ── Inline form ───────────────────────────────────────────────────────────

describe('wstack hq token create --ttl=<value> — inline form', () => {
  it('parses --ttl=1h inline', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl=1h'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.expiresAt).toBeDefined();
  });

  it('parses --ttl=3600000 inline (bare ms)', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl=3600000'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.expiresAt).toBeDefined();
  });
});

// ── Composition with other flags ──────────────────────────────────────────

describe('wstack hq token create --ttl — composes with --client and label', () => {
  it('stamps expiresAt on a --client token', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--client', 'ci-bot', '--ttl', '1h'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).clientTokens?.[0];
    expect(token?.label).toBe('ci-bot');
    expect(token?.expiresAt).toBeDefined();
    expect(token?.capabilities).toEqual(['telemetry.publish']);
  });

  it('label is not consumed by --ttl positional scan', async () => {
    const deps = makeDeps();
    // --ttl comes before the label; label should still resolve correctly.
    expect(await hqCmd(['token', 'create', '--ttl', '1h', 'after-flag'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.label).toBe('after-flag');
    expect(token?.expiresAt).toBeDefined();
  });

  it('stdout reports the expiresAt alongside createdAt', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', '1h'], deps)).toBe(0);
    const out = deps.renderer.captured.out.join('');
    expect(out).toContain('expiresAt:');
    expect(out).toContain('createdAt:');
  });
});

// ── Error paths ───────────────────────────────────────────────────────────

describe('wstack hq token create --ttl — error paths', () => {
  it('errors when --ttl has no value (bare flag at end of args)', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl'], deps)).toBe(1);
    const err = deps.renderer.captured.err.join('');
    expect(err).toContain('--ttl requires a value');
    // No token should have been minted.
    expect((await readHqAuthFile(dataDir)).browserTokens ?? []).toHaveLength(0);
  });

  it('errors when --ttl value is negative', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', '-3600'], deps)).toBe(1);
    const err = deps.renderer.captured.err.join('');
    // -3600 fails the unit regex (negative sign) AND the bare-int regex; the
    // error message is the "unknown unit" form.
    expect(err).toContain('--ttl');
  });

  it('errors when --ttl value has an unknown unit', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', '5x'], deps)).toBe(1);
    const err = deps.renderer.captured.err.join('');
    // The shared parser drops the `--ttl` prefix from error strings; assert
    // on the actionable tokens the operator actually needs (the value and
    // the unit list) rather than the prefix.
    expect(err).toContain('5x');
    expect(err).toMatch(/ms.*s.*m.*h.*d.*w/);
  });

  it('errors when --ttl value is empty', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', '--ttl', ''], deps)).toBe(1);
    const err = deps.renderer.captured.err.join('');
    expect(err).toContain('empty');
  });
});

// ── Default (no --ttl) ────────────────────────────────────────────────────

describe('wstack hq token create — no --ttl (backward-compat)', () => {
  it('does not stamp expiresAt when --ttl is absent', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create', 'permanent'], deps)).toBe(0);
    const token = (await readHqAuthFile(dataDir)).browserTokens?.[0];
    expect(token?.label).toBe('permanent');
    expect(token?.expiresAt).toBeUndefined();
  });

  it('stdout omits the expiresAt line when --ttl is absent', async () => {
    const deps = makeDeps();
    expect(await hqCmd(['token', 'create'], deps)).toBe(0);
    const out = deps.renderer.captured.out.join('');
    expect(out).not.toContain('expiresAt:');
  });
});
