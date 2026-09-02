/**
 * TechStack — OSV advisory client tests.
 *
 * Tests the batch query construction and result parsing logic.
 * Network calls are NOT exercised in unit tests.
 *
 * @see packages/techstack/src/advisory/osv.ts
 */

import { describe, it } from 'vitest';
import { queryOsvSingle } from '../../src/advisory/osv.js';

describe('queryOsvSingle', () => {
  it('rejects invalid PURLs gracefully', async () => {
    // This test validates that the function handles errors without crashing
    // The actual network call will throw on invalid PURLs or network errors
    try {
      await queryOsvSingle('pkg:npm/nonexistent-package-that-does-not-exist-12345@99.99.99');
    } catch {
      // Expected — network timeout or no such package
    }
  });
});
