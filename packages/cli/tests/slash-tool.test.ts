import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DefaultConfigStore,
  ToolRegistry,
  type Config,
  type Context,
  type Tool,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildToolCommand } from '../src/slash-commands/tool.js';

let tmp: string;

const fullDescription =
  'Read a file from disk and return its contents with optional line ranges. Use this for inspecting source code, configuration files, documentation, and generated output before making edits.';

const baseConfig: Config = {
  version: 1,
  provider: 'anthropic',
  model: 'anthropic-test-model',
  context: {
    warnThreshold: 0.6,
    softThreshold: 0.75,
    hardThreshold: 0.9,
    preserveK: 10,
    eliseThreshold: 2000,
  },
  tools: {
    defaultExecutionStrategy: 'smart',
    maxIterations: 100,
    iterationTimeoutMs: 300_000,
    sessionTimeoutMs: 1_800_000,
    perIterationOutputCapBytes: 100_000,
    descriptionMode: {},
  },
  log: { level: 'info' },
  features: {
    mcp: true,
    plugins: true,
    memory: true,
    modelsRegistry: true,
    skills: true,
  },
};

function makeTool(): Tool {
  return {
    name: 'read',
    description: fullDescription,
    usageHint: `${fullDescription} Prefer narrow line ranges.`,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    async execute() {
      return '';
    },
  };
}

function makeCommand() {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(makeTool(), '@wrongstack/tools');
  const configStore = new DefaultConfigStore(baseConfig);
  const globalConfig = path.join(tmp, 'config.json');
  const command = buildToolCommand({
    toolRegistry,
    configStore,
    paths: {
      globalConfig,
      inProjectConfig: path.join(tmp, 'project', '.wrongstack', 'config.json'),
    },
  } as never);
  return { command, toolRegistry, configStore, globalConfig };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-tool-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('buildToolCommand', () => {
  it('persists and applies a simple tool description mode', async () => {
    const { command, toolRegistry, configStore, globalConfig } = makeCommand();

    const res = await command.run('read simple', {} as Context);

    expect(res?.message).toContain('read');
    expect(configStore.get().tools.descriptionMode?.read).toBe('simple');
    expect(toolRegistry.getDescriptionMode('read')).toBe('simple');
    expect(toolRegistry.get('read')?.description.length).toBeLessThan(fullDescription.length);

    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.descriptionMode?.read).toBe('simple');
    expect(saved.tools.maxIterations).toBe(100);
  });

  it('extend removes the override and restores the full description', async () => {
    const { command, toolRegistry, configStore, globalConfig } = makeCommand();

    await command.run('read simple', {} as Context);
    await command.run('read extend', {} as Context);

    expect(configStore.get().tools.descriptionMode?.read).toBeUndefined();
    expect(toolRegistry.getDescriptionMode('read')).toBe('extend');
    expect(toolRegistry.get('read')?.description).toBe(fullDescription);

    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.descriptionMode?.read).toBeUndefined();
    expect(saved.tools.maxIterations).toBe(100);
  });

  it('shows usage for invalid modes', async () => {
    const { command } = makeCommand();

    const res = await command.run('read tiny', {} as Context);

    expect(res?.message).toContain('/tool read [desc|result] simple|extend');
  });

  it('legacy `/tool <name> simple` sets BOTH description and result axes', async () => {
    const { command, toolRegistry, configStore, globalConfig } = makeCommand();

    const res = await command.run('read simple', {} as Context);

    // Both axes land in config.
    expect(configStore.get().tools.descriptionMode?.read).toBe('simple');
    expect(configStore.get().tools.resultRenderMode?.read).toBe('simple');
    // Both axes applied in-memory via the registry.
    expect(toolRegistry.getDescriptionMode('read')).toBe('simple');
    // Both axes persisted to disk.
    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.descriptionMode?.read).toBe('simple');
    expect(saved.tools.resultRenderMode?.read).toBe('simple');
    expect(res?.message).toContain('desc:simple');
    expect(res?.message).toContain('result:simple');
  });

  it('`/tool <name> desc simple` only changes the description axis', async () => {
    const { command, toolRegistry, configStore, globalConfig } = makeCommand();

    const res = await command.run('read desc simple', {} as Context);

    expect(configStore.get().tools.descriptionMode?.read).toBe('simple');
    // The result axis MUST stay at the default (no entry in the map).
    expect(configStore.get().tools.resultRenderMode?.read).toBeUndefined();
    expect(toolRegistry.getDescriptionMode('read')).toBe('simple');
    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.descriptionMode?.read).toBe('simple');
    expect(saved.tools.resultRenderMode?.read).toBeUndefined();
    expect(res?.message).toContain('desc:simple');
    expect(res?.message).not.toContain('result:');
  });

  it('`/tool <name> result simple` only changes the result axis', async () => {
    const { command, configStore, globalConfig } = makeCommand();

    const res = await command.run('read result simple', {} as Context);

    expect(configStore.get().tools.resultRenderMode?.read).toBe('simple');
    expect(configStore.get().tools.descriptionMode?.read).toBeUndefined();
    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.resultRenderMode?.read).toBe('simple');
    expect(saved.tools.descriptionMode?.read).toBeUndefined();
    expect(res?.message).toContain('result:simple');
    expect(res?.message).not.toContain('desc:');
  });

  it('desc and result toggles are independent — one does not wipe the other', async () => {
    const { command, configStore } = makeCommand();

    await command.run('read desc simple', {} as Context);
    await command.run('read result simple', {} as Context);

    expect(configStore.get().tools.descriptionMode?.read).toBe('simple');
    expect(configStore.get().tools.resultRenderMode?.read).toBe('simple');

    // Now flip just one axis back. The other must survive.
    await command.run('read desc extend', {} as Context);

    expect(configStore.get().tools.descriptionMode?.read).toBeUndefined();
    expect(configStore.get().tools.resultRenderMode?.read).toBe('simple');
  });

  it('legacy `/tool <name> extend` resets both axes at once', async () => {
    const { command, configStore, globalConfig } = makeCommand();

    await command.run('read simple', {} as Context); // both → simple
    const res = await command.run('read extend', {} as Context); // both → cleared

    expect(configStore.get().tools.descriptionMode?.read).toBeUndefined();
    expect(configStore.get().tools.resultRenderMode?.read).toBeUndefined();
    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.descriptionMode?.read).toBeUndefined();
    expect(saved.tools.resultRenderMode?.read).toBeUndefined();
    expect(res?.message).toContain('desc:extend');
    expect(res?.message).toContain('result:extend');
  });

  it('`/tool <name> result extend` only resets the result axis', async () => {
    const { command, configStore } = makeCommand();

    await command.run('read simple', {} as Context); // both → simple
    const res = await command.run('read result extend', {} as Context);

    // Desc stays simple, result cleared.
    expect(configStore.get().tools.descriptionMode?.read).toBe('simple');
    expect(configStore.get().tools.resultRenderMode?.read).toBeUndefined();
    expect(res?.message).toContain('result:extend');
    expect(res?.message).not.toContain('desc:');
  });
});
