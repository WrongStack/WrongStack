import { describe, expect, it, vi } from 'vitest';

const { toLanguagePackageInput } = vi.hoisted(() => ({
  toLanguagePackageInput: vi.fn(() => ({ action: 'install', packages: ['vitest'] })),
}));

vi.mock('@wrongstack/techstack', () => ({ toLanguagePackageInput }));

import { createPackageOperationExecutor } from '../src/server/start-webui-remediation.js';

describe('createPackageOperationExecutor', () => {
  it('executes a language package operation and returns its detail', async () => {
    const executeBatch = vi.fn().mockResolvedValue({
      outputs: [
        {
          result: { type: 'tool_result', is_error: false, content: 'installed vitest' },
        },
      ],
    });
    const context = { session: { id: 'session-1' } };
    const execute = createPackageOperationExecutor({
      toolExecutor: { executeBatch } as never,
      context: context as never,
      events: {} as never,
      permissionPolicy: {} as never,
    });
    const operation = { action: 'install', ecosystem: 'node', packages: ['vitest'] } as never;

    await expect(execute(operation, 'packages/webui-server')).resolves.toEqual({
      detail: 'installed vitest',
    });
    expect(toLanguagePackageInput).toHaveBeenCalledWith(operation, 'packages/webui-server');
    expect(executeBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'tool_use',
          id: expect.stringMatching(/^techstack-remediation-/),
          name: 'language_package',
          input: { action: 'install', packages: ['vitest'] },
        }),
      ],
      context,
      'sequential',
    );
  });

  it('applies an always confirmation decision before retrying', async () => {
    const executeBatch = vi
      .fn()
      .mockResolvedValueOnce({
        outputs: [
          {
            tool: { name: 'language_package' },
            result: {
              type: 'tool_confirm_pending',
              input: { action: 'install' },
              toolUseId: 'use-1',
              suggestedPattern: 'install vitest',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        outputs: [{ result: { type: 'tool_result', is_error: false, content: 'approved' } }],
      });
    const emit = vi.fn((_event: string, payload: { resolve: (decision: 'always') => void }) => {
      payload.resolve('always');
    });
    const trust = vi.fn().mockResolvedValue(undefined);
    const execute = createPackageOperationExecutor({
      toolExecutor: { executeBatch } as never,
      context: { session: { id: 'session-1' } } as never,
      events: { listenerCount: vi.fn(() => 1), emit } as never,
      permissionPolicy: { trust } as never,
    });

    await expect(execute({} as never)).resolves.toEqual({ detail: 'approved' });
    expect(trust).toHaveBeenCalledWith({
      tool: 'language_package',
      pattern: 'install vitest',
    });
    expect(executeBatch).toHaveBeenCalledTimes(2);
  });
});
