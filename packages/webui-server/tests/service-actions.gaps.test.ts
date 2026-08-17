import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

// Every daemon family is mocked: these tests drive the orchestration logic
// (guards, confirmation handling, restart verification), not real IPC.
vi.mock('@wrongstack/kanban', () => ({
  closeKanbanServerConnections: vi.fn(),
  getKanbanServerConnection: vi.fn(),
  isKanbanServerAvailable: vi.fn(async () => false),
}));
vi.mock('@wrongstack/sage', () => ({
  isSageProjectServerAvailable: vi.fn(() => false),
  SageProjectServerConnection: vi.fn(),
}));
vi.mock('@wrongstack/core/chronicle', () => ({
  ChronicleProjectServerClient: vi.fn(),
  createChronicleProjectAccess: vi.fn(),
  resolveChronicleProjectServerOptions: vi.fn(() => ({ projectRoot: '/proj', endpoint: 'pipe' })),
}));
vi.mock('@wrongstack/core/coordination', () => ({
  isMailboxProjectServerAvailable: vi.fn(() => false),
  MailboxProjectServerConnection: vi.fn(),
}));
vi.mock('@wrongstack/tools', () => ({
  checkCodebaseIndexServerHealth: vi.fn(),
  ensureCodebaseIndexServer: vi.fn(),
  shutdownCodebaseIndexServer: vi.fn(),
}));

import * as kanban from '@wrongstack/kanban';
import * as sage from '@wrongstack/sage';
import * as chronicle from '@wrongstack/core/chronicle';
import * as coordination from '@wrongstack/core/coordination';
import * as tools from '@wrongstack/tools';
import {
  executeServiceAction,
  handleConnectionsServiceAction,
  killChronicleServer,
  killCodebaseIndexServer,
  killKanbanServer,
  killMailboxServer,
  killSageServer,
  restartKanbanServer,
} from '../src/server/connections/service-actions.js';

const kanbanMock = kanban as unknown as Record<string, ReturnType<typeof vi.fn>>;
const sageMock = sage as unknown as Record<string, ReturnType<typeof vi.fn>>;
const chronicleMock = chronicle as unknown as Record<string, ReturnType<typeof vi.fn>>;
const coordinationMock = coordination as unknown as Record<string, ReturnType<typeof vi.fn>>;
const toolsMock = tools as unknown as Record<string, ReturnType<typeof vi.fn>>;

function allowAllBoundary(): { evaluate: () => Promise<{ kind: string; reason: string }> } {
  return { evaluate: async () => ({ kind: 'allow', reason: 'test' }) };
}

/** A constructable stub whose instances carry the given methods. */
function classStub(methods: Record<string, unknown>): new () => Record<string, unknown> {
  return class {
    constructor() {
      Object.assign(this, { close: vi.fn(), ...methods });
    }
  } as unknown as new () => Record<string, unknown>;
}

function fakeWs(): WebSocket {
  return {} as WebSocket;
}

/** Non-null accessor: noUncheckedIndexedAccess makes Record lookups optional. */
function mockOf(record: Record<string, ReturnType<typeof vi.fn>>, key: string): ReturnType<typeof vi.fn> {
  return record[key] as ReturnType<typeof vi.fn>;
}

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

async function dispatch(
  payload: unknown,
  trustBoundary?: { evaluate: () => Promise<{ kind: string; reason: string }> },
): Promise<{ handled: boolean; sent: Sent[] }> {
  const sent: Sent[] = [];
  const handled = await handleConnectionsServiceAction(fakeWs(), {
    type: 'connections.service_action',
    payload,
  } as never, {
    getProjectRoot: () => '/proj',
    getIndexDir: () => '/idx',
    backend: 'cli-embedded',
    send: (_ws: unknown, message: unknown) => sent.push(message as Sent),
    trustBoundary,
  } as never);
  return { handled, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['WRONGSTACK_KANBAN_SERVER'];
});

afterEach(() => {
  delete process.env['WRONGSTACK_KANBAN_SERVER'];
});

