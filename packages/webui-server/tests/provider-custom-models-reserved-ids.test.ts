import type { ProviderConfig } from '@wrongstack/contracts/types';
import { expect, it } from 'vitest';
import { createCustomModelHandlers } from '../src/server/provider/custom-models.js';
import type { ProviderServiceContext } from '../src/server/provider/mutations.js';

it('persists, updates and removes reserved model ids without duplicating the allowlist', async () => {
  let stored: Record<string, ProviderConfig> = { local: { type: 'openai-compatible' } };
  let saves = 0;
  const handlers = createCustomModelHandlers({
    loadConfigProviders: async () => JSON.parse(JSON.stringify(stored)),
    saveConfigProviders: async (value: Record<string, ProviderConfig>) => {
      saves++;
      stored = JSON.parse(JSON.stringify(value));
    },
    sendOperationResult() {},
    broadcastSaved() {},
  } as unknown as ProviderServiceContext);
  for (const id of ['__proto__', 'constructor', 'toString', 'ordinary']) {
    await handlers.handleCustomModelSet({} as never, 'local', id, { name: 'Initial' });
    await handlers.handleCustomModelSet({} as never, 'local', id, { name: 'Updated' });
    expect(Object.hasOwn(stored.local!.customModels!, id)).toBe(true);
    expect(stored.local!.customModels![id]).toEqual({ name: 'Updated' });
    expect(stored.local!.models!.filter((model) => model === id)).toHaveLength(1);
    await handlers.handleCustomModelRemove({} as never, 'local', id);
    expect(stored.local!.customModels).toBeUndefined();
    expect(stored.local!.models).toBeUndefined();
  }
  const before = saves;
  await handlers.handleCustomModelSet({} as never, 'missing', 'ordinary', { name: 'Ignored' });
  expect(saves).toBe(before);
});
