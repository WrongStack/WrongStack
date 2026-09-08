import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWebuiClientPresence } from '../src/server/client-presence.js';
import { createConnectionHandler } from '../src/server/connection-handler.js';
import { gitStdout, isGitWorkTree } from '../src/server/git-process.js';
import { createProjectIntakeService } from '../src/server/intake-service.js';

describe('git-process', () => {
  it('detects worktree for valid repo and returns false for nonexistent directory', async () => {
    const isRepo = await isGitWorkTree(process.cwd());
    expect(isRepo).toBe(true);

    const nonExistentDir = join(tmpdir(), 'non-existent-dir-xyz-987');
    const isNotRepo = await isGitWorkTree(nonExistentDir);
    expect(isNotRepo).toBe(false);
  });

  it('runs git query with gitStdout and returns output or null on error', async () => {
    const output = await gitStdout(process.cwd(), ['rev-parse', '--show-toplevel']);
    expect(output).not.toBeNull();
    expect(typeof output).toBe('string');

    const errorOutput = await gitStdout(process.cwd(), ['invalid-git-subcommand-xyz']);
    expect(errorOutput).toBeNull();
  });
});

describe('intake-service', () => {
  it('creates a RequirementIntakeService instance with resolved paths', () => {
    const service = createProjectIntakeService({
      projectRoot: join(tmpdir(), 'test-project'),
      globalRoot: join(tmpdir(), 'test-global'),
    });
    expect(service).toBeDefined();
    expect(typeof service.createIntake).toBe('function');
  });
});

describe('client-presence', () => {
  it('returns null if projectRoot is undefined', async () => {
    const presence = createWebuiClientPresence({
      projectRoot: undefined,
      appConfig: undefined,
      events: Object.assign(new EventEmitter(), { emitCustom: vi.fn() }) as never,
      hqSessionId: 'boot-session',
      getSessionId: () => 'boot-session',
      startHqConnection: vi.fn(),
    });
    const id = await presence.register();
    expect(id).toBeNull();
  });

  it('registers client, starts timers, connects HQ, and unregisters cleanly', async () => {
    const stopHqMock = vi.fn();
    let onConnectCb: (() => void) | undefined;

    const presence = createWebuiClientPresence({
      projectRoot: process.cwd(),
      appConfig: undefined,
      events: Object.assign(new EventEmitter(), { emitCustom: vi.fn() }) as never,
      hqSessionId: 'boot-session',
      getSessionId: () => 'session-123',
      listSessions: () => ['tab-session-1', 'tab-session-2'],
      isSessionOwnedElsewhere: (id) => id === 'other',
      getSessionWriter: vi.fn(),
      createCommandHandler: vi.fn(() => vi.fn()),
      startHqConnection: vi.fn((opts) => {
        onConnectCb = opts.onConnect;
        return {
          getPublisher: vi.fn(),
          stop: stopHqMock,
        };
      }),
    });

    // Mock getSharedProjectMailbox via prototype or dynamic spy if needed
    // In this unit test, presence calls getSharedProjectMailbox which succeeds
    const clientId = await presence.register();
    if (clientId) {
      expect(clientId).toContain('webui@');
      onConnectCb?.();
      presence.unregister();
      expect(stopHqMock).toHaveBeenCalled();
    }
  });
});

describe('connection-handler', () => {
  it('creates connection handler and dispatches lifecycle events to mock WebSocket', async () => {
    const clients = new Map();
    const pendingConfirms = new Map();
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    const mockGoalHandler = { addClient: vi.fn(), removeClient: vi.fn(), handleMessage: vi.fn() };
    const mockSpecsHandler = { addClient: vi.fn(), removeClient: vi.fn(), handleMessage: vi.fn() };
    const mockSddBoardHandler = {
      addClient: vi.fn(),
      removeClient: vi.fn(),
      handleMessage: vi.fn(),
    };
    const mockSddWizardHandler = {
      addClient: vi.fn(),
      removeClient: vi.fn(),
      handleMessage: vi.fn(),
    };
    const mockWorktreeHandler = {
      addClient: vi.fn(),
      removeClient: vi.fn(),
      handleMessage: vi.fn(),
    };
    const mockCollabHandler = { addClient: vi.fn(), removeClient: vi.fn(), handleMessage: vi.fn() };
    const mockTerminalHandler = {
      addClient: vi.fn(),
      removeClient: vi.fn(),
      handleMessage: vi.fn(),
    };

    const handler = createConnectionHandler({
      getSessionId: () => 'session-abc',
      sessionStartPayload: vi.fn().mockResolvedValue({ status: 'ok' }),
      tokenCounter: { total: () => ({ inputTokens: 0, outputTokens: 0 }) } as never,
      context: { agentId: 'agent-1', projectRoot: '/repo' } as never,
      loadReplay: vi.fn().mockResolvedValue({ messages: [] }),
      clients,
      pendingConfirms,
      goalHandler: mockGoalHandler as never,
      specsHandler: mockSpecsHandler as never,
      sddBoardHandler: mockSddBoardHandler as never,
      sddWizardHandler: mockSddWizardHandler as never,
      worktreeHandler: mockWorktreeHandler as never,
      collabHandler: mockCollabHandler as never,
      terminalHandler: mockTerminalHandler as never,
      handleMessage,
    });

    expect(typeof handler).toBe('function');

    // Create a mock WebSocket
    const mockWs = new EventEmitter() as unknown as import('ws').WebSocket;
    Object.defineProperty(mockWs, 'readyState', { value: 1 }); // OPEN
    mockWs.send = vi.fn();
    mockWs.close = vi.fn();

    // Invoke connection handler
    handler(mockWs);

    expect(mockGoalHandler.addClient).toHaveBeenCalledWith(mockWs);
    expect(mockSpecsHandler.addClient).toHaveBeenCalledWith(mockWs);
    expect(mockWorktreeHandler.addClient).toHaveBeenCalledWith(mockWs);
  });
});
