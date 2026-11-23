import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalMcpResource } from '../src/authorization.js';
import { MCPAuthorizationManager } from '../src/authorization-manager.js';
import { MCPRegistry } from '../src/registry.js';
import {
  createVaultBackedMcpAuthorizationProviderFactory,
  type MCPVaultTokenStore,
} from '../src/token-store.js';

// F1421: a `${VAR}` in an HTTP server's `url` expands per connect
// (config-env.ts), so the authorization provider and the OAuth login must use
// the expanded URL too. The provider used to pin the RAW url, and its context
// check failed the very first request of every such server — OAuth or not.

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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(): Promise<number> {
  const server: Server = createServer(async (req: IncomingMessage, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

describe('HTTP server url with ${VAR} placeholders and the authorization provider (F1421)', () => {
  it('connects, and provider + login + status lookup use the expanded resource', {
    timeout: 30_000,
  }, async () => {
    const port = await startServer();
    process.env['WS_F1421_SEGMENT'] = 'mcp';
    cleanups.push(() => {
      delete process.env['WS_F1421_SEGMENT'];
    });
    const expandedUrl = `http://127.0.0.1:${port}/mcp`;

    // No stored tokens; nothing here reads or writes a token file.
    const loads: string[] = [];
    const store = {
      load: async (_server: string, resource: string) => {
        loads.push(resource);
        return undefined;
      },
    } as unknown as MCPVaultTokenStore;
    const realFactory = createVaultBackedMcpAuthorizationProviderFactory({ store });
    const providerUrls: Array<string | undefined> = [];
    const discovered: string[] = [];
    const toolRegistry = new ToolRegistry();
    const reg = new MCPRegistry({
      toolRegistry,
      events: new EventBus(),
      log: silentLog,
      authorizationProviderFactory: (server: Readonly<MCPServerConfig>) => {
        providerUrls.push(server.url);
        return realFactory(server);
      },
      authorizationManager: new MCPAuthorizationManager({
        store,
        discover: async (resource) => {
          discovered.push(resource);
          throw new Error('discovery stopped by test');
        },
      }),
    });
    cleanups.push(() => reg.stopAll());

    await reg.start({
      name: 'h',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/\${WS_F1421_SEGMENT}`,
      startupTimeoutMs: 10_000,
    });

    const tool = toolRegistry.list().find((t) => t.name === 'mcp__h__ping');
    expect(reg.describe().find((s) => s.name === 'h')?.state).toBe('connected');
    expect(tool).toBeDefined();
    const signal = new AbortController().signal;
    expect(String(await tool!.execute({}, { signal } as never, { signal }))).toBe('pong');
    expect(providerUrls).toEqual([expandedUrl]);
    // Every token lookup the provider made during connect and the call used it.
    expect(loads.length).toBeGreaterThan(0);
    expect(new Set(loads)).toEqual(new Set([canonicalMcpResource(expandedUrl)]));

    await expect(
      reg.beginAuthorization('h', { redirectUri: 'http://127.0.0.1:43123/callback' }),
    ).rejects.toThrow('discovery stopped by test');
    expect(discovered).toEqual([canonicalMcpResource(expandedUrl)]);
    // Status looks the grant up under the expanded resource, but reports the
    // server as configured: a status query must not print an expanded secret.
    loads.length = 0;
    const status = await reg.authorizationStatus('h');
    expect(loads).toEqual([canonicalMcpResource(expandedUrl)]);
    expect(status.resource).toBe(
      canonicalMcpResource(`http://127.0.0.1:${port}/\${WS_F1421_SEGMENT}`),
    );
  });
  it('status and logout still work when a url variable is unset', async () => {
    delete process.env['WS_F1421_UNSET'];
    const removed: string[] = [];
    const store = {
      load: async () => undefined,
      save: async () => undefined,
      remove: async (_server: string, resource: string) => {
        removed.push(resource);
        return true;
      },
    } as unknown as MCPVaultTokenStore;
    const reg = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events: new EventBus(),
      log: silentLog,
      authorizationManager: new MCPAuthorizationManager({
        store,
        discover: async () => {
          throw new Error('no discovery');
        },
      }),
    });
    cleanups.push(() => reg.stopAll());
    const raw = 'https://h.example/mcp?k=${WS_F1421_UNSET}';
    await reg
      .start({ name: 'u', transport: 'streamable-http', url: raw, startupTimeoutMs: 2_000 })
      .catch(() => undefined);
    // Login needs the real resource, so it still refuses; status and logout fall
    // back to the configured url so a stored grant can be seen and dropped.
    await expect(
      reg.beginAuthorization('u', { redirectUri: 'http://127.0.0.1:43123/callback' }),
    ).rejects.toThrow('WS_F1421_UNSET');
    expect((await reg.authorizationStatus('u')).state).toBe('not_authorized');
    await expect(reg.disconnectAuthorization('u')).resolves.toBe(true);
    expect(removed).toEqual([canonicalMcpResource(raw)]);
  });
});
