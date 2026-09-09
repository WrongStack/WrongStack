/**
 * ACP -> MCP config mapping.
 *
 * The two specs name their transports differently: ACP's `http` is MCP's
 * `streamable-http`, and an ACP entry with no `type` at all is stdio. Getting
 * either wrong means a server that connects to nothing, which is how the
 * previous behaviour (drop the array entirely) looked from the client side.
 */
import type { McpServer } from '@wrongstack/acp/agent';
import { describe, expect, it } from 'vitest';
import { acpMcpServerToConfig } from '../src/acp-mcp-servers.js';

describe('acpMcpServerToConfig', () => {
  it('treats an entry with no type as stdio and passes command and args through', () => {
    const cfg = acpMcpServerToConfig({
      name: 'files',
      command: 'node',
      args: ['server.js', '--stdio'],
    });
    expect(cfg).toMatchObject({
      name: 'files',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--stdio'],
    });
  });

  it("maps ACP's http onto MCP's streamable-http, not a literal 'http'", () => {
    const cfg = acpMcpServerToConfig({
      type: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
    });
    expect(cfg.transport).toBe('streamable-http');
    expect(cfg.url).toBe('https://example.test/mcp');
  });

  it('maps sse to sse', () => {
    const cfg = acpMcpServerToConfig({
      type: 'sse',
      name: 'events',
      url: 'https://example.test/sse',
    });
    expect(cfg.transport).toBe('sse');
  });

  it('converts the {name,value} pair arrays into the records config expects', () => {
    const stdio = acpMcpServerToConfig({
      name: 'gh',
      command: 'gh-mcp',
      env: [
        { name: 'GITHUB_TOKEN', value: 'secret' },
        { name: 'GH_HOST', value: 'github.com' },
      ],
    });
    expect(stdio.env).toEqual({ GITHUB_TOKEN: 'secret', GH_HOST: 'github.com' });

    const http = acpMcpServerToConfig({
      type: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }],
    });
    expect(http.headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('omits env, args and headers entirely when the client sent none', () => {
    const cfg = acpMcpServerToConfig({ name: 'bare', command: 'x' } as McpServer);
    expect(cfg).not.toHaveProperty('args');
    expect(cfg).not.toHaveProperty('env');
    expect(cfg).not.toHaveProperty('headers');
  });

  it('marks the server as client-supplied so it is distinguishable in mcp listings', () => {
    const cfg = acpMcpServerToConfig({ name: 'files', command: 'node' });
    expect(cfg.description).toContain('ACP client');
  });
});
