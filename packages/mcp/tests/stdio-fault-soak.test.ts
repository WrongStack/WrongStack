import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { Logger, MCPServerConfig } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MCPClient } from '../src/client.js';
import { MCPRegistry } from '../src/registry.js';

function getClient(reg: MCPRegistry, name: string): MCPClient | undefined {
  return (reg as unknown as { servers: Map<string, { client?: MCPClient }> }).servers.get(name)
    ?.client;
}

const silentLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

/**
 * Fault-injecting stdio mock server. It answers a configurable number of
 * successful tool calls and then exits with a non-zero code, forcing the
 * registry through reconnect/retry cycles.
 */
function writeFaultyServerScript(exitAfterCalls: number): string {
  const script = `'use strict';
const rl = require('readline');
let calls = 0;
let initialized = false;
let initId = null;
const send = (res) => { process.stdout.write(JSON.stringify(res) + '\\n'); };
rl.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let req;
  try { req = JSON.parse(raw); } catch { return; }
  if (req.method === 'initialize') {
    initialized = true;
    initId = req.id;
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'faulty', version: '1.0.0' } } });
  } else if (req.method === 'notifications/initialized') {
    // no-op
  } else if (req.method === 'tools/list' && initialized) {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] } });
  } else if (req.method === 'tools/call' && initialized) {
    calls++;
    send({ jsonrpc: '2.0', id: req.id, result: { content: 'pong-' + calls, isError: false } });
    if (calls >= ${exitAfterCalls}) {
      process.stderr.write('injecting fault after ' + calls + ' calls\\n');
      process.exit(1);
    }
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;
  const p = path.join(
    os.tmpdir(),
    `mcp-faulty-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
  );
  fs.writeFileSync(p, script, 'utf8');
  return p;
}

function stdioCfg(name: string, scriptPath: string): MCPServerConfig {
  return {
    name,
    transport: 'stdio',
    command: 'node',
    args: [scriptPath],
    startupTimeoutMs: 2000,
    requestTimeoutMs: 2000,
  };
}

describe('MCP stdio fault-injection soak', () => {
  let toolReg: ToolRegistry;
  let events: EventBus;
  let scriptPath: string;

  beforeEach(() => {
    toolReg = new ToolRegistry();
    events = new EventBus();
  });

  afterEach(async () => {
    try {
      if (scriptPath) fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  });

  it('survives repeated child process crashes without a tight reconnect loop', {
    timeout: 60_000,
  }, async () => {
    // Each spawned process handles 2 tool calls and then exits with code 1.
    // The registry should reconnect several times. Because every reconnect
    // succeeds, the slot should not get permanently stuck in `failed`.
    scriptPath = writeFaultyServerScript(2);
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('soak', scriptPath));

    // Wait for the first healthy connection.
    await expect
      .poll(() => reg.list()[0]?.state, { timeout: 5000, interval: 100 })
      .toBe('connected');

    let successes = 0;
    let _failures = 0;
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const op = reg.operationalHealth()[0];
      if (op && op.restartCount + op.reconnectCount >= 2 && successes >= 2) {
        break;
      }
      const client = getClient(reg, 'soak');
      const health = reg.health()[0];
      if (!client || (health && !health.alive)) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      try {
        const res = await client.callTool('ping', {});
        if (typeof res.content === 'string' && res.content.startsWith('pong-')) {
          successes++;
        }
      } catch {
        _failures++;
      }
      // Pace calls so the child reliably reaches its 2-call crash limit.
      await new Promise((r) => setTimeout(r, 100));
    }

    // The server keeps crashing but always reconnects successfully, so it
    // should stay out of the permanent `failed` state while still logging
    // transport failures and reconnects. It may be mid-reconnect when the
    // test window closes.
    const op = reg.operationalHealth()[0];
    expect(op).toBeDefined();
    if (!op) throw new Error('operationalHealth missing');
    expect(op.healthState).not.toBe('failed');
    expect(op.restartCount + op.reconnectCount).toBeGreaterThanOrEqual(2);
    expect(op.failures.transport).toBeGreaterThan(0);

    // Must have observed some successful calls across process restarts.
    expect(successes).toBeGreaterThan(0);

    // Sanity: there should not be hundreds of restarts (tight loop guard).
    // With exponential backoff between reconnect cycles we expect < 20.
    expect(op.restartCount + op.reconnectCount).toBeLessThan(20);

    await reg.stopAll();
  });

  it('recovers when the child process stabilizes after intermittent crashes', {
    timeout: 45_000,
  }, async () => {
    // Use a script that crashes once after 1 call, then stays healthy.
    // We simulate this by writing a script that reads an env var to decide.
    const script = `'use strict';
const rl = require('readline');
let calls = 0;
const crashAfter = parseInt(process.env.MCP_CRASH_AFTER || '9999', 10);
const send = (res) => { process.stdout.write(JSON.stringify(res) + '\\n'); };
rl.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let req;
  try { req = JSON.parse(raw); } catch { return; }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'recover', version: '1.0.0' } } });
  } else if (req.method === 'notifications/initialized') {
    // no-op
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] } });
  } else if (req.method === 'tools/call') {
    calls++;
    send({ jsonrpc: '2.0', id: req.id, result: { content: 'ok-' + calls, isError: false } });
    if (calls >= crashAfter) {
      process.exit(1);
    }
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;
    scriptPath = path.join(
      os.tmpdir(),
      `mcp-recover-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
    );
    fs.writeFileSync(scriptPath, script, 'utf8');

    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start({
      ...stdioCfg('recover', scriptPath),
      env: { MCP_CRASH_AFTER: '1' },
    });

    // First process dies after 1 call; wait for reconnect.
    await expect
      .poll(() => reg.list()[0]?.state, { timeout: 8000, interval: 100 })
      .toBe('connected');

    // Update env so subsequent processes do not crash.
    const slot = (reg as unknown as { servers: Map<string, { cfg: MCPServerConfig }> }).servers.get(
      'recover',
    );
    if (slot) slot.cfg.env = { MCP_CRASH_AFTER: '9999' };

    let successes = 0;
    for (let i = 0; i < 30; i++) {
      if (successes >= 3) break;
      const client = getClient(reg, 'recover');
      if (!client) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      try {
        const res = await client.callTool('ping', {});
        if (typeof res.content === 'string' && res.content.startsWith('ok-')) {
          successes++;
        }
      } catch {
        /* ignore transient */
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // Should see a healthy state and multiple consecutive successes after recovery.
    expect(successes).toBeGreaterThanOrEqual(3);
    const op = reg.operationalHealth()[0];
    expect(op).toBeDefined();
    if (!op) throw new Error('operationalHealth missing');
    expect(op.healthState).toBeOneOf(['healthy', 'degraded']);
    expect(op.consecutiveFailures).toBe(0);

    await reg.stopAll();
  });
});
