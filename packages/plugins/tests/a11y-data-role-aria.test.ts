import { describe, expect, it } from 'vitest';
import {
  hasAccessibleName,
  hasDescriptionRef,
  hasMeaningfulAlt,
} from '../src/accessibility-auditor/a11y-heuristics.js';

describe('a11y-heuristics (F2207)', () => {
  it('does not treat data-role / data-aria-* attributes as real ARIA/role attributes', () => {
    expect(hasMeaningfulAlt('<img alt="" data-role="presentation">')).toBe(false);
    expect(hasAccessibleName('<button data-aria-label="Submit"></button>')).toBe(false);
    expect(hasDescriptionRef('<input data-aria-describedby="hint">')).toBe(false);

    expect(hasMeaningfulAlt('<img alt="" role="presentation">')).toBe(true);
    expect(hasAccessibleName('<button aria-label="Submit"></button>')).toBe(true);
  });
});
