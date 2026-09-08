/**
 * Additional tests for context-pins plugin - covering persist error path.
 *
 * The write failure is injected PHYSICALLY rather than by mocking: a NUL byte
 * is appended to the target basename, so every node:fs operation on the path
 * throws (ERR_INVALID_ARG_VALUE on win32 and POSIX alike) while the directory
 * part stays writable. The failure therefore fires inside the REAL
 * `atomicWrite` primitive (its temp-file write), which `persistPins` catches
 * and reports as `persisted: false`.
 *
 * Why not vi.mock('@wrongstack/core/utils') (the previous approach)? Two
 * observed defects, both recorded in the 2026-09-08 flake hunt:
 *  - In isolation the mock factory's `importOriginal` failed cold with
 *    ERR_MODULE_NOT_FOUND, so this file could not even load on its own.
 *  - Under full-suite parallelism the mock once failed to reach the module
 *    instance the plugin imported: the real atomicWrite executed, wrote a
 *    real pins.json into the repo, and `persisted` came back `true`
 *    (flaky `expected true to be false` on the assertion below, ~1 in 121
 *    full-suite runs). A physical failure has no module instance to bypass
 *    and can never create a file.
 *
 * The temp dir MUST live inside the project root (cwd): the plugin's
 * `resolveProjectPath` rejects paths that resolve outside the project root
 * and silently falls back to in-memory-only persistence (`persisted: true`,
 * no write, no error) — an os.tmpdir() path defeats the whole test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const contextPinsPlugin = (await import('../src/context-pins')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    registerSystemPromptContributor: vi.fn(() => vi.fn()),
  };
}

function getTool(
  api: MockApi,
  name: string,
): { execute: (input: unknown) => Promise<Record<string, unknown>> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<Record<string, unknown>> };
}

describe('context-pins plugin - persist error', () => {
  it('handles write failure gracefully', async () => {
    const tmp = mkdtempSync(path.join(process.cwd(), 'context-pins-persist-err-'));
    try {
      // A non-empty filePath is required: with the default empty path the
      // plugin is in-memory-only and persistPins() short-circuits to `true`
      // before any write is attempted. Two more constraints shape this path:
      // it must resolve INSIDE the project root (resolveProjectPath rejects
      // anything outside and falls back to in-memory), and the NUL byte is
      // appended to the BASENAME only, so dirname stays writable and the
      // failure fires inside the real atomicWrite instead of ensureDir.
      const filePath = path.join(tmp, 'pins.json') + '\0';
      const api = makeApi({ extensions: { 'context-pins': { filePath } } });
      contextPinsPlugin.setup(api as never);
      const add = getTool(api, 'pin_add');
      const result = (await add.execute({ text: 'test pin' })) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.persisted).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
