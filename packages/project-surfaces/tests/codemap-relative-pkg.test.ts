import { describe, expect, it } from 'vitest';
import { packageForFile } from '../src/atlas/CodeMapActivityHelpers';

describe('packageForFile relative path support', () => {
  it('resolves package and app labels for both relative and absolute paths', () => {
    expect(packageForFile('packages/core/src/index.ts')).toBe('@wrongstack/core');
    expect(packageForFile('/repo/packages/core/src/index.ts')).toBe('@wrongstack/core');
    expect(packageForFile('apps/web/src/main.ts')).toBe('app:web');
    expect(packageForFile('/repo/apps/web/src/main.ts')).toBe('app:web');
  });
});
