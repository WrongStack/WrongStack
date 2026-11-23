import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPClient } from '../src/client.js';

// F1422: listAllTools keeps page 1 when a later tools/list page fails, so a
// stdio child that died mid-pagination used to make connect() RESOLVE with the
// client already 'disconnected'. The registry took that as success and marked
// the slot 'connected' with a dead client, zero tools and no reconnect.
//
// Ordering is gated by the server, not by time: it exits only when it receives
// the page-2 request.
const SERVER = `
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'paged', version: '1' } } });
  } else if (m.method === 'tools/list') {
    if (!m.params || !m.params.cursor) {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'p2' } });
    } else if (mode === 'die') {
      process.exit(0);
    } else {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'b', inputSchema: { type: 'object' } }] } });
    }
  }
});
`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function serverScript(): string {
  const path = join(
    tmpdir(),
    `paged-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  writeFileSync(path, SERVER, 'utf8');
  cleanups.push(() => unlinkSync(path));
  return path;
}

function client(script: string, mode: 'answer' | 'die'): MCPClient {
  const c = new MCPClient({
    name: 'paged',
    transport: 'stdio',
    command: process.execPath,
    args: [script, mode],
    protocolMode: 'legacy',
    startupTimeoutMs: 600_000,
    requestTimeoutMs: 600_000,
  });
  cleanups.push(() => c.close());
  return c;
}

describe('stdio connect when the child dies during tool pagination (F1422)', () => {
  it('a server that answers every page connects with all of them', {
    timeout: 30_000,
  }, async () => {
    const c = client(serverScript(), 'answer');
    await c.connect();
    expect(c.getState()).toBe('connected');
    expect(c.listTools().map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('a child that exits on the page-2 request fails connect()', { timeout: 30_000 }, async () => {
    const c = client(serverScript(), 'die');
    await expect(c.connect()).rejects.toThrow(/connection ended during tool discovery/);
    expect(c.getState()).toBe('failed');
  });
});
