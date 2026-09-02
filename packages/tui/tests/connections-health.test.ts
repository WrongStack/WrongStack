import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createChronicleProjectAccess: vi.fn(),
  checkCodebaseIndexServerHealth: vi.fn(),
  getIndexState: vi.fn(),
  resolveProjectIndexDaemonAvailability: vi.fn(() => ({
    kind: 'available',
    url: new URL('file:///dummy.js'),
  })),
  isSageProjectServerAvailable: vi.fn(),
  sageStatus: vi.fn(),
  sageClose: vi.fn(),
  sageState: vi.fn(() => ({ endpoint: 'sage-endpoint' })),
  getKanbanServerConnection: vi.fn(),
  isMailboxProjectServerAvailable: vi.fn(),
  mailboxStatus: vi.fn(),
  mailboxClose: vi.fn(),
  mailboxState: vi.fn(() => ({ endpoint: 'mailbox-endpoint' })),
  resolveWstackPaths: vi.fn(() => ({
    projectDir: 'C:/state/project',
    projectCodebaseIndex: 'C:/state/index',
  })),
}));

vi.mock('@wrongstack/core/chronicle', () => ({
  createChronicleProjectAccess: mocks.createChronicleProjectAccess,
}));

vi.mock('@wrongstack/tools', () => ({
  checkCodebaseIndexServerHealth: mocks.checkCodebaseIndexServerHealth,
  getIndexState: mocks.getIndexState,
  resolveProjectIndexDaemonAvailability: mocks.resolveProjectIndexDaemonAvailability,
}));

vi.mock('@wrongstack/sage', () => ({
  isSageProjectServerAvailable: mocks.isSageProjectServerAvailable,
  SageProjectServerConnection: class {
    status = mocks.sageStatus;
    close = mocks.sageClose;
    getState = mocks.sageState;
  },
}));

vi.mock('@wrongstack/kanban', () => ({
  getKanbanServerConnection: mocks.getKanbanServerConnection,
}));

vi.mock('@wrongstack/core/coordination', () => ({
  isMailboxProjectServerAvailable: mocks.isMailboxProjectServerAvailable,
  MailboxProjectServerConnection: class {
    probeStatus = mocks.mailboxStatus;
    close = mocks.mailboxClose;
    getState = mocks.mailboxState;
  },
}));

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return { ...actual, resolveWstackPaths: mocks.resolveWstackPaths };
});

import { collectConnectionsHealth } from '../src/connections-health.js';

