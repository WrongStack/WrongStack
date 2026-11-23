/**
 * `provider_manage` baseUrl reset vs the VULN-006 `envVars: []` sentinel.
 *
 * A reset to the vendor default (`baseUrl: ''`) must not persist the sentinel:
 * there is no new endpoint to protect, and the catalog preset is the vendor's
 * own credential. A NEW custom endpoint must still keep the sentinel so the
 * old credential cannot follow to another host.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FallbackManageToolOptions } from '../../src/management/fallback-manage-tool-options.js';
import {
  createFallbackManageTools,
  PROVIDER_MANAGE_TOOL_NAME,
} from '../../src/management/fallback-manage-tools.js';

function makeOpts(): FallbackManageToolOptions {
  const config: Record<string, unknown> = {
    provider: 'test-provider',
    providers: {
      'test-provider': {
        type: 'openai',
        baseUrl: 'https://api.openai.com',
        activeKey: 'default',
        apiKeys: [{ label: 'default', apiKey: 'sk-real-key' }],
        envVars: ['TEST_PROVIDER_API_KEY'],
      },
    },
  };
  return {
    getConfig: () => config as never,
    updateConfig: vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      mutate(config);
    }),
  };
}

function providerEntry(opts: FallbackManageToolOptions): Record<string, unknown> {
  const cfg = opts.getConfig() as unknown as {
    providers: Record<string, Record<string, unknown>>;
  };
  return cfg.providers['test-provider']!;
}

function providerManageTool(opts: FallbackManageToolOptions) {
  const tool = createFallbackManageTools(opts).find((t) => t.name === PROVIDER_MANAGE_TOOL_NAME);
  if (!tool) throw new Error('provider_manage tool missing from factory output');
  return tool;
}

async function configure(
  opts: FallbackManageToolOptions,
  input: Record<string, unknown>,
): Promise<{ status: string; message: string }> {
  const tool = providerManageTool(opts);
  return (await tool.execute(input, {} as never, { signal: AbortSignal.timeout(5_000) })) as {
    status: string;
    message: string;
  };
}

describe('provider_manage baseUrl reset credential coupling', () => {
  it('re-arms the catalog preset key when the base URL is reset to the vendor default', async () => {
    const opts = makeOpts();
    const result = await configure(opts, {
      action: 'configure',
      provider: 'test-provider',
      baseUrl: '',
    });
    expect(result.status).toBe('ok');
    const entry = providerEntry(opts);
    expect(entry['baseUrl']).toBeUndefined();
    // No sentinel: the resolver falls back to the catalog preset for the
    // vendor endpoint we just returned to.
    expect(entry['envVars']).toBeUndefined();
    // The stored key still belongs to the old endpoint and must not follow.
    expect(entry['apiKeys']).toBeUndefined();
    expect(entry['activeKey']).toBeUndefined();
  });

  it('keeps the envVars sentinel for a new custom endpoint', async () => {
    const opts = makeOpts();
    const result = await configure(opts, {
      action: 'configure',
      provider: 'test-provider',
      baseUrl: 'https://other.example/v1',
    });
    expect(result.status).toBe('ok');
    const entry = providerEntry(opts);
    expect(entry['baseUrl']).toBe('https://other.example/v1');
    // Present-but-empty suppresses the catalog preset fallback: the old
    // credential must not follow to a different host.
    expect(entry['envVars']).toEqual([]);
    expect(entry['apiKeys']).toBeUndefined();
    expect(entry['activeKey']).toBeUndefined();
  });
});
