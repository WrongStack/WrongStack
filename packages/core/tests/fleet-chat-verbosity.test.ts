import { describe, expect, it } from 'vitest';
import { resolveFleetChatVerbosity } from '../src/types/config.js';

describe('resolveFleetChatVerbosity', () => {
  it('defaults to off when nothing is set', () => {
    expect(resolveFleetChatVerbosity(undefined)).toBe('off');
    expect(resolveFleetChatVerbosity({})).toBe('off');
  });

  it('explicit enum always wins', () => {
    expect(resolveFleetChatVerbosity({ fleetChatVerbosity: 'off' })).toBe('off');
    expect(resolveFleetChatVerbosity({ fleetChatVerbosity: 'full' })).toBe('full');
  });

  it('falls through an invalid enum value to off default', () => {
    expect(resolveFleetChatVerbosity({ fleetChatVerbosity: 'loud' as never })).toBe('off');
    expect(resolveFleetChatVerbosity({ fleetChatVerbosity: '' as never })).toBe('off');
  });
});
