/**
 * `${VAR}` / `${VAR:-default}` in MCP server configs (the `.mcp.json`
 * convention): resolved from the environment when the client is built.
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it } from 'vitest';
import { expandMcpEnvPlaceholders, mcpEnvPlaceholders } from '../src/config-env.js';
import { MCPRegistry } from '../src/registry.js';

const ENV = { TOKEN: 's3cret', HOST: 'mcp.example.com', EMPTY: '' };

describe('expandMcpEnvPlaceholders', () => {
  it('resolves every expandable field and honours defaults', () => {
    const cfg: MCPServerConfig = {
      name: 'x',
      transport: 'streamable-http',
      command: '${HOST}-cli',
      args: ['--token=${TOKEN}', 'plain', '${MISSING:-fallback}'],
      env: { API_KEY: '${TOKEN}', MODE: '${EMPTY:-dev}' },
      url: 'https://${HOST}/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    };
    expect(expandMcpEnvPlaceholders(cfg, ENV)).toEqual({
      command: 'mcp.example.com-cli',
      args: ['--token=s3cret', 'plain', 'fallback'],
      env: { API_KEY: 's3cret', MODE: 'dev' },
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer s3cret' },
    });
  });

  it('names every variable that is unset and has no default', () => {
    const cfg: MCPServerConfig = {
      name: 'gh',
      transport: 'streamable-http',
      url: 'https://api.example.com/${REGION}',
      headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
    };
    expect(() => expandMcpEnvPlaceholders(cfg, {})).toThrow(
      /"gh" needs environment variables REGION, GITHUB_TOKEN/,
    );
  });

  it('leaves text without placeholders, and a bare `$VAR`, alone', () => {
    const cfg: MCPServerConfig = {
      name: 'x',
      transport: 'stdio',
      command: 'echo',
      args: ['$HOME'],
    };
    expect(expandMcpEnvPlaceholders(cfg, ENV)).toMatchObject({ command: 'echo', args: ['$HOME'] });
  });

  it('lists the variables a config reads', () => {
    expect(
      mcpEnvPlaceholders({
        url: 'https://${HOST}',
        headers: { a: '${TOKEN}', b: '${HOST}' },
        args: ['${X:-1}'],
      }),
    ).toEqual(['HOST', 'TOKEN', 'X']);
  });
});

// ── Real servers ───────────────────────────────────────────────────────────

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function registry() {
  const toolRegistry = new ToolRegistry();
  const reg = new MCPRegistry({ toolRegistry, events: new EventBus(), log: silentLog });
  cleanups.push(() => reg.stopAll());
  return { toolRegistry, reg };
}

async function callOnly(toolRegistry: ToolRegistry, name: string): Promise<string> {
  const tool = toolRegistry.list().find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  const signal = new AbortController().signal;
  return String(await tool.execute({}, { signal } as never, { signal }));
}

describe('placeholders reach real servers', () => {
  it('a stdio server gets expanded args and env', { timeout: 30_000 }, async () => {
    const script = `'use strict';
const rl = require('readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'e', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'show', inputSchema: { type: 'object' } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ arg: process.argv[2], key: process.env.API_KEY }) }] } });
});
`;
    const path = join(
      tmpdir(),
      `env-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`,
    );
    writeFileSync(path, script, 'utf8');
    cleanups.push(() => unlinkSync(path));
    process.env['WS_MCP_TEST_TOKEN'] = 'tok-123';
    cleanups.push(() => {
      delete process.env['WS_MCP_TEST_TOKEN'];
    });

    const { toolRegistry, reg } = registry();
    await reg.start({
      name: 'envsrv',
      transport: 'stdio',
      command: process.execPath,
      args: [path, '--token=${WS_MCP_TEST_TOKEN}'],
      env: { API_KEY: '${WS_MCP_TEST_TOKEN}' },
      startupTimeoutMs: 30_000,
    });

    expect(JSON.parse(await callOnly(toolRegistry, 'mcp__envsrv__show'))).toEqual({
      arg: '--token=tok-123',
      key: 'tok-123',
    });
    // The stored config keeps the placeholder — the secret lives only in the child.
    expect(JSON.stringify(reg.describe())).not.toContain('tok-123');
  });

  it('an HTTP server gets the expanded Authorization header', { timeout: 30_000 }, async () => {
    const seen: string[] = [];
    const server = createServer(async (req: IncomingMessage, res) => {
      seen.push(String(req.headers['authorization']));
      let body = '';
      for await (const chunk of req) body += chunk;
      const msg = JSON.parse(body) as { id?: number; method: string };
      if (msg.method === 'server/discover') {
        res.writeHead(400).end();
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        msg.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'h', version: '1' },
            }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'pong' }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    process.env['WS_MCP_TEST_BEARER'] = 'bearer-xyz';
    cleanups.push(() => {
      delete process.env['WS_MCP_TEST_BEARER'];
    });

    const { toolRegistry, reg } = registry();
    await reg.start({
      name: 'httpsrv',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      headers: { Authorization: 'Bearer ${WS_MCP_TEST_BEARER}' },
      startupTimeoutMs: 10_000,
    });
    expect(await callOnly(toolRegistry, 'mcp__httpsrv__ping')).toBe('pong');
    expect(new Set(seen)).toEqual(new Set(['Bearer bearer-xyz']));
  });
});
