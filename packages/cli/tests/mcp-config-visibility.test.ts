/**
 * Regression test: `--mcp-config` servers started in a default terminal session
 * (`tokenSavingMode: 'auto'` -> `lazyMode: true`, `systemPromptVariant: 'quick'`)
 * must register their tools in `ToolRegistry`, expose them to `listForProvider()`,
 * and enable `mcp:<server>` in `sessionToolCatalog` so `tool_search`/`tool_use`
 * and direct provider surfaces can see them.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { sessionToolCatalog, setSessionToolGroup } from '@wrongstack/core/agent';
import { ToolRegistry } from '@wrongstack/core/registry';
import { MCPRegistry } from '@wrongstack/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupLifecycleAndPlugins } from '../src/wiring/lifecycle-plugins.js';

vi.mock('@wrongstack/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/coordination')>()),
  getSharedProjectMailbox: vi.fn().mockReturnValue({}),
}));

vi.mock('../src/wiring/pipeline.js', () => ({
  setupCompaction: vi.fn().mockResolvedValue({
    effectiveMaxContext: 128000,
    autoCompactor: undefined,
  }),
  createAgent: vi.fn().mockReturnValue({
    extensions: { register: vi.fn() },
  }),
}));

vi.mock('../src/wiring/plugins.js', () => ({
  setupPlugins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/wiring/design-studio.js', () => ({
  installDesignStudio: vi.fn(),
}));

const log: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => log,
} as never as Logger;

const SERVER = `'use strict';
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'agora', version: '1.0.0' },
    } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'workspace_status', description: 'Workspace status', inputSchema: { type: 'object', properties: {} } },
      { name: 'agents_list', description: 'List agents', inputSchema: { type: 'object', properties: {} } },
    ] } });
  } else {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

describe('--mcp-config tool visibility', () => {
  const dirs: string[] = [];
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('registers, exposes, and enables catalog visibility when started with activate + exposeToProvider', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-cfg-vis-'));
    dirs.push(dir);
    const script = path.join(dir, 'agora-mesh.cjs');
    writeFileSync(script, SERVER);

    const toolRegistry = new ToolRegistry();
    toolRegistry.setProviderToolNames(['read', 'tool_search', 'tool_use']);

    const registry = new MCPRegistry({
      toolRegistry,
      events: new EventBus(),
      log,
      lazyMode: true,
      cacheDir: path.join(dir, 'cache'),
      cwd: dir,
    });
    stops.push(() => registry.stopAll());

    await registry.start(
      {
        name: 'agora',
        transport: 'stdio',
        command: process.execPath,
        args: [script],
        enabled: true,
      },
      { activate: true, exposeToProvider: true },
    );
    await registry.whenStarted();

    expect(toolRegistry.list().map((t) => t.name)).toEqual(
      expect.arrayContaining(['mcp__agora__workspace_status', 'mcp__agora__agents_list']),
    );
    expect(toolRegistry.listForProvider().map((t) => t.name)).toEqual(
      expect.arrayContaining(['mcp__agora__workspace_status', 'mcp__agora__agents_list']),
    );

    const quickCtx = {
      meta: { systemPromptVariant: 'quick' },
      projectRoot: dir,
      eventSessionId: () => 'sess-1',
    };
    setSessionToolGroup(quickCtx, 'mcp:agora', 'on');
    expect(sessionToolCatalog(quickCtx, toolRegistry.list()).map((t) => t.name)).toEqual(
      expect.arrayContaining(['mcp__agora__workspace_status', 'mcp__agora__agents_list']),
    );
  }, 30_000);

  it('activates --mcp-config servers and enables mcp:<server> in quick mode during lifecycle setup', async () => {
    const mockStart = vi.spyOn(MCPRegistry.prototype, 'start').mockResolvedValue(undefined);
    try {
      const context = {
        provider: { capabilities: {} },
        meta: { systemPromptVariant: 'quick', projectRoot: 'D:/test' },
        projectRoot: 'D:/test',
        eventSessionId: () => 'test-session',
        session: { id: 'test-session' },
      };
      await setupLifecycleAndPlugins({
        flags: {
          'mcp-config': JSON.stringify({
            mcpServers: {
              agora: { command: 'agora', args: ['mesh', 'stdio'] },
            },
          }),
        },
        config: {
          features: { mcp: true, tokenSavingMode: 'auto' },
          mcpServers: {},
        },
        container: {
          bind: vi.fn(),
          resolve: vi.fn().mockReturnValue({ use: vi.fn(), loadShellHooks: vi.fn() }),
        },
        pipelines: {
          userInput: { use: vi.fn() },
          response: { use: vi.fn() },
          executeTurn: { use: vi.fn() },
          toolCall: { use: vi.fn() },
        },
        logger: log,
        session: { id: 'test-session' },
        sessionBridge: {},
        events: { emit: vi.fn(), on: vi.fn() },
        modelsRegistry: {},
        context,
        provider: { capabilities: {} },
        modelCapabilitiesRef: { current: undefined },
        reader: {},
        wpaths: {
          projectDir: 'D:/test',
          projectRoot: 'D:/test',
          cacheDir: 'D:/test/cache',
          profileConfig: vi.fn().mockReturnValue('D:/test/profile.json'),
        },
        toolRegistry: { register: vi.fn(), unregister: vi.fn() },
        providerRegistry: {},
        configStore: { get: vi.fn().mockReturnValue({}), watch: vi.fn() },
        eventWiring: { setEffectiveMaxContext: vi.fn() },
        healthRegistry: undefined,
        skillLoader: {},
        promptLoader: {},
        vault: { getSecret: vi.fn(), setSecret: vi.fn() },
        metricsSink: { gauge: vi.fn(), incrementCounter: vi.fn(), recordLatency: vi.fn() },
        renderer: {},
        buildProviderForIdRuntime: vi.fn(),
      } as never);

      expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ name: 'agora' }), {
        activate: true,
        exposeToProvider: true,
      });

      const catalog = sessionToolCatalog(context as never, [
        { name: 'mcp__agora__workspace_status', mcpServerName: 'agora' } as never,
      ]);
      expect(catalog.map((t) => t.name)).toEqual(['mcp__agora__workspace_status']);
    } finally {
      mockStart.mockRestore();
    }
  });
});
