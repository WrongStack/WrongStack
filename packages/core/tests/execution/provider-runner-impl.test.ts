import { describe, expect, it, vi } from 'vitest';
import type { Response } from '../../src/types/provider.js';
import type { RunProviderOptions } from '../../src/types/provider-runner.js';

const mocks = vi.hoisted(() => ({
  runProviderWithRetry: vi.fn(),
}));

vi.mock('../../src/core/provider-runner.js', () => ({
  runProviderWithRetry: mocks.runProviderWithRetry,
}));

import { DefaultProviderRunner } from '../../src/execution/provider-runner-impl.js';

describe('DefaultProviderRunner', () => {
  it('delegates the complete request to runProviderWithRetry', async () => {
    const options = { model: 'test-model' } as unknown as RunProviderOptions;
    const response = { text: 'done' } as unknown as Response;
    mocks.runProviderWithRetry.mockResolvedValue(response);

    await expect(new DefaultProviderRunner().run(options)).resolves.toBe(response);
    expect(mocks.runProviderWithRetry).toHaveBeenCalledOnce();
    expect(mocks.runProviderWithRetry).toHaveBeenCalledWith(options);
  });
});
