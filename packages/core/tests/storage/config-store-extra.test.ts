import { describe, expect, it } from 'vitest';
import { DefaultConfigStore } from '../../src/storage/config-store.js';
import type { Config } from '../../src/types/config.js';

// Covers stripEphemeralFields() — env-sourced fields are dropped on update so
// secrets derived from env vars never persist into the on-disk config.

const baseConfig: Config = {
  version: 1,
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  context: {
    warnThreshold: 0.7,
    softThreshold: 0.8,
    hardThreshold: 0.95,
    preserveK: 4,
    eliseThreshold: 0.5,
  },
  tools: {
    defaultExecutionStrategy: 'smart',
    maxIterations: 100,
    iterationTimeoutMs: 60_000,
    sessionTimeoutMs: 3_600_000,
    perIterationOutputCapBytes: 100_000,
  },
  log: { level: 'info' },
  features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
};

describe('DefaultConfigStore — stripEphemeralFields', () => {
  it('drops env-sourced fields (and the _envSource marker) on update', () => {
    const store = new DefaultConfigStore(structuredClone(baseConfig));
    const next = store.update({
      baseUrl: 'https://from-env.example',
      _envSource: new Set(['baseUrl']),
    } as Partial<Config>);
    expect((next as { baseUrl?: string }).baseUrl).toBeUndefined();
    expect((next as { _envSource?: unknown })._envSource).toBeUndefined();
  });

  it('keeps non-env fields on update', () => {
    const store = new DefaultConfigStore(structuredClone(baseConfig));
    const next = store.update({ model: 'claude-opus-4-8' });
    expect(next.model).toBe('claude-opus-4-8');
  });
});
