import { WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionCatalogShutdown: vi.fn(),
  sessionCatalogCallExisting: vi.fn(),
  sessionCatalogPing: vi.fn(),
  sessionCatalogClose: vi.fn(),
  chronicleShutdown: vi.fn(),
  chronicleClose: vi.fn(),
  createChronicleProjectAccess: vi.fn(),
  kanbanRequest: vi.fn(),
  getKanbanServerConnection: vi.fn(),
  closeKanbanServerConnections: vi.fn(),
  isKanbanServerAvailable: vi.fn(),
  sageShutdown: vi.fn(),
  sageStatus: vi.fn(),
  sageCall: vi.fn(),
  sageClose: vi.fn(),
  isSageProjectServerAvailable: vi.fn(),
  mailboxShutdown: vi.fn(),
  mailboxProbeStatus: vi.fn(),
  mailboxCall: vi.fn(),
  mailboxClose: vi.fn(),
  isMailboxProjectServerAvailable: vi.fn(),
  shutdownCodebaseIndexServer: vi.fn(),
  ensureCodebaseIndexServer: vi.fn(),
  checkCodebaseIndexServerHealth: vi.fn(),
  resolveWstackPaths: vi.fn(() => ({
    projectDir: 'C:/state/project',
    projectCodebaseIndex: 'C:/state/index',
  })),
}));

vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    createConnection: vi.fn(() => {
      const emitter = new EventEmitter();
      queueMicrotask(() => emitter.emit('error', new Error('ECONNREFUSED')));
      return {
        destroy: vi.fn(),
        once: emitter.once.bind(emitter),
        unref: vi.fn(),
      };
    }),
  };
});

vi.mock('@wrongstack/core/session-catalog', () => ({
  SessionCatalogProjectClient: class {
    shutdown = mocks.sessionCatalogShutdown;
    callExisting = mocks.sessionCatalogCallExisting;
    ping = mocks.sessionCatalogPing;
    close = mocks.sessionCatalogClose;
  },
}));

vi.mock('@wrongstack/core/chronicle', () => ({
  ChronicleProjectServerClient: class {
    endpoint = 'chronicle-endpoint';
    shutdown = mocks.chronicleShutdown;
    close = mocks.chronicleClose;
  },
  createChronicleProjectAccess: mocks.createChronicleProjectAccess,
  resolveChronicleProjectServerOptions: () => ({ projectDir: 'C:/state/chronicle' }),
}));

vi.mock('@wrongstack/kanban', () => ({
  getKanbanServerConnection: mocks.getKanbanServerConnection,
  closeKanbanServerConnections: mocks.closeKanbanServerConnections,
  isKanbanServerAvailable: mocks.isKanbanServerAvailable,
}));

vi.mock('@wrongstack/sage', () => ({
  isSageProjectServerAvailable: mocks.isSageProjectServerAvailable,
  SageProjectServerConnection: class {
    shutdown = mocks.sageShutdown;
    status = mocks.sageStatus;
    call = mocks.sageCall;
    close = mocks.sageClose;
  },
}));

vi.mock('@wrongstack/core/coordination', () => ({
  isMailboxProjectServerAvailable: mocks.isMailboxProjectServerAvailable,
  MailboxProjectServerConnection: class {
    shutdown = mocks.mailboxShutdown;
    probeStatus = mocks.mailboxProbeStatus;
    call = mocks.mailboxCall;
    close = mocks.mailboxClose;
  },
}));

vi.mock('@wrongstack/tools', () => ({
  shutdownCodebaseIndexServer: mocks.shutdownCodebaseIndexServer,
  ensureCodebaseIndexServer: mocks.ensureCodebaseIndexServer,
  checkCodebaseIndexServerHealth: mocks.checkCodebaseIndexServerHealth,
}));

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    resolveWstackPaths: mocks.resolveWstackPaths,
  };
});

