import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isStdinTTY: vi.fn(),
}));

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    color: { amber: (value: string) => value, dim: (value: string) => value },
    isStdinTTY: mocks.isStdinTTY,
  };
});

import { createCommandHostAdapters } from '../src/wiring/command-host-adapters.js';

function harness(options?: {
  tool?: unknown;
  outputs?: unknown[];
  confirmSlash?: (question: string, defaultYes: boolean) => Promise<boolean | null>;
  readLine?: () => Promise<string>;
}) {
  const executeBatch = vi.fn().mockResolvedValue({ outputs: options?.outputs ?? [] });
  const get = vi.fn(() => options?.tool);
  const readLine = vi.fn(options?.readLine ?? (async () => ''));
  const adapters = createCommandHostAdapters({
    agent: { toolExecutor: { executeBatch } } as never,
    toolRegistry: { get } as never,
    interruptController: { confirmSlash: options?.confirmSlash },
    reader: { readLine } as never,
  }) as {
    executeTool: (
      name: string,
      input: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ detail: string }>;
    confirm: (question: string, defaultYes?: boolean) => Promise<boolean | null>;
  };
  return { adapters, executeBatch, get, readLine };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createCommandHostAdapters', () => {
  it('executes a registered tool and returns its textual detail', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    const result = {
      type: 'tool_result',
      content: 'created',
      is_error: false,
    };
    const { adapters, executeBatch } = harness({
      tool: { name: 'write' },
      outputs: [{ result }],
    });
    const context = { cwd: 'C:/repo' };

    await expect(adapters.executeTool('write', { path: 'a' }, context as never)).resolves.toEqual({
      detail: 'created',
    });
    expect(executeBatch).toHaveBeenCalledWith(
      [
        {
          type: 'tool_use',
          id: 'slash-write-123',
          name: 'write',
          input: { path: 'a' },
        },
      ],
      context,
      'sequential',
    );
  });

  it('rejects missing, empty, pending, and failed tool executions', async () => {
    await expect(harness().adapters.executeTool('missing', {}, {} as never)).rejects.toThrow(
      'not registered',
    );
    await expect(
      harness({ tool: {}, outputs: [] }).adapters.executeTool('empty', {}, {} as never),
    ).rejects.toThrow('returned no result');
    await expect(
      harness({
        tool: {},
        outputs: [{ result: { type: 'tool_confirm_pending' } }],
      }).adapters.executeTool('pending', {}, {} as never),
    ).rejects.toThrow('still requires interactive confirmation');
    await expect(
      harness({
        tool: {},
        outputs: [{ result: { type: 'tool_result', is_error: true, content: 'failed' } }],
      }).adapters.executeTool('failed', {}, {} as never),
    ).rejects.toThrow('failed');
  });

  it('prefers the interrupt controller confirmation callback', async () => {
    const confirmSlash = vi.fn().mockResolvedValue(null);
    const { adapters } = harness({ confirmSlash });

    await expect(adapters.confirm('Proceed?', false)).resolves.toBeNull();
    expect(confirmSlash).toHaveBeenCalledWith('Proceed?', false);
  });

  it('rejects non-interactive confirmation without reading stdin', async () => {
    mocks.isStdinTTY.mockReturnValue(false);
    const { adapters, readLine } = harness();

    await expect(adapters.confirm('Proceed?')).resolves.toBe(false);
    expect(readLine).not.toHaveBeenCalled();
  });

  it.each([
    ['', true, true],
    ['', false, false],
    ['y', false, true],
    ['YES', false, true],
    ['n', true, false],
    ['q', true, null],
    ['quit', true, null],
    ['cancel', true, null],
  ] as const)('maps terminal answer %j with default %j', async (answer, defaultYes, expected) => {
    mocks.isStdinTTY.mockReturnValue(true);
    const { adapters, readLine } = harness({ readLine: async () => answer });

    await expect(adapters.confirm('Proceed?', defaultYes)).resolves.toBe(expected);
    expect(readLine).toHaveBeenCalledWith(`  ? Proceed? ${defaultYes ? '[Y/n/q]' : '[y/N/q]'} `);
  });

  it('returns false when terminal input fails', async () => {
    mocks.isStdinTTY.mockReturnValue(true);
    const { adapters } = harness({
      readLine: async () => {
        throw new Error('closed');
      },
    });

    await expect(adapters.confirm('Proceed?')).resolves.toBe(false);
  });
});
