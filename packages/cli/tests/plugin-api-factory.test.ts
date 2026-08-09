import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { Container, EventBus } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { Config } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import createApi from '../src/plugin-api-factory.js';

describe('plugin-api-factory', () => {
  it('wires DefaultPluginAPI with ownerName', () => {
    const api = createApi('my-plugin', {
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: { providers: {}, log: { level: 'error' } } as never as Config,
      log: new DefaultLogger({ level: 'error' }),
    });
    expect(api).toBeDefined();
    expect(api.tools).toBeDefined();
    expect(api.providers).toBeDefined();
    expect(api.mcp).toBeDefined();
    expect(typeof api.tools.register).toBe('function');
  });
});
