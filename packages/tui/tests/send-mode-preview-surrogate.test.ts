import { describe, expect, it } from 'vitest';
import { formatSendModeMessagePreview } from '../src/components/send-mode-model.js';

describe('formatSendModeMessagePreview (F2192)', () => {
  it('does not split UTF-16 surrogate pairs when truncating', () => {
    expect(formatSendModeMessagePreview('ab😀cd', 4)).toBe('ab…');
  });
});
