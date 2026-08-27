/**
 * Integration tests for the `/tool autothin` slash command. The unit
 * tests in `tool-registry-thin.test.ts` cover the registry-level
 * mechanics; this file exercises the full command surface (status,
 * candidates, apply, undo, config) end-to-end with a fresh in-memory
 * tool registry + config store on every test.
 */

import { EventBus } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import type {
  AutoThinConfig,
  Config,
  ConfigStore,
  Tool,
  ToolsConfig,
} from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/command-context.js';
import { buildToolCommand } from '../src/slash-commands/tool.js';

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: `${name} ok` }),
    permission: 'auto',
    category: 'test',
  };
}

class MemoryConfigStore implements ConfigStore {
  private config: Config;
  private listeners = new Set<(config: Config) => void>();

  constructor(seed: Partial<Config> = {}) {
    this.config = {
      version: 1,
      provider: 'test',
      model: 'test',
      maxConcurrent: 1,
      configScope: 'global',
      hints: true,
      debugStream: false,
      nextPrediction: false,
      fallbackAuto: true,
      yolo: false,
      session: { auditLevel: 'standard', sampling: { toolProgress: { sampleRate: 1 } } },
      context: { mode: 'balanced' as never, autoCompact: true, strategy: 'hybrid' as never },
      tools: {
        disabledTools: [],
        autoThin: { enabled: false, idleDays: 30, minInvocations: 3, applyOnBoot: false },
      } as never,
      log: { level: 'info' },
      ...seed,
    } as Config;
  }