function healthyDefaults() {
  mocks.createChronicleProjectAccess.mockReturnValue({
    mode: 'server',
    call: vi.fn().mockResolvedValue({
      quarantinedFamilies: [],
      pid: 1,
      endpoint: 'chronicle-endpoint',
      chronicleDirectory: 'C:/chronicle',
      uptimeMs: 100,
      clients: 2,
      activeRequests: 1,
      journal: { pendingEvents: 3 },
      watcher: { active: true, watchedFiles: 4 },
    }),
    close: vi.fn(),
  });
  mocks.checkCodebaseIndexServerHealth.mockResolvedValue({
    status: 'healthy',
    latencyMs: 5,
    server: {
      activity: { indexing: false },
      uptimeMs: 100,
      clients: 1,
      activeRequests: 0,
      queuedWrites: 0,
      watchingExternal: true,
      watchingClients: 1,
    },
  });
  mocks.getIndexState.mockReturnValue({
    server: { pid: 2, endpoint: 'index-endpoint', indexDir: 'C:/index' },
  });
  mocks.isSageProjectServerAvailable.mockReturnValue(true);
  mocks.sageStatus.mockResolvedValue({
    pid: 3,
    endpoint: 'sage-endpoint',
    storageRoot: 'C:/sage',
    clients: 1,
    pendingRequests: 0,
    health: { status: 'ready', backend: 'sqlite' },
  });
  mocks.getKanbanServerConnection.mockResolvedValue({
    request: vi.fn().mockResolvedValue({
      protocolVersion: 3,
      pid: 4,
      endpoint: 'kanban-endpoint',
      databasePath: 'C:/kanban.sqlite',
      clients: 1,
      pendingRequests: 0,
      startedAt: new Date(Date.now() - 100).toISOString(),
    }),
  });
  mocks.isMailboxProjectServerAvailable.mockReturnValue(true);
  mocks.mailboxStatus.mockResolvedValue({
    protocolVersion: 3,
    pid: 5,
    endpoint: 'mailbox-endpoint',
    databasePath: 'C:/mailbox.sqlite',
    clients: 1,
    pendingRequests: 0,
    startedAt: new Date(Date.now() - 100).toISOString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WRONGSTACK_KANBAN_SERVER;
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
  healthyDefaults();
});

afterEach(() => {
  delete process.env.WRONGSTACK_KANBAN_SERVER;
});

describe('collectConnectionsHealth', () => {
  it('collects healthy required and optional project services', async () => {
    const report = await collectConnectionsHealth('C:/repo');

    expect(report.checkedAt).toBe(1_000);
    expect(report.overall).toBe('healthy');
    expect(report.services.map((service) => [service.id, service.status])).toEqual([
      ['chronicle', 'healthy'],
      ['codebase-index', 'healthy'],
      ['sage', 'healthy'],
      ['kanban', 'healthy'],
      ['mailbox', 'healthy'],
    ]);
    expect(report.services[0]).toEqual(
      expect.objectContaining({
        queuedWork: 3,
        watcher: { active: true, watchedFiles: 4 },
      }),
    );
    expect(mocks.sageClose).toHaveBeenCalledOnce();
    expect(mocks.mailboxClose).toHaveBeenCalledOnce();
  });

  it('reports degraded Chronicle quarantine, indexing, and SAGE state', async () => {
    mocks.createChronicleProjectAccess.mockReturnValue({
      mode: 'inline',
      call: vi.fn().mockResolvedValue({
        quarantinedFamilies: [{ day: '2026-07-29', reason: 'broken chain' }],
        journal: { pendingEvents: 0 },
        watcher: { active: false, lastError: 'watcher error' },
      }),
      close: vi.fn(),
    });
    mocks.checkCodebaseIndexServerHealth.mockResolvedValue({
      status: 'degraded',
      server: {
        activity: { indexing: true, currentFile: 2, totalFiles: 10 },
        watchingExternal: false,
        watchingClients: 0,
      },
    });
    mocks.getIndexState.mockReturnValue({ server: {} });
    mocks.sageStatus.mockResolvedValue({
      health: { status: 'degraded', backend: 'sqlite' },
      clients: 0,
      pendingRequests: 1,
    });

    const report = await collectConnectionsHealth('C:/repo');
    expect(report.overall).toBe('degraded');
    expect(report.services[0]).toEqual(
      expect.objectContaining({
        status: 'degraded',
        lastError: 'broken chain',
        detail: expect.stringContaining('2026-07-29'),
      }),
    );
    expect(report.services[1]?.detail).toBe('Indexing 2/10.');
    expect(report.services[2]?.status).toBe('degraded');
  });

  it('distinguishes unavailable and on-demand optional services', async () => {
    mocks.isSageProjectServerAvailable.mockReturnValue(false);
    process.env.WRONGSTACK_KANBAN_SERVER = '0';
    mocks.isMailboxProjectServerAvailable.mockReturnValue(false);
    mocks.checkCodebaseIndexServerHealth.mockRejectedValue(
      Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
    );

    const report = await collectConnectionsHealth('C:/repo');
    expect(report.services[1]).toEqual(
      expect.objectContaining({ status: 'offline', mode: 'on-demand project-server' }),
    );
    expect(report.services[2]?.status).toBe('unavailable');
    expect(report.services[3]).toEqual(
      expect.objectContaining({ status: 'unavailable', mode: 'disabled' }),
    );
    expect(report.services[4]?.status).toBe('unavailable');
  });

  it('reports required service failures and always closes connections', async () => {
    mocks.createChronicleProjectAccess.mockReturnValue({
      mode: 'server',
      call: vi.fn().mockRejectedValue('chronicle failed'),
      close: vi.fn(),
    });
    mocks.checkCodebaseIndexServerHealth.mockResolvedValue({
      status: 'unresponsive',
      server: undefined,
    });
    mocks.sageStatus.mockRejectedValue(new Error('sage failed'));
    mocks.getKanbanServerConnection.mockResolvedValue({
      request: vi.fn().mockRejectedValue(new Error('kanban failed')),
    });
    mocks.mailboxStatus.mockRejectedValue(new Error('mailbox failed'));

    const report = await collectConnectionsHealth('C:/repo');
    expect(report.overall).toBe('error');
    expect(report.services.map((service) => service.status)).toEqual([
      'error',
      'error',
      'error',
      'error',
      'error',
    ]);
    expect(report.services[0]?.detail).toBe('chronicle failed');
    expect(mocks.sageClose).toHaveBeenCalledOnce();
    expect(mocks.mailboxClose).toHaveBeenCalledOnce();
  });

  it('handles absent server connections and startup failures', async () => {
    mocks.sageStatus.mockResolvedValue(null);
    mocks.getKanbanServerConnection.mockResolvedValue(null);
    mocks.mailboxStatus.mockResolvedValue(null);

    const offline = await collectConnectionsHealth('C:/repo');
    expect(offline.services[2]).toEqual(
      expect.objectContaining({ status: 'offline', endpoint: 'sage-endpoint' }),
    );
    expect(offline.services[3]).toEqual(
      expect.objectContaining({ status: 'unavailable', mode: 'disabled' }),
    );
    expect(offline.services[4]).toEqual(
      expect.objectContaining({ status: 'offline', endpoint: 'mailbox-endpoint' }),
    );

    healthyDefaults();
    mocks.getKanbanServerConnection.mockRejectedValue(new Error('kanban startup failed'));
    const failed = await collectConnectionsHealth('C:/repo');
    expect(failed.services[3]).toEqual(
      expect.objectContaining({ status: 'error', detail: 'kanban startup failed' }),
    );
  });
});
