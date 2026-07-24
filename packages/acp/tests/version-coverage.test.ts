import { describe, expect, it } from 'vitest';
import { ACP_PACKAGE_VERSION, versionCoverage } from '../src/version.js';

describe('ACP package version coverage', () => {
  it('reads the published version and handles invalid or absent metadata', () => {
    expect(ACP_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionCoverage.readPackageVersion(() => ({ version: '' }))).toBe('dev');
    expect(versionCoverage.readPackageVersion(() => ({ version: 1 }))).toBe('dev');
    expect(
      versionCoverage.readPackageVersion(() => {
        throw new Error('missing package');
      }),
    ).toBe('dev');
  });
});