  get(): Config {
    return this.config;
  }
  update(partial: Partial<Config>): void {
    this.config = { ...this.config, ...partial };
    for (const listener of this.listeners) listener(this.config);
  }
  subscribe(listener: (config: Config) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  watch(): () => void {
    return () => {};
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  readonly mutex = (async <T>(fn: () => Promise<T>) => fn()) as never;
}

function makeContext(
  registry: ToolRegistry,
  configStore: ConfigStore,
  events: EventBus,
  getChronicle?: () => never,
  getToolUsage?: () => never,
): SlashCommandContext {
  return {
    registry: { register: () => {}, get: () => undefined } as never,
    toolRegistry: registry,
    events,
    configStore,
    cwd: '/tmp',
    projectRoot: '/tmp',
    metricsStatus: { collectionEnabled: false, httpExporter: 'disabled' },
    onPanelOpen: { current: null },
    tokenCounter: { count: (t: string) => t.length } as never,
    renderer: { write: () => {}, writeError: () => {} } as never,
    reader: {} as never,
    ...(getChronicle ? { getChronicle } : {}),
    ...(getToolUsage ? { getToolUsage } : {}),
  } as unknown as SlashCommandContext;
}

const NO_TOOL_USAGE = () => new Map();

describe('/tool autothin', () => {
  let registry: ToolRegistry;
  let events: EventBus;
  let store: MemoryConfigStore;

  beforeEach(() => {
    registry = new ToolRegistry();
    events = new EventBus();
    registry.setEventBus(events);
    for (const name of ['read', 'bash', 'grep']) registry.register(makeTool(name));
    store = new MemoryConfigStore();
  });

  it('status shows default-off config + zero counts', async () => {
    const cmd = buildToolCommand(makeContext(registry, store, events));
    const out = await cmd.run!('autothin status');
    expect(out.message).toContain('enabled:');
    expect(out.message).toContain('off');
    expect(out.message).toContain('idleDays:');
    expect(out.message).toContain('30');
  });

  it('candidates refuses to run when auto-thinning is off', async () => {
    const cmd = buildToolCommand(makeContext(registry, store, events, undefined, NO_TOOL_USAGE));
    const out = await cmd.run!('autothin candidates');
    expect(out.message).toMatch(/off/i);
    expect(out.message).toContain('/settings autothin on');
  });

  it('candidates lists every registered tool when in-process bridge has only old entries', async () => {
    const now = Date.now();
    const day = 86_400_000;
    const bridge = new Map<
      string,
      {
        invocations: number;
        failures: number;
        durationMsTotal: number;
        lastInvokedAt: number;
        firstInvokedAt: number;
      }
    >([
      [
        'read',
        {
          invocations: 0,
          failures: 0,
          durationMsTotal: 0,
          lastInvokedAt: now - 60 * day,
          firstInvokedAt: now - 60 * day,
        },
      ],
      [
        'bash',
        {
          invocations: 0,
          failures: 0,
          durationMsTotal: 0,
          lastInvokedAt: now - 1 * day,
          firstInvokedAt: now - 1 * day,
        },
      ],
    ]);
    const toolUsage = () => bridge as never;
    store.update({
      tools: {
        ...(store.get().tools as ToolsConfig),
        autoThin: {
          enabled: true,
          idleDays: 30,
          minInvocations: 0,
          applyOnBoot: false,
        } as AutoThinConfig,
      } as ToolsConfig,
    });
    const cmd = buildToolCommand(makeContext(registry, store, events, undefined, toolUsage));
    const out = await cmd.run!('autothin candidates');
    expect(out.message).toContain('read');
    expect(out.message).not.toContain('bash');
  });

  it('apply disables only the candidate set + persists meta', async () => {
    const now = Date.now();
    const day = 86_400_000;
    const bridge = new Map<
      string,
      {
        invocations: number;
        failures: number;
        durationMsTotal: number;
        lastInvokedAt: number;
        firstInvokedAt: number;
      }
    >([
      [
        'read',
        {
          invocations: 0,
          failures: 0,
          durationMsTotal: 0,
          lastInvokedAt: now - 60 * day,
          firstInvokedAt: now - 60 * day,
        },
      ],
      [
        'bash',
        {
          invocations: 0,
          failures: 0,
          durationMsTotal: 0,
          lastInvokedAt: now - 1 * day,
          firstInvokedAt: now - 1 * day,
        },
      ],
    ]);
    store.update({
      tools: {
        ...(store.get().tools as ToolsConfig),
        autoThin: {
          enabled: true,
          idleDays: 30,
          minInvocations: 0,
          applyOnBoot: false,
        } as AutoThinConfig,
      } as ToolsConfig,
    });
    const cmd = buildToolCommand(
      makeContext(registry, store, events, undefined, () => bridge as never),
    );
    const out = await cmd.run!('autothin apply');
    expect(out.message).toContain('Thinned');
    expect(out.message).toContain('read');
    expect(registry.isDisabled('read')).toBe(true);
    expect(registry.isDisabled('bash')).toBe(false);
    expect(registry.disabledMeta('read')?.reason).toBe('auto-thinned');
  });

  it('undo re-enables only the auto-thinned subset, leaves user disables alone', async () => {
    registry.disable('bash', 'user');
    registry.thinUnderused(['read'], 'test');
    const cmd = buildToolCommand(makeContext(registry, store, events));
    const out = await cmd.run!('autothin undo');
    expect(out.message).toContain('Re-enabled');
    expect(out.message).toContain('read');
    expect(registry.isDisabled('bash')).toBe(true);
    expect(registry.isDisabled('read')).toBe(false);
  });

  it('config toggles enabled and idleDays', async () => {
    const cmd = buildToolCommand(makeContext(registry, store, events));
    await cmd.run!('autothin config enabled on');
    expect((store.get().tools as ToolsConfig).autoThin?.enabled).toBe(true);
    await cmd.run!('autothin config idleDays 14');
    expect((store.get().tools as ToolsConfig).autoThin?.idleDays).toBe(14);
    await cmd.run!('autothin config enabled off');
    expect((store.get().tools as ToolsConfig).autoThin?.enabled).toBe(false);
  });

  it('config rejects out-of-range numeric values', async () => {
    const cmd = buildToolCommand(makeContext(registry, store, events));
    const out = await cmd.run!('autothin config idleDays -1');
    expect(out.message).toContain('non-negative');
  });
});
