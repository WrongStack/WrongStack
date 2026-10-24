import type { Provider } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { createProviderLlm } from '../../src/research/llm.js';
import type { ResearchLlmRequest } from '../../src/research/types.js';

const response = { content: [{ type: 'text', text: 'current' }] };
const request = (signal?: AbortSignal): ResearchLlmRequest => ({
  system: 's',
  prompt: 'p',
  maxTokens: 16,
  schemaName: 'x',
  schema: {},
  ...(signal ? { signal } : {}),
});
describe('research cancellation fences', () => {
  it('rejects an already-cancelled request before calling the provider', async () => {
    const complete = vi.fn(async () => response);
    const provider = {
      capabilities: { structuredOutput: false, jsonMode: false },
      complete,
    } as unknown as Provider;
    const llm = createProviderLlm(() => ({ provider, model: 'fake' }))!;
    expect(await llm(request())).toBe('current');
    complete.mockClear();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(llm(request(controller.signal))).rejects.toThrow('stop');
    expect(complete).not.toHaveBeenCalled();
  });
  it('discards a gated completion from a provider that settles after cancellation', async () => {
    let release!: (value: typeof response) => void;
    const provider = {
      capabilities: { structuredOutput: false, jsonMode: false },
      complete: () =>
        new Promise<typeof response>((resolve) => {
          release = resolve;
        }),
    } as unknown as Provider;
    const llm = createProviderLlm(() => ({ provider, model: 'fake' }))!;
    const controller = new AbortController(),
      pending = llm(request(controller.signal));
    controller.abort();
    release(response);
    await expect(pending).rejects.toThrow('cancelled');
  });
});
