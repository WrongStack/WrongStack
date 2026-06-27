// End-to-end ACP v1 smoke test: a Node harness that speaks JSON-RPC 2.0
// to the WrongStackACPServer over stdio and walks a full session. This
// proves the server's wire format is compatible with a real v1 client
// (Zed, JetBrains Junie, etc. follow the same JSON-RPC envelope).
//
// What this test does:
//  1. spawn the server as a child process
//  2. send initialize, assert protocolVersion=1 + agentCapabilities
//  3. send session/new, assert sessionId is returned
//  4. send session/prompt, collect any session/update notifications
//     and assert the stopReason
//  5. send session/cancel notification
//  6. send exit notification
//  7. close stdin, expect the process to exit cleanly
//
// Run: node scripts/acp-smoke-test.mts (from repo root)
//
// The server's `runTurn` here is a no-op echo (the bootstrap default).
// The smoke test verifies the wire protocol, not the agent logic —
// the agent logic is exercised by the unit tests in
// packages/acp/tests/server-agent-turn.test.ts.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dirname, '..', 'packages', 'acp', 'dist', 'wrongstack-acp-agent.js');

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

let child;
try {
  child = spawn(process.execPath, [serverEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
} catch (err) {
  writeError(`Failed to spawn server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let nextId = 1;
const inflight = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const notifications: unknown[] = [];

let lineBuffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  lineBuffer += chunk;
  // Process complete JSON-RPC lines.
  let nlIdx = lineBuffer.indexOf('\n');
  while (nlIdx !== -1) {
    const line = lineBuffer.slice(0, nlIdx).trim();
    lineBuffer = lineBuffer.slice(nlIdx + 1);
    nlIdx = lineBuffer.indexOf('\n');
    if (line.length === 0) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      writeError(`Non-JSON line from server: ${line} ${detail}`);
    }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk: string) => {
  process.stderr.write(`[server stderr] ${chunk}`);
});

function handleMessage(msg: { id?: unknown; result?: unknown; error?: unknown; method?: unknown; params?: unknown }): void {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = inflight.get(msg.id as number);
    if (!pending) return;
    inflight.delete(msg.id as number);
    if (msg.error) {
      pending.reject(new Error(JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }
  if (msg.method) {
    notifications.push(msg);
  }
}

function send(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function sendNotification(method: string, params: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    writeError(`FAIL: ${msg}`);
    child.kill();
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Step 1: initialize
  const init = (await send('initialize', { protocolVersion: 1 })) as {
    protocolVersion: number;
    agentCapabilities: { loadSession: boolean; promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean } };
    agentInfo: { name: string; title: string; version: string };
  };
  assert(init.protocolVersion === 1, 'protocolVersion must be 1');
  assert(init.agentCapabilities.loadSession === true, 'loadSession should be true');
  assert(init.agentInfo.name === 'wrongstack', `agentInfo.name should be 'wrongstack', got ${init.agentInfo.name}`);
  console.log('PASS: initialize', JSON.stringify(init));

  // Step 2: authenticate (no-op, returns unauthenticated)
  const auth = (await send('authenticate', {})) as { outcome: string };
  assert(auth.outcome === 'unauthenticated', `auth.outcome should be 'unauthenticated'`);
  console.log('PASS: authenticate');

  // Step 3: session/new
  const newResp = (await send('session/new', { cwd: process.cwd() })) as { sessionId: string };
  const sessionId = newResp.sessionId;
  assert(typeof sessionId === 'string' && sessionId.startsWith('sess_'),
    `sessionId should be a string starting with sess_, got ${sessionId}`);
  console.log('PASS: session/new', sessionId);

  // Step 4: drain any post-session/new notifications (current_mode_update etc.)
  // (These are emitted before the response — we let them queue.)
  await new Promise((r) => setImmediate(r));
  const initialNotifications = notifications.length;
  console.log(`  ${initialNotifications} notification(s) received after session/new`);

  // Step 5: session/prompt
  const promptResult = (await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'hello from smoke test' }],
  })) as { stopReason: string };
  // Wait a tick for any trailing notifications.
  await new Promise((r) => setImmediate(r));
  assert(promptResult.stopReason === 'end_turn',
    `stopReason should be 'end_turn', got ${promptResult.stopReason}`);
  const newNotifications = notifications.slice(initialNotifications);
  console.log(`PASS: session/prompt → ${promptResult.stopReason}, ${newNotifications.length} new notification(s) since session/new`);

  // Step 6: session/cancel (just verify the notification is accepted; no
  // session is in flight so this should be a no-op)
  sendNotification('session/cancel', { sessionId });

  // Step 7: exit
  sendNotification('exit', {});

  // Step 8: close stdin and wait for the child to exit
  child.stdin.end();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      assert(code === 0, `server exited with code ${code}`);
      console.log('PASS: server exited cleanly');
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      writeError('TIMEOUT: server did not exit within 5s');
      child.kill();
      process.exit(1);
    }, 5000);
    child.once('exit', (code) => finish(code));
  });

  console.log('\n--- SMOKE TEST PASSED ---');
}

main().catch((err) => {
  writeError(`Smoke test error: ${err instanceof Error ? err.message : String(err)}`);
  child.kill();
  process.exit(1);
});
