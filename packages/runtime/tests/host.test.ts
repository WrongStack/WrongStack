import { ExtensionRegistry } from '@wrongstack/core/extension';
import { EventBus } from '@wrongstack/core/kernel';
import { ProviderRegistry, SlashCommandRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { Provider, Tool } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  applyWrongStackPack,
  applyWrongStackPacks,
  createRuntimeHostFromParts,
  type WrongStackPack,
} from '../src/index.js';

const noopProvider: Provider = {
  id: 'noop',
  capabilities: {
    streaming: false,
    tools: false,
    vision: false,
    reasoning: false,
  },
  async complete() {
    return {
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: 'noop',
    };
  },
  async *stream() {
    yield {
      type: 'response',
      response: {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        model: 'noop',
      },
    };
  },
};

const noopTool: Tool<Record<string, never>, string> = {
  name: 'noop',
  description: 'No-op tool for host tests.',
  inputSchema: { type: 'object', properties: {} },
  permission: 'auto',
  mutating: false,
  async execute() {
    return 'ok';
  },
};

function hostParts() {
  const tools = new ToolRegistry();
  const providers = new ProviderRegistry();
  const slashCommands = new SlashCommandRegistry();
  const extensions = new ExtensionRegistry();
  return {
    tools,
    providers,
    slashCommands,
    extensions,
    events: new EventBus(),
  };
}

