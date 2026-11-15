import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetProxyConfigForTests,
  applyProxyConfig,
  createProxyInstantApply,
  waitForProxyRoutingSettle,
} from '../../src/wiring/proxy-rewrite.js';

describe('waitForProxyRoutingSettle timeout clamping (F367)', () => {
  afterEach(() => {
    __resetProxyConfigForTests();
  });

  it('clamps timeoutMs above 32-bit signed max instead of resolving in 1ms', async () => {
    let rebuilt = false;
    applyProxyConfig({ enabled: true, active: true, url: 'http://127.0.0.1:8888' });
    const handle = createProxyInstantApply({
      getActiveProviderId: () => 'openai',
      getRawBaseUrl: () => 'https://api.openai.com/v1',
      rebuildProvider: async () => {
        await new Promise((r) => setTimeout(r, 40));
        rebuilt = true;
      },
      logger: { info: () => {}, warn: () => {} },
    });

    try {
      applyProxyConfig({ enabled: false, active: false, url: '' });
      await waitForProxyRoutingSettle(3_000_000_000);
      expect(rebuilt).toBe(true);
    } finally {
      handle.dispose();
    }
  });
});
