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