describe('runtime host composition', () => {
  it('creates a host facade from already-wired runtime parts', async () => {
    let shutdownCalled = false;
    const parts = hostParts();
    const host = createRuntimeHostFromParts({
      ...parts,
      agent: {} as never,
      context: {} as never,
      session: { id: 's1', append: async () => undefined } as never,
      shutdown: () => {
        shutdownCalled = true;
      },
    });

    await host.shutdown();

    expect(host.tools).toBe(parts.tools);
    expect(host.providers).toBe(parts.providers);
    expect(host.slashCommands).toBe(parts.slashCommands);
    expect(shutdownCalled).toBe(true);
  });

  it('applies tools, providers, slash commands, and extensions from a pack', async () => {
    const host = hostParts();
    const pack: WrongStackPack = {
      name: 'test-pack',
      tools: [noopTool],
      providers: [
        {
          type: 'noop',
          family: 'openai-compatible',
          create: () => noopProvider,
        },
      ],
      slashCommands: [
        {
          name: 'hello',
          description: 'Say hello.',
          async run() {
            return { message: 'hello' };
          },
        },
      ],
      extensions: [{ name: 'test-extension' }],
    };

    const applied = await applyWrongStackPack(host, pack);

    expect(applied.owner).toBe('test-pack');
    expect(host.tools.get('noop')).toBe(noopTool);
    expect(host.providers.has('noop')).toBe(true);
    expect(host.slashCommands.get('test-pack:hello')).toBeDefined();
    expect(host.extensions.list()).toEqual(['test-extension']);

    await applied.teardown();

    expect(host.extensions.list()).toEqual([]);
    expect(host.tools.get('noop')).toBeUndefined();
    expect(host.providers.has('noop')).toBe(false);
    expect(host.slashCommands.get('test-pack:hello')).toBeUndefined();
  });

  it('rolls back previously applied packs when a later pack fails', async () => {
    const host = hostParts();
    const first: WrongStackPack = {
      name: 'first',
      extensions: [{ name: 'first-extension' }],
    };
    const second: WrongStackPack = {
      name: 'second',
      setup() {
        throw new Error('boom');
      },
    };

    await expect(applyWrongStackPacks(host, [first, second])).rejects.toThrow('no PluginAPI');
    expect(host.extensions.list()).toEqual([]);
  });

  it('emits a warning when a pack teardown fails during rollback', async () => {
    const host = hostParts();
    const warnings: string[] = [];
    const originalEmit = process.emitWarning;
    // process.emitWarning has multiple overload signatures — capture as any.
    process.emitWarning = ((msg: string) =>
      warnings.push(String(msg))) as typeof process.emitWarning;
    try {
      const flaky: WrongStackPack = {
        name: 'flaky',
        extensions: [{ name: 'flaky-ext' }],
        async teardown() {
          throw new Error('teardown-explode');
        },
      };
      const breaker: WrongStackPack = {
        name: 'breaker',
        setup() {
          throw new Error('setup-fail');
        },
      };
      const api = {} as never;
      await expect(applyWrongStackPacks(host, [flaky, breaker], { api })).rejects.toThrow();
      expect(warnings.some((w) => w.includes('teardown-explode'))).toBe(true);
    } finally {
      process.emitWarning = originalEmit;
    }
  });

  it('invokes pack.teardown(api) when teardown is defined and api is provided', async () => {
    const host = hostParts();
    let teardownCalledWith: unknown;
    const api = { token: 'api-instance' } as never;
    const pack: WrongStackPack = {
      name: 'with-teardown',
      async setup(received) {
        // setup is required when teardown is present
        expect(received).toBe(api);
      },
      async teardown(received) {
        teardownCalledWith = received;
      },
    };
    const applied = await applyWrongStackPack(host, pack, { api });
    await applied.teardown();
    expect(teardownCalledWith).toBe(api);
  });

  it('teardown is idempotent — calling it twice does not throw or re-register', async () => {
    const host = hostParts();
    const pack: WrongStackPack = {
      name: 'idempotent-pack',
      tools: [noopTool],
      providers: [{ type: 'noop', family: 'openai-compatible', create: () => noopProvider }],
      slashCommands: [
        {
          name: 'hi',
          description: 'Hi.',
          async run() {
            return { message: 'hi' };
          },
        },
      ],
      extensions: [{ name: 'idempotent-ext' }],
    };

    const applied = await applyWrongStackPack(host, pack);
    await applied.teardown();
    await applied.teardown();

    expect(host.extensions.list()).toEqual([]);
    expect(host.tools.get('noop')).toBeUndefined();
    expect(host.providers.has('noop')).toBe(false);
    expect(host.slashCommands.get('idempotent-pack:hi')).toBeUndefined();
  });

  it('rolls back and then allows a clean teardown after a setup error', async () => {
    const host = hostParts();
    const first: WrongStackPack = {
      name: 'first',
      tools: [noopTool],
      extensions: [{ name: 'first-ext' }],
    };
    const second: WrongStackPack = {
      name: 'second',
      setup() {
        throw new Error('setup-boom');
      },
    };

    await expect(applyWrongStackPacks(host, [first, second], { api: {} as never })).rejects.toThrow(
      'setup-boom',
    );

    expect(host.extensions.list()).toEqual([]);
    expect(host.tools.get('noop')).toBeUndefined();
  });

  it('rolls back packs in reverse registration order during error rollback', async () => {
    const host = hostParts();
    const order: string[] = [];
    const first: WrongStackPack = {
      name: 'first',
      async setup() {
        order.push('first-setup');
      },
      async teardown() {
        order.push('first-teardown');
      },
    };
    const second: WrongStackPack = {
      name: 'second',
      async setup() {
        order.push('second-setup');
      },
      async teardown() {
        order.push('second-teardown');
      },
    };
    const third: WrongStackPack = {
      name: 'third',
      setup() {
        throw new Error('third-boom');
      },
    };

    await expect(
      applyWrongStackPacks(host, [first, second, third], { api: {} as never }),
    ).rejects.toThrow('third-boom');
    expect(order).toEqual(['first-setup', 'second-setup', 'second-teardown', 'first-teardown']);
  });

  it('rolls back every resource registered by the pack whose setup fails', async () => {
    const host = hostParts();
    const pack: WrongStackPack = {
      name: 'transactional',
      tools: [noopTool],
      providers: [{ type: 'noop', family: 'openai-compatible', create: () => noopProvider }],
      slashCommands: [
        {
          name: 'hello',
          description: 'Hello',
          async run() {
            return { message: 'hello' };
          },
        },
      ],
      extensions: [{ name: 'transactional-extension' }],
      setup() {
        throw new Error('setup failed');
      },
    };

    await expect(applyWrongStackPack(host, pack, { api: {} as never })).rejects.toThrow(
      'setup failed',
    );
    expect(host.tools.get('noop')).toBeUndefined();
    expect(host.providers.has('noop')).toBe(false);
    expect(host.slashCommands.get('transactional:hello')).toBeUndefined();
    expect(host.extensions.list()).toEqual([]);
  });

  it('requires PluginAPI only when a declared teardown actually runs', async () => {
    const applied = await applyWrongStackPack(hostParts(), {
      name: 'teardown-api',
      teardown() {},
    });

    await expect(applied.teardown()).rejects.toThrow('no PluginAPI');
  });

  it('stringifies a non-Error rollback teardown failure', async () => {
    const host = hostParts();
    const warnings: string[] = [];
    const originalEmit = process.emitWarning;
    process.emitWarning = ((message: string) => {
      warnings.push(String(message));
    }) as typeof process.emitWarning;
    try {
      await expect(
        applyWrongStackPacks(
          host,
          [
            {
              name: 'string-failure',
              teardown() {
                throw 'plain teardown failure';
              },
            },
            {
              name: 'breaker',
              setup() {
                throw new Error('break');
              },
            },
          ],
          { api: {} as never },
        ),
      ).rejects.toThrow('break');
    } finally {
      process.emitWarning = originalEmit;
    }
    expect(warnings).toContainEqual(expect.stringContaining('plain teardown failure'));
  });

  it('registers core slash commands without an owner prefix', async () => {
    const host = hostParts();
    const applied = await applyWrongStackPack(
      host,
      {
        name: 'core-pack',
        slashCommands: [
          {
            name: 'core-command',
            description: 'Core',
            async run() {
              return { message: 'core' };
            },
          },
        ],
      },
      { owner: 'core' },
    );

    expect(host.slashCommands.get('core-command')).toBeDefined();
    await applied.teardown();
    expect(host.slashCommands.get('core-command')).toBeUndefined();
  });

  it('returns every successfully applied pack', async () => {
    const applied = await applyWrongStackPacks(hostParts(), [
      { name: 'first-success' },
      { name: 'second-success' },
    ]);

    expect(applied.map((entry) => entry.owner)).toEqual(['first-success', 'second-success']);
  });
});
