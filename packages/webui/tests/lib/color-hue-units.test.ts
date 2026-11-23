import { describe, expect, it } from 'vitest';
import { oklchToHex } from '../../src/lib/color';

// F1348: the hue was read with bare parseFloat, so CSS <angle> units were
// dropped — `0.5turn` became 0.5°, `3.14159rad` 3.14°. Core's design-color
// (which this file duplicates) converts them; a turn/rad/grad token seeded the
// Design Studio color picker with the wrong color.
describe('oklchToHex hue units (F1348)', () => {
  const half = oklchToHex('oklch(0.7 0.15 180)');

  it.each(['180deg', '0.5turn', '3.14159rad', '200grad', '180DEG'])(
    'reads %s as the same 180° hue',
    (hue) => {
      expect(oklchToHex(`oklch(0.7 0.15 ${hue})`)).toBe(half);
    },
  );

  it('rejects an unknown angle unit like core does', () => {
    expect(oklchToHex('oklch(0.7 0.15 180foo)')).toBeNull();
  });
});
