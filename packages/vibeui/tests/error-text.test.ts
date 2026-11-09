import { describe, expect, it } from 'vitest';
import { errorText } from '../src/lib/error-text';

describe('errorText', () => {
  it('shows an Error by its message and anything else as text', () => {
    expect(errorText(new Error('ACP settings were not confirmed.'))).toBe(
      'ACP settings were not confirmed.',
    );
    expect(errorText('plain')).toBe('plain');
    expect(errorText(42)).toBe('42');
    expect(errorText(undefined)).toBe('undefined');
  });
});
