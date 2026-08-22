/**
 * Mock MCP server for testing — speaks JSON-RPC over stdio.
 *
 * Usage:
 *   const server = new MockMCPServer([
 *     { name: 'hello', description: 'Say hello', inputSchema: { type: 'object' } },
 *   ]);
 *   const path = await server.writeScript();
 *   const client = new MCPClient({ name: 'test', transport: 'stdio', command: 'node', args: [path] });
 *   await client.connect();
 *   const tools = client.listTools();
 *   const result = await client.callTool('hello', {});
 *   await server.cleanup();
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MCPTool } from '../contracts.js';

export interface MockToolResponse {
  content: unknown;
  isError?: boolean | undefined;
}

export interface MockMCPServerOptions {
  /** Delay injected between receiving a request and sending the response (ms). */
  responseDelayMs?: number | undefined;
}

/**
 * Minimal in-process MCP server that speaks JSON-RPC over stdio.
 * Writes a self-contained Node.js script to a temp file and exposes the path
 * for spawning as a child process.
 */
export class MockMCPServer {
  private readonly tools: MCPTool[];
  private readonly delayMs: number;
  /** Responses keyed by `JSON.stringify(params)` for tools/call. */
  private readonly responses = new Map<string, MockToolResponse>();
  private scriptPath?: string | undefined;

  constructor(tools: MCPTool[] = [], opts: MockMCPServerOptions = {}) {
    this.tools = tools;
    this.delayMs = opts.responseDelayMs ?? 0;
  }

  setResponse(params: unknown, response: MockToolResponse | string): void {
    this.responses.set(
      JSON.stringify(params),
      typeof response === 'string' ? { content: response } : response,
    );
  }

  setTools(tools: MCPTool[]): void {
    this.tools.length = 0;
    this.tools.push(...tools);
  }

  /**
   * Write the mock server script to a temp file and return the path.
   * The script is self-contained and requires no external dependencies.
   */
  async writeScript(): Promise<string> {
    if (this.scriptPath) return this.scriptPath;

    const responsesJson = JSON.stringify(Object.fromEntries(this.responses.entries()));
    const toolsJson = JSON.stringify(this.tools);

    const script = /* js */ `
'use strict';
const rl = require('readline');
const MOCK_TOOLS = ${toolsJson};
const RESPONSES = ${responsesJson};
const DELAY = ${this.delayMs};

let buf = '';
rl.createInterface({ input: process.stdin, terminal: false })
  .on('line', (line) => {
    buf += line + '\\n';
    let idx;
    while ((idx = buf.indexOf('\\n')) !== -1) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      let req;
      try { req = JSON.parse(raw); } catch { continue; }
      const send = (res) => {
        const write = () => { process.stdout.write(JSON.stringify(res) + '\\n'); process.stdout.flush(); };
        if (DELAY > 0) setTimeout(write, DELAY); else write();
      };
      if (req.method === 'initialize') {
        send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } } });
      } else if (req.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: req.id, result: { tools: MOCK_TOOLS } });
      } else if (req.method === 'tools/call') {
        const key = JSON.stringify(req.params?.arguments ?? {});
        const r = RESPONSES[key] || { content: 'mock-ok' };
        send({ jsonrpc: '2.0', id: req.id, result: { content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content), isError: Boolean(r.isError) } });
      } else if (req.method === 'notifications/initialized') {
        // no-op
      } else if (req.id !== undefined) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
      }
    }
  });
`;

    const dir = os.tmpdir();
    this.scriptPath = path.join(
      dir,
      `mock-mcp-server-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
    );
    await fs.writeFile(this.scriptPath, script, 'utf8');
    return this.scriptPath;
  }

  /** Delete the temp script. Call after test completes. */
  async cleanup(): Promise<void> {
    if (this.scriptPath) {
      try {
        await fs.unlink(this.scriptPath);
      } catch {
        /* ignore */
      }
      this.scriptPath = undefined;
    }
  }

  /** Path to the script if already written via writeScript(). */
  get path(): string | undefined {
    return this.scriptPath;
  }
}
