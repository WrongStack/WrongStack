/**
 * Overlapping prompts.
 *
 * - ACPSession.prompt() refused a second prompt only once the state was
 *   'prompting', which happens after the first prompt's session/new. Two
 *   prompts overlapping on a fresh session both passed, both sent
 *   session/new (orphaning the first server session) and shared one scratch.
 * - The persistent subagent runner started its shared session once per
 *   concurrent first call, so every agent process but the last leaked past
 *   stop(). Turns on the shared session now also run one at a time.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForProcessExit } from '../../core/tests/helpers/project-server-harness.js';
import { ACPSession } from '../src/client/acp-session.js';
import { makeACPSubagentRunnerWithStop } from '../src/integration/acp-subagent-runner.js';

type Listener = (ev?: unknown) => void;

/** A fake socket that answers like an agent, replying after `delayMs`. */
class AgentWS {
  static last: AgentWS | undefined;
  readonly listeners: Record<string, Listener[]> = {};
  readonly methods: string[] = [];
  sessions = 0;
  constructor() {
    AgentWS.last = this;
    setTimeout(() => this.fire('open'), 0);
  }
  addEventListener(type: string, cb: Listener): void {
    const list = this.listeners[type] ?? [];
    list.push(cb);
    this.listeners[type] = list;
  }
  fire(type: string, ev?: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  close(): void {
    this.fire('close');
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { id?: number; method?: string };
    if (msg.method) this.methods.push(msg.method);
    const reply = (result: unknown) =>
      setTimeout(
        () =>
          this.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) }),
        20,
      );
    if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
    else if (msg.method === 'session/new') reply({ sessionId: `s${++this.sessions}` });
    else if (msg.method === 'session/prompt') reply({ stopReason: 'end_turn' });
  }
}

const realWS = (globalThis as { WebSocket?: unknown }).WebSocket;
beforeEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = AgentWS as never;
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
});

const connect = () =>
  ACPSession.connectWebSocket(
    { url: 'ws://agent.test' },
    { command: 'remote', projectRoot: os.tmpdir(), timeoutMs: 10_000 },
  );
const text = (t: string) => [{ type: 'text' as const, text: t }];

describe('ACPSession overlapping prompts', () => {
  it('refuses a prompt that overlaps the first prompt’s session creation', async () => {
    const session = await connect();
    const outcomes = await Promise.allSettled([
      session.prompt(text('one'), new AbortController().signal),
      session.prompt(text('two'), new AbortController().signal),
    ]);
    expect(outcomes[0]?.status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: { kind: 'protocol_error', message: 'prompt called while another prompt is running' },
    });
    expect(AgentWS.last?.methods.filter((m) => m === 'session/new')).toHaveLength(1);
    // the guard clears: a later prompt runs
    await expect(
      session.prompt(text('three'), new AbortController().signal),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    await session.close();
  });

  it('frees the prompt slot when an abort lands right after session creation', async () => {
    const session = await connect();
    const ac = new AbortController();
    // Land the abort after the creation race settled but before prompt()
    // resumes: a then() registered after prompt() set up its race runs in
    // between. That exit returned without releasing the prompt slot.
    let resolveCreate: (id: string) => void = () => {};
    const create = new Promise<string>((r) => {
      resolveCreate = r;
    });
    (session as unknown as { createSessionWithAuth: () => Promise<string> }).createSessionWithAuth =
      () => create;
    const first = session.prompt(text('one'), ac.signal);
    void create.then(() => ac.abort());
    resolveCreate('s-late');
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' });
    await expect(session.prompt(text('two'), new AbortController().signal)).resolves.toMatchObject({
      stopReason: 'end_turn',
    });
    await session.close();
  });
});

describe('persistent ACP subagent runner', () => {
  let dir = '';
  afterEach(async () => {
    // Windows can hold the exited agent's cwd for a moment.
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('starts one agent for concurrent first calls, runs their turns in turn, and stops it', async () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-persistent-'));
    const pidFile = path.join(dir, 'pids.txt');
    const agent = path.join(dir, 'agent.cjs');
    await fs.writeFile(
      agent,
      [
        `require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');`,
        "const rl = require('node:readline').createInterface({ input: process.stdin });",
        "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
        'let busy = false;',
        "rl.on('line', (line) => {",
        '  const msg = JSON.parse(line);',
        "  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });",
        "  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });",
        "  else if (msg.method === 'session/prompt') {",
        "    const text = busy ? 'overlapped' : 'done';",
        '    busy = true;',
        "    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });",
        "    setTimeout(() => { busy = false; send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); }, 50);",
        '  }',
        '});',
      ].join('\n'),
    );
    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      command: process.execPath,
      args: [agent],
      cwd: dir,
      persistent: true,
    });
    const ctx = () =>
      ({ signal: new AbortController().signal, budget: { markActivity: () => {} } }) as never;
    const results = await Promise.all([
      runner({ id: 'a', description: 'a' } as never, ctx()),
      runner({ id: 'b', description: 'b' } as never, ctx()),
    ]);
    expect(results.map((r) => r.result)).toEqual(['done', 'done']);
    await stop();
    const pids = (await fs.readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(1);
    await expect
      .poll(
        () => {
          try {
            process.kill(pids[0]!, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5_000 },
      )
      .toBe(false);
  }, 30_000);

  it('does not keep a failed shared start: the next call starts again', async () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-persistent-'));
    const okFile = path.join(dir, 'ok');
    const pidFile = path.join(dir, 'failed-start-pids.txt');
    const agent = path.join(dir, 'agent.cjs');
    await fs.writeFile(
      agent,
      [
        `require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');`,
        `if (!require('node:fs').existsSync(${JSON.stringify(okFile)})) process.exit(9);`,
        "const rl = require('node:readline').createInterface({ input: process.stdin });",
        "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
        "rl.on('line', (line) => {",
        '  const msg = JSON.parse(line);',
        "  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });",
        "  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });",
        "  else if (msg.method === 'session/prompt') {",
        "    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
        '  }',
        '});',
      ].join('\n'),
    );
    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      command: process.execPath,
      args: [agent],
      cwd: dir,
      persistent: true,
      timeoutMs: 5_000,
    });
    const ctx = () =>
      ({ signal: new AbortController().signal, budget: { markActivity: () => {} } }) as never;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runner({ id: 'a', description: 'a' } as never, ctx())).rejects.toBeDefined();
      // A start that fails after stop() already dropped it leaves nothing behind.
      const stopped = runner({ id: 'z', description: 'z' } as never, ctx());
      await stop();
      await expect(stopped).rejects.toBeDefined();
      await fs.writeFile(okFile, '');
      await expect(runner({ id: 'b', description: 'b' } as never, ctx())).resolves.toMatchObject({
        result: 'done',
      });
    } finally {
      stderr.mockRestore();
      await stop();
      const pids = (await fs.readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
      await Promise.all(pids.map((pid) => waitForProcessExit(pid)));
    }
  }, 30_000);
});
