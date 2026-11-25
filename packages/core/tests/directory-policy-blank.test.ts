import { describe, expect, it } from 'vitest';
import { validateDirectoryPolicy } from '../src/security/directory-policy-schema.js';

describe('validateDirectoryPolicy (F2201)', () => {
  it('rejects whitespace-only directory and tool/provider list entries', () => {
    const bad = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [{ directory: '   ', denyTools: ['   '] }],
    });
    expect(bad.ok).toBe(false);

    const good = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [{ directory: 'src/**', denyTools: ['bash'] }],
    });
    expect(good.ok).toBe(true);
  });
});