describe('handleConnectionsServiceAction — request guards', () => {
  it('does not claim unrelated messages', async () => {
    const sent: Sent[] = [];
    const handled = await handleConnectionsServiceAction(fakeWs(), {
      type: 'something.else',
    } as never, {
      getProjectRoot: () => '/proj',
      getIndexDir: () => undefined,
      backend: 'cli-embedded',
      send: (_ws: unknown, message: unknown) => sent.push(message as Sent),
    } as never);
    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('rejects payloads without a service id', async () => {
    const { handled, sent } = await dispatch({});
    expect(handled).toBe(true);
    expect((sent[0] as Sent).payload).toMatchObject({
      serviceId: null,
      success: false,
      message: 'Missing serviceId in payload',
    });
  });

  it('defaults to shutdown and rejects unsupported actions', async () => {
    const { sent } = await dispatch({ serviceId: 'kanban', action: 'explode' });
    expect((sent[0] as Sent).payload['message']).toContain(
      'Unsupported action "explode" — only "shutdown" and "restart" are supported',
    );
    expect((sent[0] as Sent).payload['action']).toBe('explode');
  });

  it('refuses to shut down or restart the WebUI transport itself', async () => {
    const shutdown = await dispatch({ serviceId: 'webui', action: 'shutdown' }, allowAllBoundary());
    expect((shutdown.sent[0] as Sent).payload['message']).toBe('Cannot shut down the WebUI transport itself');

    const restart = await dispatch({ serviceId: 'webui', action: 'restart' }, allowAllBoundary());
    expect((restart.sent[0] as Sent).payload['message']).toBe('Cannot restart the WebUI transport itself');
  });

  it('relays a confirmed kanban shutdown through the action result', async () => {
    mockOf(kanbanMock, 'getKanbanServerConnection').mockResolvedValue({
      request: vi.fn(async () => ({ stopping: true })),
    });
    const { handled, sent } = await dispatch({ serviceId: 'kanban', action: 'shutdown' }, allowAllBoundary());
    expect(handled).toBe(true);
    expect((sent[0] as Sent).payload).toMatchObject({
      serviceId: 'kanban',
      action: 'shutdown',
      success: true,
      message: 'Kanban IPC daemon shutdown requested',
    });
  });

  it('relays executor failures as failed results', async () => {
    mockOf(kanbanMock, 'getKanbanServerConnection').mockImplementation(async () => {
      throw new Error('pipe busy');
    });
    const { sent } = await dispatch({ serviceId: 'kanban' }, allowAllBoundary());
    expect((sent[0] as Sent).payload).toMatchObject({
      serviceId: 'kanban',
      action: 'shutdown',
      success: false,
      message: 'pipe busy',
    });
  });
});

describe('executeServiceAction dispatch', () => {
  it('marks governance as read-only and unknown services as unknown', async () => {
    const governance = await executeServiceAction('governance', 'shutdown', '/proj', undefined);
    expect(governance.success).toBe(false);
    expect(governance.message).toContain('Governance health is read-only');

    const unknown = await executeServiceAction('time-machine' as never, 'shutdown', '/proj', undefined);
    expect(unknown.success).toBe(false);
    expect(unknown.message).toBe('Unknown service: time-machine');
  });
});

describe('killKanbanServer', () => {
  it('reports the disabled daemon', async () => {
    process.env['WRONGSTACK_KANBAN_SERVER'] = '0';
    const out = await killKanbanServer('/proj', 'shutdown');
    expect(out).toMatchObject({
      serviceId: 'kanban',
      success: false,
      message: 'Kanban IPC daemon is disabled via WRONGSTACK_KANBAN_SERVER=0',
    });
  });

  it('reports a daemon that is not running', async () => {
    mockOf(kanbanMock, 'getKanbanServerConnection').mockResolvedValue(null);
    const out = await killKanbanServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Kanban IPC daemon is not running');
  });

  it('fails when the daemon does not confirm the shutdown', async () => {
    mockOf(kanbanMock, 'getKanbanServerConnection').mockResolvedValue({
      request: vi.fn(async () => ({ stopping: false })),
    });
    const out = await killKanbanServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Kanban IPC daemon shutdown failed (not confirmed)');
  });

  it('restarts after a confirmed shutdown', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'shutdown' ? { stopping: true } : {},
    );
    mockOf(kanbanMock, 'getKanbanServerConnection').mockResolvedValue({ request });
    const out = await killKanbanServer('/proj', 'restart');
    expect(out).toMatchObject({
      serviceId: 'kanban',
      action: 'restart',
      success: true,
      message: 'Kanban IPC daemon restarted successfully',
    });
    expect(mockOf(kanbanMock, 'closeKanbanServerConnections')).toHaveBeenCalled();
  });

  it('reports restart failure when no connection comes back', async () => {
    let call = 0;
    mockOf(kanbanMock, 'getKanbanServerConnection').mockImplementation(async () => {
      call += 1;
      return call === 1 ? { request: vi.fn(async () => ({ stopping: true })) } : null;
    });
    const out = await killKanbanServer('/proj', 'restart');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Kanban IPC daemon failed to restart (no connection after re-init)');
  });

  it('reports restart verification failures', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'shutdown') return { stopping: true };
      throw new Error('ping timeout');
    });
    mockOf(kanbanMock, 'getKanbanServerConnection').mockResolvedValue({ request });
    const out = await killKanbanServer('/proj', 'restart');
    expect(out.success).toBe(false);
    expect(out.message).toContain('verification failed: ping timeout');
  });

  it('restartKanbanServer succeeds when the ping answers', async () => {
    mockOf(kanbanMock, 'getKanbanServerConnection').mockResolvedValue({
      request: vi.fn(async () => ({})),
    });
    const out = await restartKanbanServer('/proj');
    expect(out.success).toBe(true);
  });
});

