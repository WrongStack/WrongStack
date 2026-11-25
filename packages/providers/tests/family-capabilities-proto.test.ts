import type { WireFamily } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES_BY_FAMILY, capabilitiesForFamily } from '../src/family-capabilities.js';

describe('capabilitiesForFamily (F2168)', () => {
  it('falls back to unsupported for prototype property names', () => {
    const caps = capabilitiesForFamily('toString' as unknown as WireFamily);
    expect(caps).toEqual(CAPABILITIES_BY_FAMILY.unsupported);
  });
});
