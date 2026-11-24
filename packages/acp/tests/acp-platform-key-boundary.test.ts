import { expect, it } from 'vitest';
import { currentPlatformKey } from '../src/registry/acp-registry-fetch.js';

it('does not map unsupported Node platforms to Linux registry artifacts', () => {
  expect(currentPlatformKey('freebsd', 'x64')).toBe('freebsd-x86_64');
  expect(currentPlatformKey('sunos', 'x64')).toBe('sunos-x86_64');
});