describe('killSageServer', () => {
  it('reports an unavailable runtime', async () => {
    mockOf(sageMock, 'isSageProjectServerAvailable').mockReturnValue(false);
    const out = await killSageServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('SAGE project server is unavailable in this runtime');
  });

  function sageConnection(methods: Record<string, unknown>) {
    mockOf(sageMock, 'isSageProjectServerAvailable').mockReturnValue(true);
    (mockOf(sageMock, 'SageProjectServerConnection') as unknown as { mockImplementation: (impl: unknown) => void }).mockImplementation(
      classStub(methods) as never,
    );
  }

  it('fails when the server does not confirm the shutdown', async () => {
    sageConnection({ shutdown: vi.fn(async () => ({ stopped: false, reason: 'busy' })) });
    const out = await killSageServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('SAGE memory server shutdown failed: busy');
  });

  it('shuts down and restarts the SAGE server', async () => {
    sageConnection({
      shutdown: vi.fn(async () => ({ stopped: true })),
      status: vi.fn(async () => null),
      call: vi.fn(async () => ({})),
    });
    const shutdown = await killSageServer('/proj', 'shutdown');
    expect(shutdown).toMatchObject({ success: true, message: 'SAGE memory server shutdown requested' });

    const restart = await killSageServer('/proj', 'restart');
    expect(restart).toMatchObject({
      success: true,
      message: 'SAGE memory server restarted successfully',
    });
  });

  it('reports restart verification failures', async () => {
    sageConnection({
      shutdown: vi.fn(async () => ({ stopped: true })),
      status: vi.fn(async () => null),
      call: vi.fn(async () => {
        throw new Error('no pong');
      }),
    });
    const out = await killSageServer('/proj', 'restart');
    expect(out.success).toBe(false);
    expect(out.message).toContain('verification failed: no pong');
  });

  it('wraps connection errors', async () => {
    sageConnection({
      shutdown: vi.fn(async () => {
        throw new Error('socket gone');
      }),
    });
    const out = await killSageServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('socket gone');
  });
});

describe('killChronicleServer', () => {
  function chronicleClient(methods: Record<string, unknown>) {
    (mockOf(chronicleMock, 'ChronicleProjectServerClient') as unknown as { mockImplementation: (impl: unknown) => void }).mockImplementation(
      classStub({ endpoint: 'pipe', ...methods }) as never,
    );
  }

  it('fails when the server does not confirm the shutdown', async () => {
    chronicleClient({ shutdown: vi.fn(async () => ({ stopped: false, reason: 'locked' })) });
    const out = await killChronicleServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Chronicle telemetry server shutdown failed: locked');
  });

  it('requests the shutdown', async () => {
    chronicleClient({ shutdown: vi.fn(async () => ({ stopped: true })) });
    const out = await killChronicleServer('/proj', 'shutdown');
    expect(out).toMatchObject({
      success: true,
      message: 'Chronicle telemetry server shutdown requested',
    });
  });

  it('restarts and verifies the server mode', async () => {
    chronicleClient({ shutdown: vi.fn(async () => ({ stopped: true })) });
    mockOf(chronicleMock, 'createChronicleProjectAccess').mockReturnValue({
      mode: 'server',
      call: vi.fn(async () => ({})),
      close: vi.fn(async () => {}),
    });
    const out = await killChronicleServer('/proj', 'restart');
    expect(out).toMatchObject({
      success: true,
      message: 'Chronicle telemetry server restarted successfully',
    });
  });

  it('rejects a restart that lands in the wrong mode', async () => {
    chronicleClient({ shutdown: vi.fn(async () => ({ stopped: true })) });
    mockOf(chronicleMock, 'createChronicleProjectAccess').mockReturnValue({
      mode: 'embedded',
      call: vi.fn(async () => ({})),
      close: vi.fn(async () => {}),
    });
    const out = await killChronicleServer('/proj', 'restart');
    expect(out.success).toBe(false);
    expect(out.message).toContain('running in embedded mode (expected server)');
  });

  it('reports restart verification failures', async () => {
    chronicleClient({ shutdown: vi.fn(async () => ({ stopped: true })) });
    mockOf(chronicleMock, 'createChronicleProjectAccess').mockReturnValue({
      mode: 'server',
      call: vi.fn(async () => {
        throw new Error('ping dropped');
      }),
      close: vi.fn(async () => {}),
    });
    const out = await killChronicleServer('/proj', 'restart');
    expect(out.success).toBe(false);
    expect(out.message).toContain('verification failed: ping dropped');
  });
});

