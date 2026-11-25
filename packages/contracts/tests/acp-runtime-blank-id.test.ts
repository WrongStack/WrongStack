import { describe, expect, it } from 'vitest';
import { acpRuntimeSelectionsError, acpRuntimeValuesError } from '../src/types/acp-runtime.js';

describe('acp-runtime validation (F2216)', () => {
  it('rejects whitespace-only option and agent identifiers', () => {
    expect(acpRuntimeValuesError({ '   ': 'val' })).toBeDefined();
    expect(acpRuntimeSelectionsError({ '   ': { k: 'v' } })).toBeDefined();
    expect(acpRuntimeValuesError({ model: 'gpt-5' })).toBeUndefined();
  });
});
