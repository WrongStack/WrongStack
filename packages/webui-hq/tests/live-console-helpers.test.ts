import { describe, expect, it } from 'vitest';
import { commandLifecycleTone } from '../src/domain/status-tone.js';

describe('Console command lifecycle presentation', () => {
  it('maps pushed command states to readable status tones', () => {
    expect(commandLifecycleTone('queued')).toBe('warn');
    expect(commandLifecycleTone('delivered')).toBe('info');
    expect(commandLifecycleTone('accepted')).toBe('info');
    expect(commandLifecycleTone('completed')).toBe('active');
    expect(commandLifecycleTone('failed')).toBe('error');
    expect(commandLifecycleTone('rejected')).toBe('error');
  });
});
