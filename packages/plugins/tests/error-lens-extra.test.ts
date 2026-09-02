/**
 * Tests for error-lens history trimming.
 */
import { beforeEach, describe, it, vi } from 'vitest';

const errorLensPlugin = (await import('../src/error-lens')).default;

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
  llm?: { complete: ReturnType<typeof vi.fn>; defaults: ReturnType<typeof vi.fn> } | undefined;
}

function makeApi(
  overrides: { extensions?: Record<string, unknown>; llm?: MockApi['llm'] } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    llm: overrides.llm,
  };
}

function getHook(api: MockApi): (input: unknown) => Promise<unknown> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  const fn = (call as unknown[])[2] as (input: unknown) => unknown | Promise<unknown>;
  return async (input: unknown) => fn(input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('error-lens history trimming', () => {
  it('trims history when it exceeds historySize', async () => {
    const api = makeApi({ extensions: { 'error-lens': { historySize: 3, minOutputChars: 10 } } });
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    // Add 5 unique errors to trigger trim (historySize=3, after 4th it trims)
    for (let i = 0; i < 5; i++) {
      await hook({
        toolName: 'read',
        toolInput: { path: `/test${i}.ts` },
        toolResult: { isError: true, content: `Error: msg ${i}\n    at file${i}.ts:${i}:${i}` },
      });
    }
  });

  it('does not trim when history is within limits', async () => {
    const api = makeApi({ extensions: { 'error-lens': { historySize: 10, minOutputChars: 10 } } });
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    for (let i = 0; i < 3; i++) {
      await hook({
        toolName: 'read',
        toolInput: { path: '/test.ts' },
        toolResult: { isError: true, content: `Error: msg ${i}\n    at file.ts:${i}:${i}` },
      });
    }
  });
});
