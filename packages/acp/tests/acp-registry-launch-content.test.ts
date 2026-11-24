import { describe, expect, it } from 'vitest';
import { mapRegistryEntry } from '../src/registry/acp-registry-fetch.js';

describe('ACP registry child-process content boundary', () => {
  it('rejects NUL in a launcher package', () => {
    expect(
      mapRegistryEntry({
        id: 'bad',
        distribution: { npx: { package: 'demo\0evil' } },
      }),
    ).toBeNull();
  });

  it('rejects NUL in a launcher argument', () => {
    expect(
      mapRegistryEntry({
        id: 'bad',
        distribution: { npx: { package: 'demo', args: ['--mode\0evil'] } },
      }),
    ).toBeNull();
  });

  it.each([[{ 'BAD\0KEY': 'value' }], [{ 'BAD=KEY': 'value' }], [{ TOKEN: 'bad\0value' }]])(
    'rejects an invalid launcher environment',
    (env) => {
      expect(
        mapRegistryEntry({
          id: 'bad',
          distribution: { npx: { package: 'demo', env } },
        }),
      ).toBeNull();
    },
  );
});
