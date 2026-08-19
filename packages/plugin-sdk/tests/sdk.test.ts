import { describe, expect, it } from 'vitest';
import { definePlugin, KERNEL_API_VERSION } from '../src/index.js';
import { BoundedMap, releaseHandles, safePath } from '../src/runtime/index.js';

describe('@wrongstack/plugin-sdk surface', () => {
  it('exposes the kernel contract version', () => {
    expect(KERNEL_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('definePlugin injects the apiVersion and preserves metadata', () => {
    const plugin = definePlugin(
      {
        name: 'wstack-plugin-sdk-test',
        version: '1.0.0',
        capabilities: { tools: true },
        defaultConfig: { greeting: 'hi' },
      },
      (api, options) => {
        expect(api).toBeDefined();
        expect(options.greeting).toBe('hi');
      },
    );
    expect(plugin.name).toBe('wstack-plugin-sdk-test');
    expect(plugin.apiVersion).toBe(KERNEL_API_VERSION);
    expect(plugin.capabilities).toEqual({ tools: true });
    expect(typeof plugin.setup).toBe('function');
  });

  it('ships the runtime helper barrel', () => {
    expect(typeof BoundedMap).toBe('function');
    expect(typeof releaseHandles).toBe('function');
    expect(typeof safePath).toBe('function');
    const map = new BoundedMap<string, number>({ max: 2 });
    map.set('a', 1);
    expect(map.get('a')).toBe(1);
  });
});
