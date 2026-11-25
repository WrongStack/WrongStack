import { describe, expect, it } from 'vitest';
import { selectedAcpEffort } from '../src/acp-model-option.js';

describe('selectedAcpEffort (F2179)', () => {
  it('ignores whitespace-only currentValue and trims valid values', () => {
    expect(
      selectedAcpEffort([
        {
          id: 'thought_level',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: '   ',
          options: [],
        },
      ]),
    ).toBeUndefined();

    expect(
      selectedAcpEffort([
        {
          id: 'thought_level',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: ' high ',
          options: [],
        },
      ]),
    ).toBe('high');
  });
});
