import { describe, expect, it, vi } from 'vitest';
import {
  _resetAutoHygieneThrottleForTesting,
  sageHygieneOptionsFromConfig,
  setupSage,
} from '../src/host-wiring.js';
import { createSageOutcomeCaptureMiddleware } from '../src/middleware/outcome-capture.js';
import { createSagePathRemapMiddleware } from '../src/middleware/path-remap.js';
import type { SageSurface } from '../src/service-contract.js';
import { fileTriageProposals } from '../src/shared/file-proposals.js';

const RETRIEVAL_CAPABILITY_ID = 'wrongstack.memory.retrieval.v1';
const SURFACE_CAPABILITY_ID = 'wrongstack.memory.surface.v1';

function toolPayload(
  name: string,
  input: Record<string, unknown>,
  result: { content: string; is_error: boolean },
) {
  return {
    toolUse: { type: 'tool_use', id: `tool-${name}`, name, input },
    result,
    ctx: {
      cwd: 'D:/repo',
      projectRoot: 'D:/repo',
    },
  } as never;
}

describe('SAGE host wiring', () => {
  it('forwards hygiene config and installs the shared middleware stack', async () => {
    _resetAutoHygieneThrottleForTesting();
    const flushPendingCounters = vi.fn(async () => {});
    const hygiene = vi.fn(async () => ({}));
    const toolUse = vi.fn();
    const requestUse = vi.fn();
    const retrieval = { flushPendingCounters };
    const surface = {};
    const memory = {
      hygiene,
      getCapability(capability: { id: string }) {
        if (capability.id === RETRIEVAL_CAPABILITY_ID) return retrieval;
        if (capability.id === SURFACE_CAPABILITY_ID) return surface;
        return undefined;
      },
    } as never;
    const config = {
      features: { memory: true },
      Sage: {
        enabled: true,
        capture: { toolOutcomes: true },
        inject: { toolResults: false },
        hygiene: { retentionDays: 30, sessionRetentionDays: 7 },
      },
    };

    expect(sageHygieneOptionsFromConfig(config.Sage?.hygiene)).toMatchObject({
      retentionDays: 30,
      sessionRetentionDays: 7,
    });

    const teardown = setupSage({
      config: config as never,
      pipelines: {
        toolCall: { use: toolUse },
        request: { use: requestUse },
      } as never,
      memoryStore: memory,
      logger: { debug: vi.fn() } as never,
      events: {} as never,
    });

    expect(toolUse).toHaveBeenCalledTimes(2);
    expect(requestUse).toHaveBeenCalledTimes(2);
    await teardown();
    expect(flushPendingCounters).toHaveBeenCalledOnce();
    expect(hygiene).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 30, sessionRetentionDays: 7 }),
    );
  });

  it('handles early exit branches when memory or sage is disabled or unretrievable', async () => {
    const toolUse = vi.fn();
    const requestUse = vi.fn();
    const pipelines = { toolCall: { use: toolUse }, request: { use: requestUse } } as never;
    const debug = vi.fn();
    const logger = { debug } as never;

    // features.memory === false
    const t1 = setupSage({
      config: { features: { memory: false } } as never,
      pipelines,
      memoryStore: {} as never,
      logger,
      events: {} as never,
    });
    await t1();

    // Sage.enabled === false
    const t2 = setupSage({
      config: { features: { memory: true }, Sage: { enabled: false } } as never,
      pipelines,
      memoryStore: {} as never,
      logger,
      events: {} as never,
    });
    await t2();

    // memoryStore is undefined
    const t3 = setupSage({
      config: { features: { memory: true }, Sage: { enabled: true } } as never,
      pipelines,
      memoryStore: undefined,
      logger,
      events: {} as never,
    });
    await t3();

    // memoryStore without retrieval capability
    const t4 = setupSage({
      config: { features: { memory: true }, Sage: { enabled: true } } as never,
      pipelines,
      memoryStore: { getCapability: () => undefined } as never,
      logger,
      events: {} as never,
    });
    await t4();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('memory store does not support retrieval'),
    );
    expect(toolUse).not.toHaveBeenCalled();
  });

  it('runs daily dry run via fake timers and exercises full triage, proposals, and error branches', async () => {
    vi.useFakeTimers();
    try {
      _resetAutoHygieneThrottleForTesting();
      const toolUse = vi.fn();
      const requestUse = vi.fn();
      const pipelines = { toolCall: { use: toolUse }, request: { use: requestUse } } as never;
      const debugLogs: string[] = [];
      const logger = { debug: (msg: string) => debugLogs.push(msg) } as never;

      const memories = [
        {
          id: 'mem-1',
          status: 'active',
          text: 'Memory for daily dry-run with low score',
          kind: 'fact',
          scope: 'project',
          confidence: 0.5,
          importance: 0.3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          anchors: [{ type: 'file', path: 'src/x.ts' }],
          tags: [],
          sources: [],
        },
      ];

      const surface = {
        listSagePage: vi.fn(async () => ({ memories })),
        listCandidates: vi.fn(async () => [{ status: 'pending', id: 'c-1' }]),
        createCandidate: vi.fn(async (input) => ({ id: 'c-2', ...input })),
      };

      const retrieval = { flushPendingCounters: vi.fn(async () => {}) };
      const hygiene = vi.fn(async () => ({}));
      const memory = {
        hygiene,
        getCapability(capability: { id: string }) {
          if (capability.id === RETRIEVAL_CAPABILITY_ID) return retrieval;
          if (capability.id === SURFACE_CAPABILITY_ID) return surface;
          return undefined;
        },
      } as never;

      const config = {
        features: { memory: true },
        Sage: {
          enabled: true,
          capture: { errorPatterns: true },
          inject: { turnContext: true },
          triage: { dailyDryRun: true },
          hygiene: { autoAfterSession: true },
        },
      };

      // 1. First run with LLM returning '2 | transient' -> produces proposals (lines 221-223)
      const teardown = setupSage({
        config: config as never,
        pipelines,
        memoryStore: memory,
        logger,
        events: { on: vi.fn(), emit: vi.fn() } as never,
        projectRoot: 'D:/repo',
        getLlmCall: () => async () => '2 | transient',
      });

      // Advance by 1 hour (initial daily delay)
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(surface.listSagePage).toHaveBeenCalled();
      expect(debugLogs.some((l) => l.includes('sage daily dry-run: hygiene complete'))).toBe(true);

      // 2. Advance by 24 hours (interval daily run)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

      await teardown();
      expect(hygiene).toHaveBeenCalled();

      // 3. Second run with default LLM stub (line 211: async () => '3')
      _resetAutoHygieneThrottleForTesting();
      const teardownDefaultLlm = setupSage({
        config: config as never,
        pipelines,
        memoryStore: memory,
        logger,
        events: { on: vi.fn(), emit: vi.fn() } as never,
        projectRoot: 'D:/repo',
      });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await teardownDefaultLlm();

      // Subsequent teardown within 1 hour: skips hygiene due to throttle
      const teardown2 = setupSage({
        config: config as never,
        pipelines,
        memoryStore: memory,
        logger,
        events: { on: vi.fn(), emit: vi.fn() } as never,
      });
      await teardown2();
      expect(debugLogs.some((l) => l.includes('sage auto-hygiene skipped'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles errors gracefully in daily dry run', async () => {
    vi.useFakeTimers();
    try {
      _resetAutoHygieneThrottleForTesting();
      const debugLogs: string[] = [];
      const logger = { debug: (msg: string) => debugLogs.push(msg) } as never;

      // 1. memoryStore has no surface capability
      const memNoSurface = {
        hygiene: vi.fn(async () => ({})),
        getCapability(capability: { id: string }) {
          if (capability.id === RETRIEVAL_CAPABILITY_ID) return { flushPendingCounters: vi.fn() };
          return undefined;
        },
      } as never;

      const teardown1 = setupSage({
        config: {
          features: { memory: true },
          Sage: { enabled: true, triage: { dailyDryRun: true } },
        } as never,
        pipelines: { toolCall: { use: vi.fn() }, request: { use: vi.fn() } } as never,
        memoryStore: memNoSurface,
        logger,
        events: {} as never,
      });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(debugLogs.some((l) => l.includes('sage daily dry-run: no surface capability'))).toBe(
        true,
      );
      await teardown1();

      // 2. triage throws error
      debugLogs.length = 0;
      const memTriageError = {
        hygiene: vi.fn(async () => ({})),
        getCapability(capability: { id: string }) {
          if (capability.id === RETRIEVAL_CAPABILITY_ID) return { flushPendingCounters: vi.fn() };
          if (capability.id === SURFACE_CAPABILITY_ID) {
            return {
              listSagePage: vi.fn(async () => {
                throw new Error('boom in triage');
              }),
            };
          }
          return undefined;
        },
      } as never;

      const teardown2 = setupSage({
        config: {
          features: { memory: true },
          Sage: {
            enabled: true,
            triage: { dailyDryRun: true },
            hygiene: { autoAfterSession: false },
          },
        } as never,
        pipelines: { toolCall: { use: vi.fn() }, request: { use: vi.fn() } } as never,
        memoryStore: memTriageError,
        logger,
        events: {} as never,
      });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(debugLogs.some((l) => l.includes('sage daily triage skipped: boom in triage'))).toBe(
        true,
      );
      await teardown2();

      // 3. hygiene in runDaily throws
      debugLogs.length = 0;
      const memHygieneError = {
        hygiene: vi.fn(async () => {
          throw new Error('hygiene failed');
        }),
        getCapability(capability: { id: string }) {
          if (capability.id === RETRIEVAL_CAPABILITY_ID) return { flushPendingCounters: vi.fn() };
          return undefined;
        },
      } as never;

      const teardown3 = setupSage({
        config: {
          features: { memory: true },
          Sage: {
            enabled: true,
            triage: { dailyDryRun: true },
            hygiene: { autoAfterSession: false },
          },
        } as never,
        pipelines: { toolCall: { use: vi.fn() }, request: { use: vi.fn() } } as never,
        memoryStore: memHygieneError,
        logger,
        events: {} as never,
      });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(debugLogs.some((l) => l.includes('sage daily dry-run failed: hygiene failed'))).toBe(
        true,
      );
      await teardown3();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SAGE outcome and anchor capture', () => {
  it('records successful command outcomes through the SAGE surface capability', async () => {
    const rememberSage = vi.fn(async (input) => ({ id: 'memory-1', ...input }));
    const memory = {
      getCapability: (capability: { id: string }) =>
        capability.id === SURFACE_CAPABILITY_ID ? { rememberSage } : undefined,
    } as never;
    const middleware = createSageOutcomeCaptureMiddleware({
      memory,
      toolOutcomes: true,
      maxPerHour: 10,
    });
    const payload = toolPayload(
      'exec',
      { command: 'pnpm test --filter sage' },
      { content: '42 tests passed', is_error: false },
    );

    await middleware.handler(payload, async (nextPayload) => nextPayload);

    expect(rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool_outcome',
        text: expect.stringContaining('42 tests passed'),
        anchors: [{ type: 'command', command: 'pnpm test --filter sage' }],
      }),
    );
  });

  it('remaps file anchors after a successful shell rename', async () => {
    const updateSage = vi.fn(async (_id, patch) => patch);
    const listSage = vi.fn(async () => [
      {
        id: 'memory-path',
        text: 'Keep this file current',
        anchors: [{ type: 'file', path: 'src/old.ts' }],
      },
    ]);
    const memory = {
      getCapability: (capability: { id: string }) =>
        capability.id === SURFACE_CAPABILITY_ID ? { listSage, updateSage } : undefined,
    } as never;
    const middleware = createSagePathRemapMiddleware({ memory, maxPerHour: 10 });
    const payload = toolPayload(
      'exec',
      { command: 'git mv src/old.ts src/new.ts' },
      { content: '', is_error: false },
    );

    await middleware.handler(payload, async (nextPayload) => nextPayload);

    expect(listSage).toHaveBeenCalledWith(['active']);
    expect(updateSage).toHaveBeenCalledWith('memory-path', {
      anchors: [{ type: 'file', path: 'src/new.ts' }],
    });
  });
});

describe('fileTriageProposals', () => {
  it('deduplicates pending targets and reports candidate failures without aborting the batch', async () => {
    const createCandidate = vi
      .fn()
      .mockResolvedValueOnce({ id: 'candidate-1' })
      .mockRejectedValueOnce(new Error('candidate store unavailable'));
    const surface = {
      listCandidates: vi.fn(async () => [
        { status: 'pending', targetMemoryId: 'memory-duplicate' },
      ]),
      createCandidate,
    } as unknown as SageSurface;

    const result = await fileTriageProposals(surface, [
      {
        memoryId: 'memory-duplicate',
        memoryText: 'Duplicate',
        suggestedAction: 'archive',
        reason: 'already pending',
      },
      {
        memoryId: 'memory-filed',
        memoryText: 'File me',
        suggestedAction: 'investigate',
        reason: 'needs review',
      },
      {
        memoryId: 'memory-failed',
        memoryText: 'Fail me',
        suggestedAction: 'delete',
        reason: 'test failure path',
      },
    ]);

    expect(result).toMatchObject({
      filed: 1,
      failed: 1,
      total: 2,
      skippedAsDuplicate: 1,
    });
    expect(result.failures).toEqual([
      { memoryId: 'memory-failed', error: 'candidate store unavailable' },
    ]);
    expect(result.inputs.map((input) => input.targetMemoryId)).toEqual([
      'memory-filed',
      'memory-failed',
    ]);
  });
});
