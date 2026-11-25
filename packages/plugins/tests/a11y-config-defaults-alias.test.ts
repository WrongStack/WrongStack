import { describe, expect, it } from 'vitest';
import { DEFAULTS, readConfig } from '../src/accessibility-auditor/a11y-config.js';

describe('readConfig (F2171)', () => {
  it('clones DEFAULTS.includeExtensions so caller mutations cannot corrupt defaults', () => {
    const before = [...DEFAULTS.includeExtensions];
    const c1 = readConfig(undefined);
    c1.includeExtensions.push('.svelte');
    const c2 = readConfig({ enabled: true });
    c2.includeExtensions.push('.astro');

    expect(DEFAULTS.includeExtensions).toEqual(before);
  });
});
