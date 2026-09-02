/**
 * Additional tests for context-pins plugin - covering persist error path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Persistence goes through the shared `atomicWrite` primitive (which adds
// the Windows EPERM/EBUSY rename retry), so the failure path is injected
// there rather than at `fs.writeFileSync`. Mocking `node:fs` would no
// longer intercept the write at all — the test would silently pass while
// writing a real file into the repo.
const mockAtomicWrite = vi.fn();
vi.mock('@wrongstack/core/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  atomicWrite: mockAtomicWrite,
  ensureDir: vi.fn(async () => undefined),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{"pins":[],"nextId":1}'),
  statSync: vi.fn(() => ({ size: 100 })),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('context-pins plugin - persist error', () => {
  it('handles write failure gracefully', async () => {
    mockAtomicWrite.mockImplementation(() => {
      throw new Error('mock error');
    });
    // A non-empty filePath is required: with the default empty path the plugin
    // is in-memory-only and persistPins() short-circuits to `true` before ever
    // calling the (mocked, throwing) atomicWrite — so the error path is never
    // exercised. The path never touches disk because atomicWrite is mocked.
    const api = makeApi({ extensions: { 'context-pins': { filePath: 'pins.json' } } });
    contextPinsPlugin.setup(api as never);
    const add = getTool(api, 'pin_add');
    const result = (await add.execute({ text: 'test pin' })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(false);
  });
});
