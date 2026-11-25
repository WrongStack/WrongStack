import { describe, expect, it } from 'vitest';
import { gitConfigEnv } from '../src/git-isolation.js';

describe('gitConfigEnv MAX_SAFE_INTEGER overflow guard', () => {
  it('resets index when base GIT_CONFIG_COUNT would overflow MAX_SAFE_INTEGER', () => {
    const env = gitConfigEnv(
      [
        ['core.fsmonitor', 'false'],
        ['filter.x.clean', ''],
        ['filter.y.clean', ''],
      ],
      { GIT_CONFIG_COUNT: String(Number.MAX_SAFE_INTEGER) },
    );
    const keys = Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_'));
    expect(keys).toHaveLength(3);
    expect(env['GIT_CONFIG_COUNT']).toBe('3');
  });
});
