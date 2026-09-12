/**
 * The whole approval loop, over a real HQ server and real sockets.
 *
 * Every other test in this feature checks one hop. This one checks that the
 * hops connect: a prompt raised on a host's EventBus reaches a browser
 * attached to HQ, and the answer the browser POSTs travels back down the
 * command queue and settles the resolver the prompt was created with.
 *
 * Worth its runtime because the failure modes here are wiring, not logic — an
 * event type missing from the server's payload guard, a capability the client
 * never advertised, a session stamp that makes the registry refuse its own
 * command. None of those show up in unit tests of either side.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  HQ_AUTH_FILE_VERSION,
  type HqEventEnvelope,
  HqPublisher,
  startApprovalTelemetryBridge,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createHqCommandDispatcher } from '../src/hq-command-controller.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

const BROWSER_TOKEN = 'browser-secret';
const CLIENT_TOKEN = 'client-secret';
const CLIENT_ID = 'machine-1:tui:1:abcdef';
const SESSION_ID = 'sess-e2e';

let handle: HqServerHandle | null = null;
let publisher: HqPublisher | null = null;
let registry: ApprovalRegistry | null = null;
let stopBridge: (() => void) | undefined;
let browser: WebSocket | null = null;
let tempRoot: string;
let port: number;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-approval-e2e-'));
  const dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [
      {
        id: 'browser-1',
        token: BROWSER_TOKEN,
        createdAt: new Date().toISOString(),
        capabilities: ['control.enqueue', 'control.approve'],
      },
    ],
    clientTokens: [
      {
        id: 'client-1',
        token: CLIENT_TOKEN,
        createdAt: new Date().toISOString(),
        capabilities: ['telemetry.publish'],
      },
    ],
  });
  // Auto-assigned rather than a random guess: a collision here would look
  // like an auth failure and send the next reader hunting in the wrong place.
  handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
  port = handle.port;
});

afterEach(async () => {
  stopBridge?.();
  stopBridge = undefined;
  registry?.dispose();
  registry = null;
  publisher?.close();
  publisher = null;
  browser?.close();
  browser = null;
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/** Browser socket that records every `hq.event` envelope it is sent. */
async function attachBrowser(): Promise<HqEventEnvelope[]> {
  const received: HqEventEnvelope[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?token=${BROWSER_TOKEN}`);
  browser = ws;
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as { type: string; event?: HqEventEnvelope };
    if (frame.type === 'hq.event' && frame.event) received.push(frame.event);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser WS open timeout')), 5_000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return received;
}

async function postApprove(
  toolUseId: string,
  decision: string,
  sessionId?: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${BROWSER_TOKEN}`,
    },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      type: 'approve',
      payload: { toolUseId, decision, ...(sessionId ? { sessionId } : {}) },
    }),
  });
  return { status: response.status, body: await response.text() };
}

async function commandAudit(): Promise<
  Array<{ type: string; ackStatus?: string; ackMessage?: string }>
> {
  const response = await fetch(`http://127.0.0.1:${port}/api/commands`, {
    headers: { authorization: `Bearer ${BROWSER_TOKEN}` },
  });
  const body = (await response.json()) as {
    commands: Array<{ type: string; ackStatus?: string; ackMessage?: string }>;
  };
  return body.commands ?? [];
}

/** A host wired the way `setupHqTelemetry` wires the CLI/TUI one. */
function startHost(events: EventBus): void {
  registry = createApprovalRegistry(events);
  const liveRegistry = registry;
  publisher = new HqPublisher({
    url: `ws://127.0.0.1:${port}`,
    token: CLIENT_TOKEN,
    client: {
      clientId: CLIENT_ID,
      kind: 'tui',
      machineId: 'machine-1',
      hostname: 'test-host',
      pid: 1,
      startedAt: new Date().toISOString(),
    },
    project: {
      projectId: 'proj-e2e',
      projectRoot: tempRoot,
      projectName: 'e2e',
      machineId: 'machine-1',
      workspaceKind: 'git',
    },
    capabilities: ['telemetry.publish', 'session.summary', 'control.receive', 'control.approve'],
    commandPollIntervalMs: 50,
    onCommand: createHqCommandDispatcher({
      interruptLeader: () => false,
      sessionTag: () => 'tag-1',
      sessionId: () => SESSION_ID,
      allowRunCommand: () => false,
      resolveApproval: (toolUseId, decision, sessionId) =>
        liveRegistry.resolve(toolUseId, decision, sessionId),
    }),
  });
  stopBridge = startApprovalTelemetryBridge({
    registry: liveRegistry,
    publisher,
    projectRoot: tempRoot,
    sessionId: SESSION_ID,
  });
  publisher.connect();
}