describe('killCodebaseIndexServer', () => {
  it('fails when the shutdown is not confirmed', async () => {
    mockOf(toolsMock, 'shutdownCodebaseIndexServer').mockResolvedValue({ stopped: false, reason: 'busy' });
    const out = await killCodebaseIndexServer('/proj', undefined, 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Codebase index server shutdown failed: busy');
  });

  it('requests the shutdown', async () => {
    mockOf(toolsMock, 'shutdownCodebaseIndexServer').mockResolvedValue({ stopped: true });
    const out = await killCodebaseIndexServer('/proj', '/idx', 'shutdown');
    expect(out).toMatchObject({
      success: true,
      message: 'Codebase index server shutdown requested',
    });
    expect(mockOf(toolsMock, 'shutdownCodebaseIndexServer')).toHaveBeenCalledWith(
      '/proj',
      '/idx',
      'websocket-request:shutdown',
    );
  });

  it('restarts and verifies health', async () => {
    mockOf(toolsMock, 'shutdownCodebaseIndexServer').mockResolvedValue({ stopped: true });
    mockOf(toolsMock, 'checkCodebaseIndexServerHealth').mockResolvedValue({ status: 'ok' });
    const out = await killCodebaseIndexServer('/proj', undefined, 'restart');
    expect(out).toMatchObject({
      success: true,
      message: 'Codebase index server restarted successfully',
    });
    expect(mockOf(toolsMock, 'ensureCodebaseIndexServer')).toHaveBeenCalledWith({
      projectRoot: '/proj',
      indexDir: undefined,
    });
  });

  it('rejects an unresponsive restart', async () => {
    mockOf(toolsMock, 'shutdownCodebaseIndexServer').mockResolvedValue({ stopped: true });
    mockOf(toolsMock, 'checkCodebaseIndexServerHealth').mockResolvedValue({ status: 'unresponsive' });
    const out = await killCodebaseIndexServer('/proj', undefined, 'restart');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Codebase index server restarted but is unresponsive');
  });

  it('wraps executor errors', async () => {
    mockOf(toolsMock, 'shutdownCodebaseIndexServer').mockRejectedValue(new Error('spawn failed'));
    const out = await killCodebaseIndexServer('/proj', undefined, 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('spawn failed');
  });
});

describe('killMailboxServer', () => {
  it('reports an unavailable runtime', async () => {
    mockOf(coordinationMock, 'isMailboxProjectServerAvailable').mockReturnValue(false);
    const out = await killMailboxServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Mailbox project server is unavailable in this runtime');
  });

  function mailboxConnection(methods: Record<string, unknown>) {
    mockOf(coordinationMock, 'isMailboxProjectServerAvailable').mockReturnValue(true);
    (mockOf(coordinationMock, 'MailboxProjectServerConnection') as unknown as { mockImplementation: (impl: unknown) => void }).mockImplementation(
      classStub({ probeStatus: vi.fn(async () => null), ...methods }) as never,
    );
  }

  it('fails when the shutdown is not confirmed', async () => {
    mailboxConnection({ shutdown: vi.fn(async () => ({ stopped: false, reason: 'busy' })) });
    const out = await killMailboxServer('/proj', 'shutdown');
    expect(out.success).toBe(false);
    expect(out.message).toBe('Mailbox IPC server shutdown failed: busy');
  });

  it('shuts down and restarts the mailbox server', async () => {
    mailboxConnection({
      shutdown: vi.fn(async () => ({ stopped: true })),
      call: vi.fn(async () => ({})),
    });
    const shutdown = await killMailboxServer('/proj', 'shutdown');
    expect(shutdown).toMatchObject({
      success: true,
      message: 'Mailbox IPC server shutdown requested',
    });

    const restart = await killMailboxServer('/proj', 'restart');
    expect(restart).toMatchObject({
      success: true,
      message: 'Mailbox IPC server restarted successfully',
    });
  });

  it('reports restart verification failures', async () => {
    mailboxConnection({
      shutdown: vi.fn(async () => ({ stopped: true })),
      call: vi.fn(async () => {
        throw new Error('silent pipe');
      }),
    });
    const out = await killMailboxServer('/proj', 'restart');
    expect(out.success).toBe(false);
    expect(out.message).toContain('verification failed: silent pipe');
  });
});
