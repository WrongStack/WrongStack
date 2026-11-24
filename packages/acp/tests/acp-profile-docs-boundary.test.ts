import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERIC_ACP_PROFILE,
  resolveAcpClientProfile,
} from '../src/registry/acp-client-profiles.js';
import { mapRegistryEntry } from '../src/registry/acp-registry-fetch.js';

describe('ACP profile and registry metadata boundaries', () => {
  it('uses the generic profile for a whitespace-only role', () => {
    expect(resolveAcpClientProfile('   ')).toBe(DEFAULT_GENERIC_ACP_PROFILE);
  });

  it('ignores malformed repository metadata and keeps a valid website fallback', () => {
    expect(
      mapRegistryEntry({
        id: 'demo',
        repository: 42,
        website: 'https://site.test',
        distribution: { npx: { package: 'demo' } },
      } as never)?.docs,
    ).toBe('https://site.test');
  });
});
