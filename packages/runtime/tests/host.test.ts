import { EventBus } from '@wrongstack/contracts/kernel';
import type { PluginAPI, Provider, Tool } from '@wrongstack/contracts/types';
import { ExtensionRegistry } from '@wrongstack/core/extension';
import { ProviderRegistry, SlashCommandRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';
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
    yield { type: 'message_start' as const, model: 'noop' };
    yield { type: 'content_block_start' as const, kind: 'text' as const };
    yield { type: 'text_delta' as const, text: 'ok' };
    yield { type: 'content_block_stop' as const, index: 0 };
    yield {
      type: 'message_stop' as const,
      stopReason: 'end_turn' as const,
      usage: { input: 0, output: 0 },
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

  it('shares host shutdown completion and runs cleanup only once', async () => {
    const gate = Promise.withResolvers<void>();
    const shutdown = vi.fn(() => gate.promise);
    const host = createRuntimeHostFromParts({
      ...hostParts(),
      agent: {} as never,
      context: {} as never,
      session: {} as never,
      shutdown,
    });
    const first = host.shutdown();
    const second = host.shutdown();
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    await host.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it.each(['throw', 'reject'] as const)(
    'retains a host shutdown %s without repeating cleanup',
    async (mode) => {
      const error = new Error('shutdown failed');
      const shutdown = vi.fn(() => {
        if (mode === 'throw') throw error;
        return Promise.reject(error);
      });
      const host = createRuntimeHostFromParts({
        ...hostParts(),
        agent: {} as never,
        context: {} as never,
        session: {} as never,
        shutdown,
      });
      await expect(host.shutdown()).rejects.toBe(error);
      await expect(host.shutdown()).rejects.toBe(error);
      expect(shutdown).toHaveBeenCalledTimes(1);
    },
  );

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

  it.each(['teardown', 'setup-failure'] as const)(
    'restores an existing provider after pack %s',
    async (exit) => {
      const host = hostParts();
      host.providers.register({
        type: 'noop',
        family: 'openai-compatible',
        create: () => noopProvider,
      });
      const replacement = { ...noopProvider, id: 'replacement' };
      const pack: WrongStackPack = {
        name: 'override',
        providers: [{ type: 'noop', family: 'openai-compatible', create: () => replacement }],
        setup() {
          expect(host.providers.create({ type: 'noop' })).toBe(replacement);
          if (exit === 'setup-failure') throw new Error('setup failed');
        },
      };
      if (exit === 'setup-failure') {
        await expect(applyWrongStackPack(host, pack, { api: {} as never })).rejects.toThrow(
          'setup failed',
        );
      } else {
        const applied = await applyWrongStackPack(host, pack, { api: {} as never });
        await applied.teardown();
      }
      expect(host.providers.create({ type: 'noop' })).toBe(noopProvider);
    },
  );

  it.each([true, false])(
    'restores nested providers when oldest-first teardown is %s',
    async (oldestFirst) => {
      const host = hostParts();
      host.providers.register({
        type: 'noop',
        family: 'openai-compatible',
        create: () => noopProvider,
      });
      const firstProvider = { ...noopProvider, id: 'first' };
      const secondProvider = { ...noopProvider, id: 'second' };
      const first = await applyWrongStackPack(host, {
        name: 'first',
        providers: [{ type: 'noop', family: 'openai-compatible', create: () => firstProvider }],
      });
      const second = await applyWrongStackPack(host, {
        name: 'second',
        providers: [{ type: 'noop', family: 'openai-compatible', create: () => secondProvider }],
      });
      try {
        await (oldestFirst ? first : second).teardown();
        expect(host.providers.create({ type: 'noop' })).toBe(
          oldestFirst ? secondProvider : firstProvider,
        );
      } finally {
        await first.teardown();
        await second.teardown();
      }
      expect(host.providers.create({ type: 'noop' })).toBe(noopProvider);
    },
  );

  it('preserves a provider registered independently after the pack', async () => {
    const host = hostParts();
    const applied = await applyWrongStackPack(host, {
      name: 'first',
      providers: [{ type: 'noop', family: 'openai-compatible', create: () => noopProvider }],
    });
    const replacement = { ...noopProvider, id: 'independent' };
    host.providers.register({
      type: 'noop',
      family: 'openai-compatible',
      create: () => replacement,
    });
    await applied.teardown();
    expect(host.providers.create({ type: 'noop' })).toBe(replacement);
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

  it('does not remove a reloaded pack when an old handle is torn down again', async () => {
    const host = hostParts();
    const pack: WrongStackPack = {
      name: 'reloadable',
      tools: [noopTool],
      providers: [{ type: 'noop', family: 'openai-compatible', create: () => noopProvider }],
      extensions: [{ name: 'reloadable-extension' }],
    };
    const first = await applyWrongStackPack(host, pack);
    await first.teardown();
    const second = await applyWrongStackPack(host, pack);
    try {
      await first.teardown();
      expect(host.tools.get('noop')).toBe(noopTool);
      expect(host.providers.has('noop')).toBe(true);
      expect(host.extensions.list()).toEqual(['reloadable-extension']);
    } finally {
      await second.teardown();
    }
  });

  it('shares concurrent teardown completion and invokes the hook only once', async () => {
    const gate = Promise.withResolvers<void>();
    const teardown = vi.fn(() => gate.promise);
    const applied = await applyWrongStackPack(
      hostParts(),
      { name: 'concurrent-close', teardown },
      { api: {} as never },
    );
    const first = applied.teardown();
    const second = applied.teardown();
    gate.resolve();
    await Promise.all([first, second]);
    await applied.teardown();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed teardown result without repeating partial cleanup', async () => {
    const error = new Error('cleanup failed');
    const teardown = vi.fn().mockRejectedValue(error);
    const applied = await applyWrongStackPack(
      hostParts(),
      { name: 'failed-close', teardown },
      { api: {} as never },
    );
    await expect(applied.teardown()).rejects.toBe(error);
    await expect(applied.teardown()).rejects.toBe(error);
    expect(teardown).toHaveBeenCalledTimes(1);
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

  it('tears down resources from a partially completed setup before rolling back declarations', async () => {
    const host = hostParts();
    const api = {} as never;
    const setupError = new Error('partial setup failed');
    let resourceActive = false;
    const teardown = vi.fn((received: PluginAPI) => {
      expect(received).toBe(api);
      // Teardown runs while declarative capabilities are still mounted.
      expect(host.tools.get('noop')).toBe(noopTool);
      resourceActive = false;
    });

    await expect(
      applyWrongStackPack(
        host,
        {
          name: 'partial-setup',
          tools: [noopTool],
          setup() {
            resourceActive = true;
            throw setupError;
          },
          teardown,
        },
        { api },
      ),
    ).rejects.toBe(setupError);

    expect(resourceActive).toBe(false);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(host.tools.get('noop')).toBeUndefined();
  });

  it('does not mask a setup failure when partial-setup teardown also fails', async () => {
    const host = hostParts();
    const setupError = new Error('mount failure');
    const originalEmit = process.emitWarning;
    const warnings: string[] = [];
    process.emitWarning = ((message: string) => {
      warnings.push(String(message));
    }) as typeof process.emitWarning;
    try {
      await expect(
        applyWrongStackPack(
          host,
          {
            name: 'double-failure',
            setup() {
              throw setupError;
            },
            teardown() {
              throw new Error('cleanup failure');
            },
          },
          { api: {} as never },
        ),
      ).rejects.toBe(setupError);
    } finally {
      process.emitWarning = originalEmit;
    }
    expect(warnings).toContainEqual(expect.stringContaining('cleanup failure'));
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
