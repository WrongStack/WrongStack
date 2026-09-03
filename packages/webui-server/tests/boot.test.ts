import { describe, it, expect, vi } from 'vitest';

const mockBootConfig = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/core/infrastructure', () => ({
  bootConfig: mockBootConfig,
}));

import { bootConfig, patchConfig } from '../src/server/boot.js';

describe('boot', () => {
  describe('bootConfig', () => {
    it('calls core bootConfig with WebUI label and returns result', async () => {
      const mockResult = {
        config: { yolo: false },
        vault: {} as any,
        globalConfigPath: '/tmp/config.json',
        projectRoot: '/tmp/project',
        wpaths: {} as any,
        logger: {} as any,
      };
      mockBootConfig.mockResolvedValue(mockResult);

      const result = await bootConfig();

      expect(mockBootConfig).toHaveBeenCalledWith({ appLabel: 'WebUI' });
      expect(result).toEqual(mockResult);
    });
  });

  describe('patchConfig', () => {
    it('returns a frozen merged config', () => {
      const config = { yolo: false, autonomy: { defaultMode: 'off' } };
      const patched = patchConfig(config as any, { yolo: true } as any);

      expect(patched.yolo).toBe(true);
      expect(patched.autonomy).toEqual({ defaultMode: 'off' });
      expect(Object.isFrozen(patched)).toBe(true);
    });

    it('does not mutate the original config', () => {
      const config = { yolo: false };
      const patched = patchConfig(config as any, { yolo: true } as any);

      expect(config.yolo).toBe(false);
      expect(patched.yolo).toBe(true);
    });

    // B-07: migrated from packages/webui/tests/server/boot.test.ts —
    // asserts the IDENTITY of the returned object (`patched !== base`).
    // The server's existing `'returns a frozen merged config'` covers the
    // merge + freeze contract but never asserts the result is a NEW object.
    // A refactor that switched from `Object.freeze({...base, ...patch})`
    // to `Object.freeze(base)` (after mutating `base`) would still pass
    // every server test and only fail here.
    it('returns a new object (does not freeze and reuse the input)', () => {
      const base = { provider: 'openai', model: 'gpt-5' } as any;
      const result = patchConfig(base, { model: 'gpt-5-mini' } as any);
      expect(result).not.toBe(base);
      expect(result.model).toBe('gpt-5-mini');
      expect(result.provider).toBe('openai');
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
