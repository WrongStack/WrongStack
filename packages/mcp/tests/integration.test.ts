import { EventBus } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { Logger, MCPServerConfig } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../src/client.js';
import { MCPClient } from '../src/client.js';
import { MCPRegistry } from '../src/registry.js';

const silentLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

/**
 * Inline mock MCP server — no temp file, no spawn.
 * Intercepts the MCPClient's stdin/stdout so we can drive JSON-RPC
 * conversation from within the test without a subprocess.
 */
class InlineMockMCP {
  private tools: MCPTool[];
  private responses = new Map<string, { content: unknown; isError?: boolean }>();
  private scriptPath?: string | undefined;

  constructor(tools: MCPTool[] = []) {
    this.tools = tools;
  }

  setResponse(params: unknown, response: { content: unknown; isError?: boolean } | string): void {
    this.responses.set(
      JSON.stringify(params),
      typeof response === 'string' ? { content: response } : response,
    );
  }

  /**
   * Build a minimal Node script that implements this mock and return its path.
   */
  async writeScript(): Promise<string> {
    if (this.scriptPath) return this.scriptPath;
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const responsesJson = JSON.stringify(Object.fromEntries(this.responses.entries()));
    const toolsJson = JSON.stringify(this.tools);

    // CJS script (no imports needed) — spawned as child process
    const script = `'use strict';
const rl = require('readline');
const MOCK_TOOLS = ${toolsJson};
const RESPONSES = ${responsesJson};
let buf = '';
rl.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  buf += line + '\\n';
  let idx;
  while ((idx = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!raw) continue;
    let req;
    try { req = JSON.parse(raw); } catch { continue; }
    const send = (res) => { process.stdout.write(JSON.stringify(res) + '\\n'); };
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } } });
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools: MOCK_TOOLS } });
    } else if (req.method === 'tools/call') {
      const key = JSON.stringify(req.params?.arguments ?? {});
      const r = RESPONSES[key] || { content: 'mock-ok' };
      const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
      send({ jsonrpc: '2.0', id: req.id, result: { content, isError: Boolean(r.isError) } });
    } else if (req.method === 'notifications/initialized') {
      // no response needed
    } else if (req.id !== undefined) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
`;

    const p = join(tmpdir(), `mock-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(p, script, 'utf8');
    this.scriptPath = p;
    return p;
  }

  async cleanup(): Promise<void> {
    if (this.scriptPath) {
      try {
        await import('node:fs').then((m) => m.unlinkSync(this.scriptPath!));
      } catch {
        /* ignore */
      }
      this.scriptPath = undefined;
    }
  }

  get path(): string | undefined {
    return this.scriptPath;
  }
}

const stdioCfg = (
  name: string,
  scriptPath: string,
  extra: Partial<MCPServerConfig> = {},
): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'node',
  args: [scriptPath],
  startupTimeoutMs: 30_000,
  ...extra,
});

describe('MCPClient + MockMCPServer', () => {
  let server: InlineMockMCP;

  beforeEach(async () => {
    server = new InlineMockMCP([
      {
        name: 'hello',
        description: 'Says hello',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      },
      { name: 'ping', description: 'Ping', inputSchema: { type: 'object' } },
    ]);
    server.setResponse({}, { content: 'pong' });
    server.setResponse({ name: 'test' }, { content: 'Hello, test!' });
  });

  afterEach(async () => {
    await server.cleanup();
  });

  it('connect + listTools returns correct tools', async () => {
    const scriptPath = await server.writeScript();
    const client = new MCPClient({
      name: 'mock',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    await client.connect();
    expect(client.getState()).toBe('connected');
    expect(client.getServerMetadata()).toEqual({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock', version: '1.0.0', title: undefined },
      instructions: undefined,
    });
    const tools = client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['hello', 'ping']);
    await client.close();
  });

  it('callTool returns the mocked response', async () => {
    const scriptPath = await server.writeScript();
    const client = new MCPClient({
      name: 'mock',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    await client.connect();
    const result = await client.callTool('hello', { name: 'test' });
    expect(result.content).toBe('Hello, test!');
    expect(result.isError).toBe(false);
    await client.close();
  });

  it('callTool surfaces isError in the result', async () => {
    // Contract: callTool returns { content, isError }. The consumer
    // (see wrap-tool.ts) is the one that throws on isError so the
    // agent receives a tool_result with is_error: true.
    server.setResponse({}, { content: 'boom', isError: true });
    const scriptPath = await server.writeScript();
    const client = new MCPClient({
      name: 'mock',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    await client.connect();
    const res = await client.callTool('hello', {});
    expect(res.isError).toBe(true);
    expect(res.content).toBe('boom');
    await client.close();
  });

  it('callTool rejects when disconnected', async () => {
    const scriptPath = await server.writeScript();
    const client = new MCPClient({
      name: 'mock',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    await expect(client.callTool('hello', {})).rejects.toThrow(/not connected/);
  });

  it('close is idempotent', async () => {
    const scriptPath = await server.writeScript();
    const client = new MCPClient({
      name: 'mock',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    await client.connect();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('exit listener fires on close', async () => {
    const scriptPath = await server.writeScript();
    const client = new MCPClient({
      name: 'mock',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    const exitEvents: unknown[] = [];
    client.addExitListener((_n, code, signal) => exitEvents.push({ code, signal }));
    await client.connect();
    await client.close();
    expect(exitEvents).toHaveLength(1);
  });

  it('listTools returns empty before connect', () => {
    const client = new MCPClient({
      name: 'mock',
      transport: 'stdio',
      command: 'node',
      args: ['/nonexistent'],
      startupTimeoutMs: 30_000,
    });
    expect(client.listTools()).toEqual([]);
  });
});

describe('MCPRegistry + MockMCPServer', () => {
  let server: InlineMockMCP;
  let scriptPath: string;
  let toolReg: ToolRegistry;
  let events: EventBus;

  beforeEach(async () => {
    server = new InlineMockMCP([
      { name: 'ping', description: 'Ping', inputSchema: { type: 'object' } },
      {
        name: 'echo',
        description: 'Echo',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
    ]);
    server.setResponse({}, { content: 'pong' });
    scriptPath = await server.writeScript();
    toolReg = new ToolRegistry();
    events = new EventBus();
  });

  afterEach(async () => {
    await server.cleanup();
  });

  it('start connects and registers namespaced tools', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('mock', scriptPath, { enabled: true }));
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.state).toBe('connected');
    expect(list[0]!.toolCount).toBe(2);
    const registered = toolReg.list();
    expect(registered.map((t) => t.name)).toContain('mcp__mock__ping');
    expect(registered.map((t) => t.name)).toContain('mcp__mock__echo');
    await reg.stopAll();
  });

  it('stop unregisters all tools', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('mock', scriptPath, { enabled: true }));
    await reg.stop('mock');
    expect(toolReg.list().filter((t) => t.name.startsWith('mcp__mock__'))).toHaveLength(0);
  });

  it('restart reconnects after stop', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(
      stdioCfg('mock', scriptPath, {
        enabled: true,
        allowedTools: ['ping'],
        permission: 'deny',
      }),
    );
    expect(reg.list()[0]!.state).toBe('connected');
    await reg.stop('mock');
    await reg.restart('mock');
    expect(reg.list()[0]!.state).toBe('connected');
    expect(toolReg.list()).toEqual([
      expect.objectContaining({ name: 'mcp__mock__ping', permission: 'deny' }),
    ]);
    await reg.stopAll();
  });

  it('health returns alive=true for connected', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('mock', scriptPath, { enabled: true }));
    const h = reg.health();
    expect(h[0]!.alive).toBe(true);
    await reg.stopAll();
  });

  it('health returns alive=false for failed', { timeout: 15_000 }, async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    // A nonexistent *binary* fails the spawn itself with ENOENT — no process
    // is ever created. The previous `node /nonexistent/script.js` started a
    // real node process on every retry while the test slept a fixed 6s.
    const cfg = stdioCfg('broken', 'irrelevant.js', { enabled: true, startupTimeoutMs: 200 });
    cfg.command = '__nonexistent_binary_zzzz__';
    await reg.start(cfg);
    // Poll instead of a fixed sleep: finishes the moment retries exhaust.
    await expect.poll(() => reg.health()[0]?.alive, { timeout: 12_000, interval: 200 }).toBe(false);
  });

  it('skips disabled servers', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('mock', scriptPath, { enabled: false }));
    expect(reg.list()).toHaveLength(0);
  });

  it('emits connected event', async () => {
    const connected: unknown[] = [];
    events.on('mcp.server.connected', (p) => connected.push(p));
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('mock', scriptPath, { enabled: true }));
    expect(connected).toHaveLength(1);
    expect((connected[0] as { name: string }).name).toBe('mock');
    await reg.stopAll();
  });

  it('allowedTools filters tools', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('mock', scriptPath, { enabled: true, allowedTools: ['ping'] }));
    const registered = toolReg.list();
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe('mcp__mock__ping');
    await reg.stopAll();
  });

  it('permission is propagated to tools', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('mock', scriptPath, { enabled: true, permission: 'deny' }));
    const registered = toolReg.list();
    expect(registered.every((t) => t.permission === 'deny')).toBe(true);
    await reg.stopAll();
  });

  it('stopAll is safe when nothing started', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await expect(reg.stopAll()).resolves.toBeUndefined();
  });

  it('stopAll stops registered servers concurrently and completes even if one throws', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    const order: string[] = [];
    const makeMockSlot = (name: string, shouldFail = false) => ({
      cfg: { name, transport: 'stdio' as const, command: 'node' },
      state: 'connected' as const,
      toolNames: [],
      lazyTools: [],
      attempts: 0,
      reconnectPending: false,
      reconnectCycles: 0,
      lazy: false,
      lastUsed: Date.now(),
      registeredLazy: false,
      operations: { inFlightCalls: 0, sleepCount: 0 },
      client: {
        removeExitListener: vi.fn(),
        removeToolsChangedListener: vi.fn(),
        removeResourcesChangedListener: vi.fn(),
        removePromptsChangedListener: vi.fn(),
        close: vi.fn(async () => {
          order.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 25));
          order.push(`${name}:done`);
          if (shouldFail) throw new Error('stop failed');
        }),
      },
    });

    const s1 = makeMockSlot('s1');
    const s2 = makeMockSlot('s2', true);
    const s3 = makeMockSlot('s3');
    (reg as any).servers.set('s1', s1);
    (reg as any).servers.set('s2', s2);
    (reg as any).servers.set('s3', s3);

    const start = Date.now();
    await reg.stopAll();
    const duration = Date.now() - start;

    expect(order.slice(0, 3)).toEqual(['s1:start', 's2:start', 's3:start']);
    expect(duration).toBeLessThan(70);
    expect(s1.state).toBe('disconnected');
    expect(s2.state).toBe('disconnected');
    expect(s3.state).toBe('disconnected');
  });
});
