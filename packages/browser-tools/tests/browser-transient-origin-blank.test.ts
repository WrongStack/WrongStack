import { describe, expect, it } from 'vitest';
import { browserPrivateOrigins, withTransientPrivateOrigin } from '../src/policy.js';

describe('withTransientPrivateOrigin validation', () => {
  it('rejects blank origins instead of inserting empty strings into the allowlist', async () => {
    const root = `${process.cwd()}/.temp_files/f2322-test-root`;
    await expect(withTransientPrivateOrigin(root, '   ', async () => {})).rejects.toThrow(
      /Expected one HTTP\(S\) origin/,
    );

    let saw = false;
    await withTransientPrivateOrigin(root, 'http://localhost:4123', async () => {
      saw = browserPrivateOrigins(root).includes('http://localhost:4123');
    });
    expect(saw).toBe(true);
  });
});