function raisePrompt(
  events: EventBus,
  resolve: (d: 'yes' | 'no' | 'always' | 'deny') => void,
): void {
  events.emit('tool.confirm_needed', {
    sessionId: SESSION_ID,
    tool: { name: 'bash' },
    input: { command: 'rm -rf dist' },
    toolUseId: 'toolu_e2e',
    suggestedPattern: 'bash:rm',
    decisionSource: 'default',
    riskTier: 'destructive',
    writeTargets: ['dist'],
    deadlineAt: Date.now() + 120_000,
    resolve,
  } as never);
}

describe('HQ approval round trip', () => {
  it('carries a prompt to the browser and the answer back to its resolver', async () => {
    const events = new EventBus();
    const received = await attachBrowser();
    startHost(events);
    // The publisher must have said hello before an event can be accepted.
    await expect.poll(() => received.some((e) => e.type === 'client.hello')).toBe(true);

    const resolveSpy = vi.fn();
    raisePrompt(events, resolveSpy);

    // Up: the prompt reaches an operator watching HQ.
    await expect
      .poll(() => received.find((e) => e.type === 'approval.requested'), { timeout: 5_000 })
      .toBeDefined();
    const requested = received.find((e) => e.type === 'approval.requested')!;
    expect(requested.sessionId).toBe(SESSION_ID);
    expect(requested.payload).toMatchObject({
      toolUseId: 'toolu_e2e',
      toolName: 'bash',
      destructive: true,
    });

    // Down: the operator answers, and the tool call that was blocked is
    // released with the decision they picked.
    const response = await postApprove('toolu_e2e', 'always', SESSION_ID);
    expect(response.status).toBe(202);
    await expect.poll(() => resolveSpy.mock.calls.length, { timeout: 5_000 }).toBe(1);
    expect(resolveSpy).toHaveBeenCalledWith('always');
  }, 20_000);

  it('tells the operator when the prompt was already answered at the keyboard', async () => {
    const events = new EventBus();
    const received = await attachBrowser();
    startHost(events);
    await expect.poll(() => received.some((e) => e.type === 'client.hello')).toBe(true);

    const resolveSpy = vi.fn();
    raisePrompt(events, resolveSpy);
    await expect
      .poll(() => received.some((e) => e.type === 'approval.requested'), { timeout: 5_000 })
      .toBe(true);

    // The human at the machine answers first — this is what the run emits.
    events.emit('tool.confirm_resolved', {
      sessionId: SESSION_ID,
      toolUseId: 'toolu_e2e',
      toolName: 'bash',
      decision: 'yes',
      source: 'user',
    } as never);

    // HQ learns the card is gone…
    await expect
      .poll(() => received.some((e) => e.type === 'approval.resolved'), { timeout: 5_000 })
      .toBe(true);

    // …and an answer that was already in flight is refused rather than
    // silently doing nothing. The refusal has to be visible in the audit the
    // operator reads, not just in a return value nobody sees.
    await postApprove('toolu_e2e', 'deny', SESSION_ID);
    await expect
      .poll(async () => (await commandAudit()).find((c) => c.type === 'approve')?.ackStatus, {
        timeout: 5_000,
      })
      .toBe('rejected');
    const rejected = (await commandAudit()).find((c) => c.type === 'approve');
    expect(rejected?.ackMessage).toContain('no longer pending');
    expect(resolveSpy).not.toHaveBeenCalled();
  }, 20_000);
});
