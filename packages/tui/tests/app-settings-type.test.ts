import { describe, expect, it } from 'vitest';
import { coerceAgentSwarmMode } from '../src/app-settings-type.js';

describe('coerceAgentSwarmMode', () => {
  it.each([
    [true, 'bottom'],
    [undefined, 'bottom'],
    [false, 'off'],
    ['bottom', 'bottom'],
    ['sidebar', 'sidebar'],
    ['off', 'off'],
    ['invalid', 'bottom'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(coerceAgentSwarmMode(input)).toBe(expected);
  });
});