import { executeServiceAction } from '../../webui-server/src/server/connections/service-actions.js';
import {
  executeConnectionAction,
  isRestartableService,
  RESTARTABLE_SERVICES,
  restartAllConnectionServices,
} from '../src/connection-actions.js';

describe('connection-actions', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WRONGSTACK_KANBAN_SERVER;
  });

  it('identifies restartable services correctly', () => {
    expect(isRestartableService('session-catalog')).toBe(true);
    expect(isRestartableService('chronicle')).toBe(true);
    expect(isRestartableService('codebase-index')).toBe(true);
    expect(isRestartableService('sage')).toBe(true);
    expect(isRestartableService('kanban')).toBe(true);
    expect(isRestartableService('mailbox')).toBe(true);
    expect(isRestartableService('governance')).toBe(false);
    expect(RESTARTABLE_SERVICES).toHaveLength(6);
  });

  it('reports read-only status for governance restart', async () => {
    const result = await executeConnectionAction('governance', 'restart', 'C:/repo');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Governance control plane is read-only');
  });

  it('restarts session-catalog daemon successfully', async () => {
    mocks.sessionCatalogCallExisting
      .mockResolvedValueOnce({ pid: 100 })
      .mockRejectedValueOnce(new Error('offline'));
    mocks.sessionCatalogShutdown.mockResolvedValue({ stopped: true });
    mocks.sessionCatalogPing.mockResolvedValue({
      pid: 101,
      runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
    });
    mocks.sessionCatalogClose.mockResolvedValue(undefined);

    const result = await executeConnectionAction('session-catalog', 'restart', 'C:/repo');
    expect(result.success).toBe(true);
    expect(result.message).toContain('restarted successfully');
    expect(mocks.sessionCatalogShutdown).toHaveBeenCalled();
    expect(mocks.sessionCatalogPing).toHaveBeenCalled();
  });

  it.each(['0.0.1', undefined])(
    'rejects a replacement catalog with version %s',
    async (runtimeVersion) => {
      mocks.sessionCatalogCallExisting
        .mockResolvedValueOnce({ pid: 100 })
        .mockRejectedValue(new Error('offline'));
      mocks.sessionCatalogShutdown.mockResolvedValue({ stopped: true });
      mocks.sessionCatalogPing.mockResolvedValue({ pid: 101, runtimeVersion });
      mocks.sessionCatalogClose.mockResolvedValue(undefined);
      const result = await executeConnectionAction('session-catalog', 'restart', 'C:/repo');
      expect(result.success).toBe(false);
      expect(result.message).toContain('version');
    },
  );

  it('restarts kanban server successfully', async () => {
    const conn = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ stopping: true })
        .mockResolvedValueOnce({ pong: true, runtimeVersion: WRONGSTACK_RUNTIME_VERSION }),
    };
    mocks.getKanbanServerConnection.mockResolvedValue(conn);
    mocks.isKanbanServerAvailable.mockResolvedValue(false);

    const result = await executeConnectionAction('kanban', 'restart', 'C:/repo');
    expect(result.success).toBe(true);
    expect(result.message).toContain('restarted successfully');
    expect(mocks.closeKanbanServerConnections).toHaveBeenCalled();
  });

  it('does not report a restart when the old Kanban owner never stops', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({
      stopping: true,
      pong: true,
      runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
    });
    mocks.getKanbanServerConnection.mockResolvedValue({ request });
    mocks.isKanbanServerAvailable.mockResolvedValue(true);
    const pending = executeConnectionAction('kanban', 'restart', 'C:/repo');
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.message).toContain('did not stop');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not call a degraded index health response a successful restart', async () => {
    mocks.shutdownCodebaseIndexServer.mockResolvedValue({ stopped: true });
    mocks.ensureCodebaseIndexServer.mockResolvedValue(undefined);
    mocks.checkCodebaseIndexServerHealth
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ status: 'degraded' });
    const result = await executeConnectionAction('codebase-index', 'restart', 'C:/repo');
    expect(result.success).toBe(false);
    expect(result.message).toContain('degraded');
  });

  it('restarts sage server successfully', async () => {
    mocks.isSageProjectServerAvailable.mockReturnValue(true);
    mocks.sageShutdown.mockResolvedValue({ stopped: true });
    mocks.sageStatus.mockResolvedValue(null);
    mocks.sageCall.mockResolvedValue({ pong: true, runtimeVersion: WRONGSTACK_RUNTIME_VERSION });

    const result = await executeConnectionAction('sage', 'restart', 'C:/repo');
    expect(result.success).toBe(true);
    expect(result.message).toContain('restarted successfully');
    expect(mocks.sageShutdown).toHaveBeenCalled();
  });

  it('restarts chronicle server successfully', async () => {
    mocks.chronicleShutdown.mockResolvedValue({ stopped: true });
    const accessMock = {
      mode: 'server',
      call: vi.fn().mockResolvedValue({ pong: true, runtimeVersion: WRONGSTACK_RUNTIME_VERSION }),
      close: vi.fn(),
    };
    mocks.createChronicleProjectAccess.mockReturnValue(accessMock);

    const result = await executeConnectionAction('chronicle', 'restart', 'C:/repo');
    expect(result.success).toBe(true);
    expect(result.message).toContain('restarted successfully');
  });

  it('restarts codebase-index server successfully', async () => {
    mocks.shutdownCodebaseIndexServer.mockResolvedValue({ stopped: true });
    mocks.ensureCodebaseIndexServer.mockResolvedValue(undefined);
    mocks.checkCodebaseIndexServerHealth
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        status: 'healthy',
        server: { runtimeVersion: WRONGSTACK_RUNTIME_VERSION },
      });

    const result = await executeConnectionAction('codebase-index', 'restart', 'C:/repo');
    expect(result.success).toBe(true);
    expect(result.message).toContain('restarted successfully');
  });

  it('restarts mailbox server successfully', async () => {
    mocks.isMailboxProjectServerAvailable.mockReturnValue(true);
    mocks.mailboxShutdown.mockResolvedValue({ stopped: true });
    mocks.mailboxProbeStatus.mockResolvedValue(null);
    mocks.mailboxCall.mockResolvedValue({ pong: true, runtimeVersion: WRONGSTACK_RUNTIME_VERSION });

    const result = await executeConnectionAction('mailbox', 'restart', 'C:/repo');
    expect(result.success).toBe(true);
    expect(result.message).toContain('restarted successfully');
  });

  it('restarts all restartable services via restartAllConnectionServices', async () => {
    // First call reads the pre-restart PID; every later call is the shutdown
    // probe. A probe that keeps reporting "up" makes waitForShutdown spin its
    // full 3s deadline, so the service must be seen going down — same shape as
    // the single-service tests above.
    mocks.sessionCatalogCallExisting
      .mockResolvedValueOnce({ pid: 100 })
      .mockRejectedValue(new Error('offline'));
    mocks.sessionCatalogShutdown.mockResolvedValue({ stopped: true });
    mocks.sessionCatalogPing.mockResolvedValue({
      pid: 101,
      runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
    });
    mocks.sessionCatalogClose.mockResolvedValue(undefined);

    const conn = {
      request: vi.fn().mockResolvedValue({
        stopping: true,
        pong: true,
        runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
      }),
    };
    mocks.getKanbanServerConnection.mockResolvedValue(conn);
    mocks.isKanbanServerAvailable.mockResolvedValue(false);

    mocks.isSageProjectServerAvailable.mockReturnValue(true);
    mocks.sageShutdown.mockResolvedValue({ stopped: true });
    mocks.sageStatus.mockResolvedValue(null);
    mocks.sageCall.mockResolvedValue({ pong: true, runtimeVersion: WRONGSTACK_RUNTIME_VERSION });

    mocks.chronicleShutdown.mockResolvedValue({ stopped: true });
    mocks.createChronicleProjectAccess.mockReturnValue({
      mode: 'server',
      call: vi.fn().mockResolvedValue({ pong: true, runtimeVersion: WRONGSTACK_RUNTIME_VERSION }),
      close: vi.fn(),
    });

    mocks.shutdownCodebaseIndexServer.mockResolvedValue({ stopped: true });
    mocks.ensureCodebaseIndexServer.mockResolvedValue(undefined);
    // Down for the shutdown probe, healthy for the post-restart verification.
    mocks.checkCodebaseIndexServerHealth
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        status: 'healthy',
        server: { runtimeVersion: WRONGSTACK_RUNTIME_VERSION },
      });

    mocks.isMailboxProjectServerAvailable.mockReturnValue(true);
    mocks.mailboxShutdown.mockResolvedValue({ stopped: true });
    mocks.mailboxProbeStatus.mockResolvedValue(null);
    mocks.mailboxCall.mockResolvedValue({ pong: true, runtimeVersion: WRONGSTACK_RUNTIME_VERSION });

    const results = await restartAllConnectionServices('C:/repo');
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.success)).toBe(true);

    mocks.resolveWstackPaths.mockImplementationOnce(() => {
      throw new Error('Invalid project state');
    });
    mocks.checkCodebaseIndexServerHealth.mockRejectedValueOnce(new Error('offline'));
    const retried = await restartAllConnectionServices('C:/repo');
    expect(retried).toHaveLength(6);
    expect(retried[0]).toMatchObject({ success: false, message: 'Invalid project state' });
    expect(retried.slice(1).every((result) => result.success)).toBe(true);
  });
});

