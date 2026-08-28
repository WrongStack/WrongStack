import { describe, expect, it } from 'vitest';
import { siblingTriggerOf } from '../../src/components/ProviderWaitingRoom';

describe('siblingTriggerOf', () => {
  it('extracts the trigger pair from a sibling-quarantine message', () => {
    expect(
      siblingTriggerOf({
        lastErrorMessage: 'Sibling quarantine: account-level budget exhausted on openai/gpt-4o',
      }),
    ).toBe('openai/gpt-4o');
  });

  it('returns null for ordinary errors and missing messages', () => {
    expect(siblingTriggerOf({ lastErrorMessage: 'Too many requests' })).toBeNull();
    expect(siblingTriggerOf({ lastErrorMessage: undefined })).toBeNull();
    expect(siblingTriggerOf({})).toBeNull();
  });
});
