/**
 * The standalone engine (desktop) used to be publish-only toward HQ: the boot session's
 * telemetry, no control capability, no mirrored approvals and no mailbox client. These tests
 * pin the presence it now registers — the same one the CLI-hosted WebUI uses.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startHqHostConnection = vi.hoisted(() => vi.fn());
const registerClient = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const deregisterClient = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@wrongstack/runtime/hq-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/runtime/hq-host')>()),
  startHqHostConnection,
}));
vi.mock('@wrongstack/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/coordination')>()),
  resolveProjectDir: () => '/tmp/proj-dir',
  getSharedProjectMailbox: vi.fn(() => ({
    send: vi.fn().mockResolvedValue(undefined),
    registerClient,
    clientHeartbeat: vi.fn().mockResolvedValue(undefined),
    deregisterClient,
  })),
}));
vi.mock('@wrongstack/core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/utils')>()),
  wstackGlobalRoot: () => '/tmp/global',
}));

import { startStandaloneHqPresence } from '../src/server/standalone-hq-presence.js';

type Command = { commandId: string; type: string; payload: Record<string, unknown> };
type ConnectionOptions = {
  clientKind: string;
  capabilities: string[];
  onCommand: (command: Command) => Promise<{ status: string; message?: string }>;
  onConnect: (publisher: unknown) => void;
  getAppConfig: () => unknown;
  socketFactory: unknown;
};

function fakePublisher() {
  const known: Record<string, unknown> = {
    project: { projectId: 'p', projectRoot: '/tmp/proj', projectName: 'proj' },
    identity: { clientId: 'c' },
    redactionPolicy: undefined,
  };
  return new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : vi.fn(() => () => {})),
  });
}

let presence: ReturnType<typeof startStandaloneHqPresence> | undefined;
beforeEach(() => {
  startHqHostConnection.mockReset();
  startHqHostConnection.mockImplementation((options: ConnectionOptions) => {
    const publisher = fakePublisher();
    options.onConnect(publisher);
    return { getPublisher: () => publisher, getKanbanSyncStats: () => undefined, stop: vi.fn() };
  });
  registerClient.mockClear();
});
afterEach(() => {
  presence?.dispose();
  presence = undefined;
});

function start(overrides: Partial<Parameters<typeof startStandaloneHqPresence>[0]> = {}) {
  const events = new EventBus();
  const running = new Set(['tab-2']);
  const abortRun = vi.fn((id: string) => running.delete(id));
  const onPublisher = vi.fn();
  const config = { provider: 'p', model: 'm', hq: { enabled: true } };
  presence = startStandaloneHqPresence({
    projectRoot: '/tmp/proj',
    getConfig: () => config as never,
    events,
    bootSessionId: 'boot',
    getSessionId: () => 'tab-2',
    clients: new Map([
      [{} as never, { sessionId: 'tab-2', sessionIds: new Set(['tab-3']) } as never],
    ]),
    isRunning: (id) => running.has(id),
    abortRun,
    ownsSession: (id) => id === 'tab-2' || id === 'tab-3',
    getSessionWriter: () => undefined,
    onPublisher,
    ...overrides,
  });
  const options = startHqHostConnection.mock.calls[0]?.[0] as ConnectionOptions;
  return { events, abortRun, onPublisher, options, config };
}

describe('standalone engine HQ presence', () => {
  it('registers as a controllable WebUI client on the live config', async () => {
    const { options, onPublisher, config } = start();
    expect(options.clientKind).toBe('webui');
    expect(options.capabilities).toEqual(
      expect.arrayContaining(['control.receive', 'control.approve', 'session.summary']),
    );
    expect(options.getAppConfig()).toBe(config);
    expect(typeof options.socketFactory).toBe('function');
    // The engine-wide bridges (session identity) follow this connection's publisher.
    expect(onPublisher).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.anything() }),
    );
    await vi.waitFor(() =>
      expect(registerClient).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'webui', sessionId: 'tab-2' }),
      ),
    );
  });

  it('interrupts the conversation the command names, and refuses one it does not hold', async () => {
    const { options, abortRun } = start();
    const stopped = await options.onCommand({
      commandId: 'c1',
      type: 'abort',
      payload: { target: 'leader', sessionId: 'tab-2' },
    });
    expect(stopped.status).toBe('completed');
    expect(abortRun).toHaveBeenCalledWith('tab-2');

    const foreign = await options.onCommand({
      commandId: 'c2',
      type: 'abort',
      payload: { target: 'leader', sessionId: 'elsewhere' },
    });
    expect(foreign.status).toBe('rejected');
    expect(abortRun).toHaveBeenCalledTimes(1);
  });

  it('answers a permission prompt raised in a desktop conversation', async () => {
    const { options, events } = start();
    const resolve = vi.fn();
    events.emit('tool.confirm_needed', {
      toolUseId: 'tu-1',
      tool: { name: 'write' },
      input: {},
      sessionId: 'tab-2',
      resolve,
    } as never);

    const result = await options.onCommand({
      commandId: 'c3',
      type: 'approve',
      payload: { toolUseId: 'tu-1', decision: 'yes', sessionId: 'tab-2' },
    });

    expect(result.status).toBe('completed');
    expect(resolve).toHaveBeenCalledWith('yes');
  });

  it('keeps run-command refused, and has no fleet to steer without one', async () => {
    const { options } = start();
    const run = await options.onCommand({
      commandId: 'c4',
      type: 'run-command',
      payload: { command: 'echo hi' },
    });
    expect(run.status).toBe('rejected');
    const fleet = await options.onCommand({
      commandId: 'c5',
      type: 'abort',
      payload: { target: 'fleet', sessionId: 'tab-2' },
    });
    expect(fleet.status).toBe('rejected');
  });

  it('stops the named conversation’s fleet through the engine’s director', async () => {
    const director = {
      subagentIdsForSession: vi.fn(() => ['w1']),
      terminateSession: vi.fn(async () => undefined),
    };
    const { options } = start({ getDirector: () => director as never });
    const result = await options.onCommand({
      commandId: 'c6',
      type: 'abort',
      payload: { target: 'fleet', sessionId: 'tab-3' },
    });
    expect(result.status).toBe('completed');
    expect(director.terminateSession).toHaveBeenCalledWith('tab-3');
  });

  it('unbinds the publisher and re-registers under a switched project', () => {
    const { onPublisher } = start();
    presence?.switchProject('/tmp/other');
    expect(onPublisher).toHaveBeenLastCalledWith(expect.anything());
    expect(onPublisher).toHaveBeenCalledWith(undefined);
    expect(startHqHostConnection).toHaveBeenCalledTimes(2);
    expect(startHqHostConnection.mock.calls[1]?.[0]).toMatchObject({ projectRoot: '/tmp/other' });
  });
});