describe.each([
  ['TUI', executeConnectionAction],
  ['WebUI', executeServiceAction],
] as const)('%s replacement version verification', (_surface, execute) => {
  it.each(RESTARTABLE_SERVICES)('rejects an old %s daemon after restart', async (serviceId) => {
    const health = { pid: 101, runtimeVersion: '0.0.1' };
    mocks.sessionCatalogCallExisting.mockReset().mockRejectedValue(new Error('offline'));
    mocks.sessionCatalogShutdown.mockResolvedValue({ stopped: true });
    mocks.sessionCatalogPing.mockResolvedValue(health);
    mocks.sessionCatalogClose.mockResolvedValue(undefined);
    mocks.getKanbanServerConnection.mockResolvedValue({
      request: vi.fn(async (method) => (method === 'shutdown' ? { stopping: true } : health)),
    });
    mocks.isKanbanServerAvailable.mockResolvedValue(false);
    mocks.isSageProjectServerAvailable.mockReturnValue(true);
    mocks.sageShutdown.mockResolvedValue({ stopped: true });
    mocks.sageStatus.mockResolvedValue(null);
    mocks.sageCall.mockResolvedValue(health);
    mocks.chronicleShutdown.mockResolvedValue({ stopped: true });
    mocks.createChronicleProjectAccess.mockReturnValue({
      mode: 'server',
      call: vi.fn(async () => health),
      close: vi.fn(),
    });
    mocks.shutdownCodebaseIndexServer.mockResolvedValue({ stopped: true });
    mocks.ensureCodebaseIndexServer.mockResolvedValue(undefined);
    mocks.checkCodebaseIndexServerHealth
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ status: 'healthy', server: health });
    mocks.isMailboxProjectServerAvailable.mockReturnValue(true);
    mocks.mailboxShutdown.mockResolvedValue({ stopped: true });
    mocks.mailboxProbeStatus.mockResolvedValue(null);
    mocks.mailboxCall.mockResolvedValue(health);
    const result = await execute(serviceId, 'restart', 'C:/repo', undefined);
    expect(result.success).toBe(false);
    expect(result.message).toContain('version 0.0.1');
    expect(result.message).toContain(`expected ${WRONGSTACK_RUNTIME_VERSION}`);
  });
});
