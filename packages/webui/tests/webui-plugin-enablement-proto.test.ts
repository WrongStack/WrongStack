import { describe, expect, it } from 'vitest';
import { resolvePluginToggleStates } from '../src/lib/plugin-enablement';

describe('resolvePluginToggleStates prototype key guard (F2308)', () => {
  it('ignores inherited Object.prototype properties on localOverrides', () => {
    const states = resolvePluginToggleStates(['toString'], {});
    expect(states[0]?.localOverride).toBeUndefined();
    expect(states[0]?.resolved).toBe(true);
  });
});
