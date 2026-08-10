import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPClient } from '../src/client.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(scriptBody: string): Promise<{ root: string; script: string }> {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-mcp-close-'));
  tempRoots.push(root);
  const script = join(root, 'server.cjs');
  await writeFile(script, scriptBody, 'utf8');
  return { root, script };
}

function protocolServerPrelude(): string {
  return String.raw`
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'lifecycle-fixture', version: '1.0.0' }
    }});
  } else if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [] }});
  }
});
`;
}

async function connect(script: string, env: Record<string, string>): Promise<MCPClient> {
  const client = new MCPClient({
    name: 'windows-lifecycle-fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    env,
    startupTimeoutMs: 10_000,
  });
  await client.connect();
  return client;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for Windows MCP lifecycle fixture');
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === 'win32')('MCPClient Windows stdio lifecycle', () => {
  it('delivers stdin EOF so a real server can shut down gracefully', async () => {
    const { root, script } = await fixture(`${protocolServerPrelude()}
const fs = require('node:fs');
lines.on('close', () => fs.writeFileSync(process.env.MARKER_PATH, 'closed'));
`);
    const marker = join(root, 'graceful.txt');
    const client = await connect(script, { MARKER_PATH: marker });

    await client.close();

    await expect(readFile(marker, 'utf8')).resolves.toBe('closed');
  });

  it('force-removes a server tree that ignores stdin EOF', async () => {
    const { root, script } = await fixture(`${protocolServerPrelude()}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore', windowsHide: true
});
fs.writeFileSync(process.env.DESCENDANT_PID_PATH, String(descendant.pid));
const keepAlive = setInterval(() => {}, 1000);
lines.on('close', () => void keepAlive);
`);
    const pidPath = join(root, 'descendant.pid');
    const client = await connect(script, { DESCENDANT_PID_PATH: pidPath });
    const descendantPid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
    expect(processExists(descendantPid)).toBe(true);

    await client.close();
    await waitUntil(async () => !processExists(descendantPid));

    expect(processExists(descendantPid)).toBe(false);
  });
});
