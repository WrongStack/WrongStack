import { EventEmitter } from 'node:events';
import { Container, TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultContainer } from '../src/container.js';
import { makeLightSubagentFactory } from '../src/fleet/light-subagent-factory.js';
import {
  bootstrapGovernanceRuntime,
  bootstrapGovernanceRuntimeWithFactory,
  readGovernanceDaemonOperatorStatus,
  readGovernanceDaemonOperatorStatusWithDependencies,
} from '../src/governance-bootstrap.js';
import {
  createGovernanceMutationSnapshotBridge,
  MAX_PENDING_GOVERNANCE_MUTATION_SNAPSHOTS,
} from '../src/governance-mutation-snapshot-bridge.js';
import { sanitizeGovernanceMessage } from '../src/governance-sanitize.js';
import { probeLocalLlm } from '../src/local-llm-probe.js';
import { registerCanonicalHostTools } from '../src/tool-registration.js';

describe('runtime 100 coverage completion', () => {
  describe('governance-sanitize.ts re-export', () => {
    it('sanitizes token patterns', () => {
      const sanitized = sanitizeGovernanceMessage('token wsg_grant.secret-key-1234 here');
      expect(sanitized).toBe('token [credential] here');
    });
  });

  describe('governance-bootstrap.ts edges', () => {
    it('exercises bootstrapGovernanceRuntime default export wrapper', async () => {
      const res = await bootstrapGovernanceRuntime({
        projectRoot: 'D:/non-existent-path-never-exists',
        projectId: 'p1',
        adminClientId: 'admin1',
        modelClientId: 'model1',
        modelCapabilities: ['task_read'],
      });
      expect(res.mode).toBeDefined();
    });

    it('exercises readGovernanceDaemonOperatorStatus default export wrapper', async () => {
      const res = await readGovernanceDaemonOperatorStatus('D:/non-existent-path-never-exists');
      expect(res.available).toBe(false);
    });

    it('exercises readGovernanceDaemonOperatorStatusWithDependencies broker error and non-ok status branches', async () => {
      // 1. readBroker throws Error
      const res1 = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => {
          throw new Error('broker read fault');
        }) as never,
        connectClient: vi.fn() as never,
      });
      expect(res1).toEqual({
        available: false,
        code: 'broker_invalid',
        message: 'broker read fault',
      });

      // 1b. readBroker throws non-Error
      const res1b = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => {
          throw 'broker raw string fault';
        }) as never,
        connectClient: vi.fn() as never,
      });
      expect(res1b).toEqual({
        available: false,
        code: 'broker_invalid',
        message: 'broker raw string fault',
      });

      // 2. broker kind invalid
      const res2 = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => ({ kind: 'invalid', reason: 'bad broker reason' })) as never,
        connectClient: vi.fn() as never,
      });
      expect(res2).toEqual({
        available: false,
        code: 'broker_invalid',
        message: 'bad broker reason',
      });

      // 3. connectClient throws non-Error
      const res3 = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => ({
          kind: 'valid',
          broker: { projectId: 'p1', credential: { token: 't', projectId: 'p1', clientId: 'c1' } },
        })) as never,
        connectClient: vi.fn(async () => {
          throw 'string error';
        }) as never,
      });
      expect(res3).toEqual({
        available: false,
        code: 'connection_failed',
        message: 'string error',
      });

      // 4. client.request throws Error
      const res4 = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => ({
          kind: 'valid',
          broker: { projectId: 'p1', credential: { token: 't', projectId: 'p1', clientId: 'c1' } },
        })) as never,
        connectClient: vi.fn(async () => ({
          connected: true,
          client: {
            request: vi.fn(async () => {
              throw new Error('request timeout');
            }),
          },
        })) as never,
      });
      expect(res4).toEqual({
        available: false,
        code: 'connection_failed',
        message: 'request timeout',
      });

      // 5. client.request throws non-Error
      const res5 = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => ({
          kind: 'valid',
          broker: { projectId: 'p1', credential: { token: 't', projectId: 'p1', clientId: 'c1' } },
        })) as never,
        connectClient: vi.fn(async () => ({
          connected: true,
          client: {
            request: vi.fn(async () => {
              throw 'raw string fail';
            }),
          },
        })) as never,
      });
      expect(res5).toEqual({
        available: false,
        code: 'connection_failed',
        message: 'raw string fail',
      });

      // 6. client.request returns response.ok = false
      const res6 = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => ({
          kind: 'valid',
          broker: { projectId: 'p1', credential: { token: 't', projectId: 'p1', clientId: 'c1' } },
        })) as never,
        connectClient: vi.fn(async () => ({
          connected: true,
          client: {
            request: vi.fn(async () => ({
              ok: false,
              error: { message: 'daemon rejected read' },
            })),
          },
        })) as never,
      });
      expect(res6).toEqual({
        available: false,
        code: 'request_rejected',
        message: 'daemon rejected read',
      });

      // 7. client.request returns response.result.type !== 'daemon_status'
      const res7 = await readGovernanceDaemonOperatorStatusWithDependencies('D:/p', {
        readBroker: vi.fn(async () => ({
          kind: 'valid',
          broker: { projectId: 'p1', credential: { token: 't', projectId: 'p1', clientId: 'c1' } },
        })) as never,
        connectClient: vi.fn(async () => ({
          connected: true,
          client: {
            request: vi.fn(async () => ({
              ok: true,
              result: { type: 'other_type' },
            })),
          },
        })) as never,
      });
      expect(res7).toEqual({
        available: false,
        code: 'unexpected_response',
        message: 'Governance daemon returned an unexpected status response.',
      });
    });

    it('covers recordWorkspaceSnapshot and observe failure and rejection branches', async () => {
      const model = {
        request: vi.fn(),
        snapshot: () => ({
          projectId: 'p1',
          clientId: 'm1',
          grantId: 'g1',
          capabilities: ['task_read'] as const,
          expiresAt: '2026-08-02T13:00:00.000Z',
        }),
      };
      const recordWorkspaceSnapshot = vi.fn();
      const shutdownDaemon = vi.fn(async () => ({
        ok: false as const,
        error: { message: 'shutdown error' },
      }));
      const close = vi.fn();

      const fakeRuntime = {
        model,
        snapshot: () => ({
          source: 'launched' as const,
          closed: false,
          daemon: {
            projectRoot: 'D:/p',
            projectId: 'p1',
            pid: 1,
            instanceId: 'inst-1',
            startedAt: '2026',
          },
          control: { kind: 'admin' as const, clientId: 'c1', grantId: 'g1', expiresAt: '2026' },
          admin: {
            mode: 'launched' as const,
            daemon: {
              projectRoot: 'D:/p',
              projectId: 'p1',
              pid: 1,
              instanceId: 'inst-1',
              startedAt: '2026',
            },
            lease: {
              state: 'idle',
              projectId: 'p1',
              clientId: 'c1',
              grantId: 'g1',
              expiresAt: '2026',
              rotationAttempt: 0,
            },
          },
          model: model.snapshot(),
        }),
        recordWorkspaceSnapshot,
        shutdownDaemon,
        close,
      };

      const prepared = await bootstrapGovernanceRuntimeWithFactory(
        {
          projectRoot: 'D:/p',
          projectId: 'p1',
          adminClientId: 'a1',
          modelClientId: 'm1',
          modelCapabilities: ['task_read'],
        },
        async () => ({
          mode: 'governed',
          runtime: fakeRuntime as never,
        }),
      );

      if (prepared.mode !== 'governed') throw new Error('expected governed');
      const handle = prepared.handle;

      // 1. recordWorkspaceSnapshot: response not ok
      recordWorkspaceSnapshot.mockResolvedValueOnce({
        ok: false,
        error: { message: 'snapshot rejected' },
      });
      const snap1 = await handle.recordWorkspaceSnapshot('hash1');
      expect(snap1).toEqual({
        recorded: false,
        code: 'request_rejected',
        message: 'snapshot rejected',
      });

      // 2. recordWorkspaceSnapshot: response type unexpected
      recordWorkspaceSnapshot.mockResolvedValueOnce({
        ok: true,
        result: { type: 'wrong_type' },
      });
      const snap2 = await handle.recordWorkspaceSnapshot('hash1');
      expect(snap2).toEqual({
        recorded: false,
        code: 'unexpected_response',
        message: 'Governance workspace snapshot returned an unexpected response.',
      });

      // 3. recordWorkspaceSnapshot: result.recorded === false
      recordWorkspaceSnapshot.mockResolvedValueOnce({
        ok: true,
        result: {
          type: 'workspace_snapshot_recorded',
          result: {
            recorded: false,
            code: 'workspace_snapshot_invalid',
            message: 'hash bad',
          },
        },
      });
      const snap3 = await handle.recordWorkspaceSnapshot('hash1');
      expect(snap3).toEqual({
        recorded: false,
        code: 'workspace_snapshot_invalid',
        message: 'hash bad',
      });

      // 4. recordWorkspaceSnapshot: throws Error
      recordWorkspaceSnapshot.mockRejectedValueOnce(new Error('snapshot network error'));
      const snap4 = await handle.recordWorkspaceSnapshot('hash1');
      expect(snap4).toEqual({
        recorded: false,
        code: 'request_failed',
        message: 'snapshot network error',
      });

      // 5. recordWorkspaceSnapshot: throws non-Error
      recordWorkspaceSnapshot.mockRejectedValueOnce('raw snapshot error string');
      const snap5 = await handle.recordWorkspaceSnapshot('hash1');
      expect(snap5).toEqual({
        recorded: false,
        code: 'request_failed',
        message: 'raw snapshot error string',
      });

      // 6. observe: response not ok
      model.request.mockResolvedValueOnce({
        ok: false,
        error: { message: 'observe rejected' },
      });
      const obs1 = await handle.observe({
        taskId: null,
        category: 'tool_invoked',
        observedAt: '2026',
        payload: {},
      });
      expect(obs1).toEqual(
        expect.objectContaining({
          recorded: false,
          code: 'request_rejected',
          message: 'observe rejected',
        }),
      );

      // 7. observe: response type unexpected
      model.request.mockResolvedValueOnce({
        ok: true,
        result: { type: 'not_observation_result' },
      });
      const obs2 = await handle.observe({
        taskId: null,
        category: 'tool_invoked',
        observedAt: '2026',
        payload: {},
      });
      expect(obs2).toEqual(
        expect.objectContaining({
          recorded: false,
          code: 'unexpected_response',
          message: 'Governance observation returned an unexpected response.',
        }),
      );

      // 8. observe: handled is false
      model.request.mockResolvedValueOnce({
        ok: true,
        result: {
          type: 'observation_result',
          result: {
            handled: false,
            message: 'policy refused observation',
          },
        },
      });
      const obs3 = await handle.observe({
        taskId: null,
        category: 'tool_invoked',
        observedAt: '2026',
        payload: {},
      });
      expect(obs3).toEqual(
        expect.objectContaining({
          recorded: false,
          code: 'request_rejected',
          message: 'policy refused observation',
        }),
      );

      // 9. observe: throws Error
      model.request.mockRejectedValueOnce(new Error('observe throw Error'));
      const obs4 = await handle.observe({
        taskId: null,
        category: 'tool_invoked',
        observedAt: '2026',
        payload: {},
      });
      expect(obs4).toEqual(
        expect.objectContaining({
          recorded: false,
          code: 'request_failed',
          message: 'observe throw Error',
        }),
      );

      // 10. observe: throws non-Error
      model.request.mockRejectedValueOnce('observe raw throw');
      const obs5 = await handle.observe({
        taskId: null,
        category: 'tool_invoked',
        observedAt: '2026',
        payload: {},
      });
      expect(obs5).toEqual(
        expect.objectContaining({
          recorded: false,
          code: 'request_failed',
          message: 'observe raw throw',
        }),
      );

      // 11. close failure branch
      const closeRes1 = await handle.close();
      expect(closeRes1).toEqual({
        ok: false,
        action: 'shutdown',
        message: 'shutdown error',
      });

      // 12. recordWorkspaceSnapshot when closed
      const snapClosed = await handle.recordWorkspaceSnapshot('hash1');
      expect(snapClosed).toEqual({
        recorded: false,
        code: 'closed',
        message: 'Governance runtime is closing and no longer accepts workspace snapshots.',
      });
    });

    it('covers close attached runtime returning null or unexpected response or throwing', async () => {
      const model = {
        request: vi.fn(),
        snapshot: () => ({
          projectId: 'p1',
          clientId: 'm1',
          grantId: 'g1',
          capabilities: [] as const,
          expiresAt: '2026',
        }),
      };
      const close = vi.fn();

      const makeHandle = async (closeImpl: any) => {
        close.mockImplementation(closeImpl);
        const prepared = await bootstrapGovernanceRuntimeWithFactory(
          {
            projectRoot: 'D:/p',
            projectId: 'p1',
            adminClientId: 'a1',
            modelClientId: 'm1',
            modelCapabilities: [],
          },
          async () => ({
            mode: 'governed',
            runtime: {
              model,
              snapshot: () => ({
                source: 'attached' as const,
                closed: false,
                daemon: {
                  projectRoot: 'D:/p',
                  projectId: 'p1',
                  pid: 1,
                  instanceId: 'inst-1',
                  startedAt: '2026',
                },
                control: {
                  kind: 'admin' as const,
                  clientId: 'c1',
                  grantId: 'g1',
                  expiresAt: '2026',
                },
                admin: {
                  mode: 'attached' as const,
                  daemon: {
                    projectRoot: 'D:/p',
                    projectId: 'p1',
                    pid: 1,
                    instanceId: 'inst-1',
                    startedAt: '2026',
                  },
                  lease: {
                    state: 'idle',
                    projectId: 'p1',
                    clientId: 'c1',
                    grantId: 'g1',
                    expiresAt: '2026',
                    rotationAttempt: 0,
                  },
                },
                model: model.snapshot(),
              }),
              close,
              shutdownDaemon: vi.fn(),
              recordWorkspaceSnapshot: vi.fn(),
            } as never,
          }),
        );
        if (prepared.mode !== 'governed') throw new Error('expected governed');
        return prepared.handle;
      };

      // 1. returns null
      const h1 = await makeHandle(async () => null);
      const c1 = await h1.close();
      expect(c1).toEqual({
        ok: true,
        action: 'detach',
        message: 'Governance runtime already closed.',
      });

      // 2. returns ok: true with unexpected type
      const h2 = await makeHandle(async () => ({
        ok: true,
        result: { type: 'unexpected_detach_type' },
      }));
      const c2 = await h2.close();
      expect(c2).toEqual({
        ok: false,
        action: 'detach',
        message: 'Governance runtime detach returned an unexpected response.',
      });

      // 3. throws Error
      const h3 = await makeHandle(async () => {
        throw new Error('close exploded');
      });
      const c3 = await h3.close();
      expect(c3).toEqual({
        ok: false,
        action: 'detach',
        message: 'close exploded',
      });

      // 4. throws non-Error
      const h4 = await makeHandle(async () => {
        throw 'non-error close';
      });
      const c4 = await h4.close();
      expect(c4).toEqual({
        ok: false,
        action: 'detach',
        message: 'non-error close',
      });

      // 5. Direct constructor check
      expect(() => new (h1.constructor as any)('invalid-symbol', {} as never)).toThrow(
        /Governance runtime handles must be created through the bootstrap adapter/,
      );

      // 6. bootstrapGovernanceRuntimeWithFactory throws non-Error
      const nonErr = await bootstrapGovernanceRuntimeWithFactory(
        {
          projectRoot: 'D:/p',
          projectId: 'p1',
          adminClientId: 'a1',
          modelClientId: 'm1',
          modelCapabilities: [],
        },
        async () => {
          throw 'factory string error';
        },
      );
      expect(nonErr).toMatchObject({
        mode: 'legacy',
        code: 'bootstrap_failed',
        message: 'factory string error',
      });
    });
  });

  describe('governance-mutation-snapshot-bridge.ts edges', () => {
    it('covers all bridge paths: boundary tool call, dedupe, warnings, capacity and close', async () => {
      const emitter = new EventEmitter();
      const events = {
        on: (event: string, handler: (payload: any) => void) => {
          emitter.on(event, handler);
          return () => emitter.off(event, handler);
        },
      };

      const sink = {
        recordWorkspaceSnapshot: vi.fn(async () => ({
          recorded: true as const,
          snapshot: {} as any,
        })),
      };
      let checkpointResult: any = {
        manifestHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };
      const captureWorkspaceCheckpoint = vi.fn(async () => checkpointResult);
      const logger = {
        warn: vi.fn(),
      };

      const bridge = createGovernanceMutationSnapshotBridge({
        events: events as never,
        sink,
        captureWorkspaceCheckpoint,
        logger,
      });

      // 1. Tool executed event: ok: false -> ignored
      emitter.emit('tool.executed', { ok: false, mutating: true, sessionId: 's1', id: 't1' });
      // mutating: false -> ignored
      emitter.emit('tool.executed', { ok: true, mutating: false, sessionId: 's1', id: 't2' });
      // mutating: true, ok: true -> enqueues snapshot
      emitter.emit('tool.executed', { ok: true, mutating: true, sessionId: 's1', id: 't3' });
      // Wait for the async task inside enqueueSnapshot to settle
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sink.recordWorkspaceSnapshot).toHaveBeenCalledTimes(1);

      // 2. installToolBoundary with tool call execution
      const handlers: any[] = [];
      const pipelines = {
        toolCall: {
          prepend: (item: any) => handlers.push(item),
        },
      };
      bridge.installToolBoundary(pipelines as never);
      // Double install does nothing
      bridge.installToolBoundary(pipelines as never);
      expect(handlers).toHaveLength(1);

      const handler = handlers[0].handler;
      const nextOk = vi.fn(async (payload) => ({
        ...payload,
        result: { is_error: false },
      }));

      // Non-mutating tool through boundary
      await handler(
        {
          ctx: { session: { id: 's-bound' } },
          toolUse: { id: 'use-1' },
          tool: { mutating: false },
          result: {},
        },
        nextOk,
      );

      // Mutating tool through boundary (ok)
      await handler(
        {
          ctx: { session: { id: 's-bound' } },
          toolUse: { id: 'use-2' },
          tool: { mutating: true },
          result: {},
        },
        nextOk,
      );
      expect(sink.recordWorkspaceSnapshot).toHaveBeenCalledTimes(2);

      // tool.executed for awaited tool is ignored
      emitter.emit('tool.executed', {
        ok: true,
        mutating: true,
        sessionId: 's-bound',
        id: 'use-2',
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sink.recordWorkspaceSnapshot).toHaveBeenCalledTimes(2);

      // 3. invalid checkpoint triggers warning
      checkpointResult = { manifestHash: 'invalid-hash' };
      emitter.emit('tool.executed', { ok: true, mutating: true, sessionId: 's1', id: 't4' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(logger.warn).toHaveBeenCalledWith(
        'governance: failed to capture a valid post-mutation workspace identity',
      );

      // 4. recordWorkspaceSnapshot not recorded
      checkpointResult = {
        manifestHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      };
      sink.recordWorkspaceSnapshot.mockResolvedValueOnce({
        recorded: false,
        code: 'workspace_snapshot_invalid',
        message: 'invalid recorded',
      } as never);
      emitter.emit('tool.executed', { ok: true, mutating: true, sessionId: 's1', id: 't5' });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // 5. recordWorkspaceSnapshot throws
      sink.recordWorkspaceSnapshot.mockRejectedValueOnce(new Error('sink exploded'));
      emitter.emit('tool.executed', { ok: true, mutating: true, sessionId: 's1', id: 't6' });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // 6. Queue capacity cap and close
      await bridge.close();
      // Double close does nothing
      await bridge.close();

      // Events after close are ignored
      emitter.emit('tool.executed', { ok: true, mutating: true, sessionId: 's1', id: 't7' });
    });

    it('covers queue capacity hit in background and awaited tool boundary', async () => {
      const emitter = new EventEmitter();
      const events = {
        on: (event: string, handler: (payload: any) => void) => {
          emitter.on(event, handler);
          return () => emitter.off(event, handler);
        },
      };

      const sink = {
        recordWorkspaceSnapshot: vi.fn(async () => ({
          recorded: true as const,
          snapshot: {} as any,
        })),
      };
      let shouldHold = true;
      const resolvers: Array<() => void> = [];
      const captureWorkspaceCheckpoint = vi.fn(
        () =>
          new Promise<any>((res) => {
            if (shouldHold) {
              resolvers.push(() =>
                res({
                  manifestHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                }),
              );
            } else {
              res({
                manifestHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              });
            }
          }),
      );
      const logger = { warn: vi.fn() };

      const bridge = createGovernanceMutationSnapshotBridge({
        events: events as never,
        sink,
        captureWorkspaceCheckpoint,
        logger,
      });

      // Fill queue to MAX_PENDING_GOVERNANCE_MUTATION_SNAPSHOTS (64)
      for (let i = 0; i < MAX_PENDING_GOVERNANCE_MUTATION_SNAPSHOTS; i++) {
        emitter.emit('tool.executed', { ok: true, mutating: true, sessionId: 's', id: `t-${i}` });
      }

      // Next background event hits queue capacity warning
      emitter.emit('tool.executed', { ok: true, mutating: true, sessionId: 's', id: 't-overflow' });
      expect(logger.warn).toHaveBeenCalledWith(
        'governance: mutation snapshot queue reached bounded capacity',
        { capacity: MAX_PENDING_GOVERNANCE_MUTATION_SNAPSHOTS },
      );

      // Awaited boundary when queue is full: should wait on tail
      const pipelines = {
        toolCall: {
          prepend: vi.fn(),
        },
      };
      bridge.installToolBoundary(pipelines as never);
      const handler = pipelines.toolCall.prepend.mock.calls[0]![0]!.handler;

      // Release hold and drain all pending
      shouldHold = false;
      for (const r of resolvers) r();

      // Run boundary call (waits for tail and proceeds)
      await handler(
        {
          ctx: { session: { id: 's-await' } },
          toolUse: { id: 'use-await' },
          tool: { mutating: true },
          result: {},
        },
        vi.fn(async (p) => p),
      );

      await bridge.close();
    });
  });

  describe('tool-registration.ts edges', () => {
    it('registers vector memory tools and tier off branch', () => {
      const registry = new ToolRegistry();
      const mockVectorStore = {
        search: vi.fn(async () => []),
        recall: vi.fn(async () => []),
        store: vi.fn(async () => undefined),
      };

      const result = registerCanonicalHostTools({
        registry,
        tier: 'off',
        memory: { enabled: false, store: null },
        vectorMemory: { store: mockVectorStore as never },
      });

      expect(registry.get('vector_memory_search')).toBeDefined();
      expect(result.builtinTools).toBeDefined();
    });
  });

  describe('local-llm-probe.ts edges', () => {
    it('handles empty baseUrl and invalid url gracefully', async () => {
      const res1 = await probeLocalLlm({
        baseUrl: '',
        apiKey: undefined,
        noAuth: true,
        scrubber: new DefaultSecretScrubber(),
      });
      expect(res1).toEqual({ ok: false, status: 'no_base_url', detail: 'baseUrl is empty' });

      const res2 = await probeLocalLlm({
        baseUrl: '   ',
        apiKey: undefined,
        noAuth: true,
        scrubber: new DefaultSecretScrubber(),
      });
      expect(res2).toEqual({ ok: false, status: 'no_base_url', detail: 'baseUrl is empty' });
    });
  });

  describe('fleet/light-subagent-factory.ts tool allow missing edge', () => {
    it('throws when requested tool contract is missing', async () => {
      const registry = new ToolRegistry();
      const config = {
        version: 1,
        provider: 'noop',
        model: 'noop',
        providers: { noop: { type: 'noop' } },
      } as any;

      const container = new Container();
      container.bind(TOKENS.Logger, () => ({ child: () => ({}) }) as never);
      container.bind(TOKENS.ConfigStore, () => new DefaultConfigStore(config));
      container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
      container.bind(TOKENS.TokenCounter, () => ({ count: () => 0 }) as never);
      container.bind(TOKENS.SystemPromptBuilder, () => ({ build: async () => 'prompt' }) as never);

      const providerRegistry = {
        has: vi.fn(() => true),
        create: vi.fn(() => ({
          capabilities: { tools: true, vision: false },
          complete: vi.fn(),
          stream: vi.fn(),
        })),
      };

      const factory = makeLightSubagentFactory({
        toolRegistry: registry,
        providerRegistry: providerRegistry as never,
        config,
        container,
      } as never);

      await expect(
        factory({
          id: 'sub-1',
          name: 'Worker',
          role: 'Subagent',
          prompt: 'Do task',
          tools: ['non_existent_tool_xyz'],
        }),
      ).rejects.toThrow(/Subagent tool contract is not registered: non_existent_tool_xyz/);
    });
  });

  describe('container.ts archiveIdle catch branch', () => {
    it('catches archiveIdle rejection without crashing', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => mockLogger,
      };

      const container = createDefaultContainer({
        config: {
          version: 1,
          provider: 'anthropic',
          model: 'test',
          log: { level: 'info' as const },
          storage: {
            sessionLogging: {
              storage: {
                autoArchive: true,
                hotKeepSessions: 5,
                includeSubagents: false,
              },
            },
          },
        } as any,
        wpaths: {
          projectRoot: 'D:/tmp/test-project',
          projectSessions: 'D:/tmp/test-project/sessions',
          configDir: 'D:/tmp/test-project/config',
          projectTrust: 'D:/tmp/test-project/trust.json',
        } as any,
        logger: mockLogger as any,
        modelsRegistry: {
          getProvider: async () => null,
          getModel: async () => null,
        } as any,
      });

      const sessionStore = container.resolve(TOKENS.SessionStore);
      expect(sessionStore).toBeDefined();
      vi.spyOn(sessionStore, 'archiveIdle').mockRejectedValueOnce(
        new Error('forced archiveIdle fail'),
      );
      // Create another container to trigger the autoArchive on resolve
      const container2 = createDefaultContainer({
        config: {
          version: 1,
          provider: 'anthropic',
          model: 'test',
          log: { level: 'info' as const },
          storage: {
            sessionLogging: {
              storage: {
                autoArchive: true,
                hotKeepSessions: 5,
                includeSubagents: false,
              },
            },
          },
        } as any,
        wpaths: {
          projectRoot: 'D:/tmp/test-project',
          projectSessions: 'D:/tmp/test-project/sessions',
          configDir: 'D:/tmp/test-project/config',
          projectTrust: 'D:/tmp/test-project/trust.json',
        } as any,
        logger: mockLogger as any,
        modelsRegistry: {
          getProvider: async () => null,
          getModel: async () => null,
        } as any,
      });
      // Replace DefaultSessionStore prototype archiveIdle temporarily
      const DefaultSessionStoreClass = sessionStore.constructor as any;
      const origArchive = DefaultSessionStoreClass.prototype.archiveIdle;
      DefaultSessionStoreClass.prototype.archiveIdle = vi
        .fn()
        .mockRejectedValue(new Error('forced archiveIdle error'));
      try {
        container2.resolve(TOKENS.SessionStore);
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Session archive-idle failed',
          expect.any(Object),
        );
      } finally {
        DefaultSessionStoreClass.prototype.archiveIdle = origArchive;
      }
    });

    it('resolves ProviderModelStatusTracker token in container.ts', () => {
      const container = createDefaultContainer({
        config: { version: 1, provider: 'test', model: 'test' } as any,
        wpaths: {
          projectRoot: 'D:/tmp/p',
          projectSessions: 'D:/tmp/p/sessions',
          configDir: 'D:/tmp/p/config',
          projectTrust: 'D:/tmp/p/trust.json',
        } as any,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({}) } as any,
        modelsRegistry: { getProvider: async () => null, getModel: async () => null } as any,
      });

      expect(container.resolve(TOKENS.ProviderModelStatusTracker)).toBeDefined();
    });

    it('covers invalid directory policy parse error throw in container.ts', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-invalid-policy-'));
      fs.mkdirSync(path.join(tmpDir, '.wrongstack'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.wrongstack', 'directory-rules.json'), '{ invalid json');

      expect(() =>
        createDefaultContainer({
          config: { version: 1, provider: 'test', model: 'test' } as any,
          wpaths: {
            projectRoot: tmpDir,
            projectSessions: path.join(tmpDir, 'sessions'),
            configDir: path.join(tmpDir, 'config'),
            projectTrust: path.join(tmpDir, 'trust.json'),
          } as any,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({}) } as any,
          modelsRegistry: { getProvider: async () => null, getModel: async () => null } as any,
        }),
      ).toThrow(/Invalid directory permission policy/);
    });

    it('covers rememberAwaitedCompletion max cache eviction (line 49-50) in bridge', async () => {
      const emitter = new EventEmitter();
      const events = {
        on: (event: string, handler: (payload: any) => void) => {
          emitter.on(event, handler);
          return () => emitter.off(event, handler);
        },
      };
      const bridge = createGovernanceMutationSnapshotBridge({
        events: events as never,
        sink: {
          recordWorkspaceSnapshot: vi.fn(async () => ({
            recorded: true as const,
            snapshot: {} as any,
          })),
        },
        captureWorkspaceCheckpoint: vi.fn(
          async () =>
            ({
              manifestHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            }) as never,
        ),
        logger: { warn: vi.fn() },
      });

      const pipelines = {
        toolCall: { prepend: vi.fn() },
      };
      bridge.installToolBoundary(pipelines as never);
      const handler = pipelines.toolCall.prepend.mock.calls[0]![0]!.handler;

      // Call boundary > 512 times with distinct keys to trigger eviction of oldest
      for (let i = 0; i <= 515; i++) {
        await handler(
          {
            ctx: { session: { id: `sess-${i}` } },
            toolUse: { id: `tool-${i}` },
            tool: { mutating: false },
            result: {},
          },
          vi.fn(async (p) => p),
        );
      }

      await bridge.close();
    });

    it('covers tool-registration.ts events and disabledToolMeta options', () => {
      const registry = new ToolRegistry();
      const setEventBusSpy = vi.spyOn(registry, 'setEventBus');
      const applyDisabledMetaSpy = vi.spyOn(registry, 'applyDisabledMeta');
      const mockEvents = new EventEmitter();

      registerCanonicalHostTools({
        registry,
        tier: 'off',
        memory: { enabled: false, store: null },
        events: mockEvents as never,
        disabledToolMeta: { write: { reason: 'user', at: 1, caller: 'read only mode' } },
      });

      expect(setEventBusSpy).toHaveBeenCalledWith(mockEvents);
      expect(applyDisabledMetaSpy).toHaveBeenCalledWith({
        write: { reason: 'user', at: 1, caller: 'read only mode' },
      });
    });
  });
});
