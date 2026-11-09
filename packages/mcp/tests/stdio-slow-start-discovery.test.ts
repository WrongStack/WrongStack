import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPClient } from '../src/client.js';
import { MODERN_PROTOCOL_VERSION } from '../src/modern-protocol.js';

// A server launched through npx/uvx often needs more than the one second the
// client gives `server/discover` before it also tries the legacy handshake.
// These peers start reading stdin only after `delayMs`, so every request waits
// in the pipe the way it does behind a slow interpreter start.
const MODERN_ONLY = `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const [log, delay] = process.argv.slice(2);
setTimeout(() => readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  appendFileSync(log, JSON.stringify(m.method) + '\\n');
  if (m.id === undefined) return;
  const result = m.method === 'server/discover'
    ? { resultType: 'complete', supportedVersions: ['${MODERN_PROTOCOL_VERSION}'], capabilities: { tools: {} } }
    : m.method === 'tools/list'
      ? { resultType: 'complete', tools: [{ name: 'build', inputSchema: { type: 'object' } }] }
      : undefined;
  process.stdout.write(JSON.stringify(result
    ? { jsonrpc: '2.0', id: m.id, result }
    : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
}), Number(delay));
`;

// A legacy peer that never answers requests it does not know (the case the
// one-second discovery window exists for) and speaks only initialize.
const LEGACY_SILENT = `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const [log, delay] = process.argv.slice(2);
setTimeout(() => readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  appendFileSync(log, JSON.stringify(m.method) + '\\n');
  if (m.id === undefined || m.method === 'server/discover') return;
  const result = m.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'legacy', version: '1' } }
    : { tools: [{ name: 'build', inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
}), Number(delay));
`;

// A legacy peer that answers discovery with -32601 at once.
const LEGACY_REFUSES = LEGACY_SILENT.replace(
  "if (m.id === undefined || m.method === 'server/discover') return;",
  "if (m.id === undefined) return;\n  if (m.method === 'server/discover') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\\n'); return; }",
);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wstack-mcp-slow-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect(source: string, delayMs: number) {
  const peer = path.join(dir, 'peer.mjs');
  const log = path.join(dir, 'calls.jsonl');
  await writeFile(peer, source);
  await writeFile(log, '');
  const client = new MCPClient({
    name: 'slow-peer',
    transport: 'stdio',
    command: process.execPath,
    args: [peer, log, String(delayMs)],
    cwd: dir,
  });
  try {
    await client.connect();
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return {
      protocolVersion: client.getServerMetadata()?.protocolVersion,
      tools: (await client.listTools()).map((t) => t.name),
      calls,
    };
  } finally {
    await client.close();
  }
}

describe('stdio protocol discovery when the server starts slowly', () => {
  it('connects a modern-only server whose discovery answer comes after the legacy fallback starts', async () => {
    const result = await connect(MODERN_ONLY, 1500);
    expect(result.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);
    expect(result.tools).toEqual(['build']);
  }, 20_000);

  it('still falls back to initialize for a slow legacy server that ignores discovery', async () => {
    const result = await connect(LEGACY_SILENT, 1500);
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.tools).toEqual(['build']);
    expect(result.calls).toContain('notifications/initialized');
  }, 20_000);

  it('takes the legacy path at once when discovery is refused', async () => {
    const result = await connect(LEGACY_REFUSES, 0);
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.calls.slice(0, 2)).toEqual(['server/discover', 'initialize']);
  }, 20_000);
});
