import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  legacyDiscoveryResponse,
  runLegacyProxy,
  wrapMcpServers,
} from '../../../scripts/acp-mcp-legacy.mjs';

describe('opt-in legacy MCP negotiation for an ACP agent', () => {
  it('wraps stdio launchers while preserving project arguments, env and HTTP servers', () => {
    const stdio = {
      name: 'index',
      command: 'wstack',
      args: ['mcp', 'serve', 'codebase-index', '--project-root=/p'],
      env: [{ name: 'MODE', value: 'test' }],
    };
    const http = { name: 'fleet', type: 'http', url: 'http://127.0.0.1:1234', headers: [] };
    for (const method of ['session/new', 'session/load', 'session/resume']) {
      const message = {
        id: 0,
        method,
        params: { sessionId: 's1', cwd: '/p', mcpServers: [stdio, http] },
      };
      expect(wrapMcpServers(message, '/bun', '/proxy.mjs')).toEqual({
        ...message,
        params: {
          ...message.params,
          mcpServers: [
            {
              ...stdio,
              command: '/bun',
              args: ['/proxy.mjs', '--server', '--', stdio.command, ...stdio.args],
            },
            http,
          ],
        },
      });
      expect(message.params.mcpServers[0]).toBe(stdio);
    }
  });

  it('leaves prompts and malformed setup untouched', () => {
    for (const message of [
      null,
      {},
      { method: 'session/prompt', params: { mcpServers: [] } },
      { method: 'session/new', params: {} },
    ]) {
      expect(wrapMcpServers(message, '/bun', '/proxy')).toBe(message);
    }
  });

  it('declines discovery with request id zero and forwards initialize to the real server', () => {
    expect(legacyDiscoveryResponse({ method: 'server/discover', id: 0 })).toEqual({
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32601, message: 'Use MCP initialize' },
    });
    expect(legacyDiscoveryResponse({ method: 'initialize', id: 1 })).toBeUndefined();
    expect(legacyDiscoveryResponse({ method: 'server/discover' })).toBeUndefined();
  });

  it('negotiates a real subprocess without forwarding the unsupported discovery probe', () => {
    const script = fileURLToPath(new URL('../../../scripts/acp-mcp-legacy.mjs', import.meta.url));
    const peer =
      "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{forwarded:m.method}}));});";
    const result = spawnSync(
      process.execPath,
      [script, '--server', '--', process.execPath, '-e', peer],
      {
        input:
          [
            { jsonrpc: '2.0', id: 0, method: 'server/discover' },
            { jsonrpc: '2.0', id: 1, method: 'initialize' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          ]
            .map((x) => JSON.stringify(x))
            .join('\n') + '\n',
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const frames = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames).toContainEqual({
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32601, message: 'Use MCP initialize' },
    });
    expect(frames).toContainEqual({ jsonrpc: '2.0', id: 1, result: { forwarded: 'initialize' } });
    expect(frames).toContainEqual({ jsonrpc: '2.0', id: 2, result: { forwarded: 'tools/list' } });
    expect(frames).toHaveLength(3);
  });

  it('rejects an invalid launch before starting a process', async () => {
    await expect(runLegacyProxy([])).rejects.toThrow('Usage:');
  });
});
