import type { ModelsDevPayload } from '@wrongstack/contracts/types/models-registry';
import { describe, expect, it } from 'vitest';
import { mergeModelsPayload } from '../src/utils/merge-models-payload.js';

describe('mergeModelsPayload prototype key guard (F2010)', () => {
  it('does not treat Object.prototype keys as existing providers during merge', () => {
    const out = mergeModelsPayload({}, {
      toString: { id: 'toString', name: 'Custom', customTag: 'keep', models: {} },
    } as unknown as ModelsDevPayload);
    expect((out['toString'] as unknown as { customTag?: string })?.customTag).toBe('keep');
  });
});
