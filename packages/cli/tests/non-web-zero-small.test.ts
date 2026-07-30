import type { Config } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installDesignStudioMiddleware: vi.fn(),
  acpCommands: {} as Record<string, unknown>,
  findAgentDescriptor: vi.fn(),
  makeACPSubagentRunner: vi.fn(),
  defaultPermissionPolicy: { mode: 'default' },
  fallbackProfileChain: vi.fn(),
  parseModelRef: vi.fn(),
  predictNextTasks: vi.fn(),
  parseSuggestionsFromOutput: vi.fn(),
  setSuggestions: vi.fn(),
}));

vi.mock('@wrongstack/core/design', () => ({
  installDesignStudioMiddleware: mocks.installDesignStudioMiddleware,
}));

vi.mock('@wrongstack/acp', () => ({
  ACP_AGENT_COMMANDS: mocks.acpCommands,
  defaultPermissionPolicy: mocks.defaultPermissionPolicy,
  findAgentDescriptor: mocks.findAgentDescriptor,
  makeACPSubagentRunner: mocks.makeACPSubagentRunner,
}));

vi.mock('@wrongstack/core/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/agent')>();
  return {
    ...actual,
    fallbackProfileChain: mocks.fallbackProfileChain,
    parseModelRef: mocks.parseModelRef,
  };
});

vi.mock('../src/next-task-predictor.js', () => ({
  predictNextTasks: mocks.predictNextTasks,
}));

vi.mock('../src/repl.js', () => ({
  parseSuggestionsFromOutput: mocks.parseSuggestionsFromOutput,
}));

vi.mock('../src/services/suggestion-store.js', () => ({
  setSuggestions: mocks.setSuggestions,
}));

import { createReplFleetCallbacks } from '../src/execution-repl-fleet-callbacks.js';
import { installStorageObservability } from '../src/execution-storage-observability.js';
import { createTuiNextStepCallbacks } from '../src/execution-tui-next-step-callbacks.js';
import { buildAcpSubagentRunner } from '../src/fleet/host-acp.js';
import { normalizeMaxConcurrent } from '../src/fleet/host-concurrency.js';
import { resolveKanbanDispatchRoute } from '../src/kanban-dispatch-route.js';
import { quickCmd } from '../src/subcommands/handlers/quick.js';
import { installDesignStudio } from '../src/wiring/design-studio.js';

afterEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.acpCommands)) {
    delete mocks.acpCommands[key];
  }
});

describe('small non-WebUI CLI modules', () => {
  it('normalizes valid concurrency and rejects every invalid numeric class', () => {
    expect(normalizeMaxConcurrent(1)).toBe(1);
    expect(normalizeMaxConcurrent(3.9)).toBe(3);

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(() => normalizeMaxConcurrent(value)).toThrow(ToolValidationError);
    }
  });

  it('keeps the quick fallback handler successful', async () => {
    await expect(quickCmd([], {} as never)).resolves.toBe(0);
  });

  it('forwards Design Studio middleware dependencies and optional state', () => {
    const pipelines = { marker: 'pipelines' };
    const context = { marker: 'context' };

    installDesignStudio({
      pipelines: pipelines as never,
      context: context as never,
      enabled: false,
    });
    installDesignStudio({
      pipelines: pipelines as never,
      context: context as never,
    });

    expect(mocks.installDesignStudioMiddleware).toHaveBeenNthCalledWith(1, {
      pipelines,
      ctx: context,
      enabled: false,
    });
    expect(mocks.installDesignStudioMiddleware).toHaveBeenNthCalledWith(2, {
      pipelines,
      ctx: context,
      enabled: undefined,
    });
  });

  it('builds ACP runners from built-in and discovered descriptors', async () => {
    const builtInRunner = { run: vi.fn() };
    mocks.acpCommands.builtin = {
      command: 'builtin-agent',
      args: ['--stdio'],
      role: 'builtin',
    };
    mocks.makeACPSubagentRunner.mockReturnValueOnce(builtInRunner);

    expect(buildAcpSubagentRunner('builtin')).toBe(builtInRunner);
    expect(mocks.findAgentDescriptor).not.toHaveBeenCalled();
    expect(mocks.makeACPSubagentRunner).toHaveBeenNthCalledWith(1, {
      command: 'builtin-agent',
      args: ['--stdio'],
      role: 'builtin',
      permissionPolicy: mocks.defaultPermissionPolicy,
    });

    const discoveredRunner = { run: vi.fn() };
    mocks.findAgentDescriptor.mockReturnValueOnce({
      acp: { command: 'custom-agent', args: ['run'], env: { TOKEN: 'test' } },
    });
    mocks.makeACPSubagentRunner.mockReturnValueOnce(discoveredRunner);

    expect(buildAcpSubagentRunner('custom')).toBe(discoveredRunner);
    expect(mocks.makeACPSubagentRunner).toHaveBeenNthCalledWith(2, {
      command: 'custom-agent',
      args: ['run'],
      role: 'custom',
      env: { TOKEN: 'test' },
      permissionPolicy: mocks.defaultPermissionPolicy,
    });
  });

  it('handles descriptor defaults and rejects unknown ACP agents', async () => {
    mocks.findAgentDescriptor.mockReturnValueOnce({
      acp: { command: 'minimal-agent' },
    });
    mocks.makeACPSubagentRunner.mockReturnValueOnce({ run: vi.fn() });

    buildAcpSubagentRunner('minimal');
    expect(mocks.makeACPSubagentRunner).toHaveBeenCalledWith({
      command: 'minimal-agent',
      args: [],
      role: 'minimal',
      permissionPolicy: mocks.defaultPermissionPolicy,
    });

    mocks.findAgentDescriptor.mockReturnValueOnce(undefined);
    expect(() => buildAcpSubagentRunner('missing')).toThrow(ToolValidationError);
  });

  it('suppresses routine storage telemetry and surfaces failures with inherited and payload trace IDs', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const offRead = vi.fn();
    const offWrite = vi.fn();
    const offError = vi.fn();
    const offs = [offRead, offWrite, offError];
    const events = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return offs[listeners.size - 1];
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const stop = installStorageObservability(events as never, 'root-trace');
    // Routine successful telemetry — should be silently dropped.
    listeners.get('storage.read')?.({ path: 'a', outcome: 'success' });
    listeners.get('storage.write')?.({ path: 'b', traceId: 'payload-trace', outcome: 'success' });
    // Failure telemetry — must surface at warning level so the user
    // sees non-recoverable audit-log / project-manifest write errors
    // that don't always bubble through `agent.error`.
    listeners.get('storage.read')?.({ path: 'c', outcome: 'failure', error: 'invalid_schema' });
    listeners.get('storage.write')?.({ path: 'd', outcome: 'failure', error: 'eacces' });
    listeners.get('storage.error')?.({ message: 'failed' });

    const logs = warn.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual([
      expect.objectContaining({
        event: 'storage.read',
        path: 'c',
        outcome: 'failure',
        error: 'invalid_schema',
        level: 'warning',
        traceId: 'root-trace',
      }),
      expect.objectContaining({
        event: 'storage.write',
        path: 'd',
        outcome: 'failure',
        error: 'eacces',
        level: 'warning',
        traceId: 'root-trace',
      }),
      expect.objectContaining({
        event: 'storage.error',
        message: 'failed',
        level: 'warning',
        traceId: 'root-trace',
      }),
    ]);
    expect(logs.every((entry) => typeof entry.timestamp === 'string')).toBe(true);

    stop();
    expect(offRead).toHaveBeenCalledOnce();
    expect(offWrite).toHaveBeenCalledOnce();
    expect(offError).toHaveBeenCalledOnce();
  });

  it('resolves fallback-profile routes without overwriting explicit fallback models', () => {
    const config = { provider: 'configured-provider' } as Config;
    mocks.fallbackProfileChain.mockReturnValue(['profile-provider/profile-model', 'fallback/one']);
    mocks.parseModelRef.mockReturnValue({
      provider: 'profile-provider',
      model: 'profile-model',
    });

    expect(
      resolveKanbanDispatchRoute(config, {
        fallbackProfile: 'quality',
        fallbackModels: ['explicit/fallback'],
      }),
    ).toEqual({
      provider: 'profile-provider',
      model: 'profile-model',
      fallbackModels: ['explicit/fallback'],
    });

    mocks.parseModelRef.mockReturnValue({ model: 'profile-model' });
    expect(resolveKanbanDispatchRoute(config, { fallbackProfile: 'quality' })).toEqual({
      provider: 'configured-provider',
      model: 'profile-model',
      fallbackModels: ['fallback/one'],
    });
  });

  it('preserves direct routing when a fallback profile has no usable primary', () => {
    const config = { provider: 'configured-provider' } as Config;
    const direct = {
      provider: 'direct-provider',
      model: 'direct-model',
      fallbackModels: ['direct/fallback'],
    };

    expect(resolveKanbanDispatchRoute(config, direct)).toEqual(direct);
    expect(resolveKanbanDispatchRoute(config)).toEqual({
      provider: undefined,
      model: undefined,
      fallbackModels: undefined,
    });

    mocks.fallbackProfileChain.mockReturnValue([]);
    expect(resolveKanbanDispatchRoute(config, { ...direct, fallbackProfile: 'empty' })).toEqual(
      direct,
    );

    mocks.fallbackProfileChain.mockReturnValue(['invalid']);
    mocks.parseModelRef.mockReturnValue({});
    expect(resolveKanbanDispatchRoute(config, { ...direct, fallbackProfile: 'invalid' })).toEqual(
      direct,
    );
  });

  it('predicts next steps only when prediction is enabled and autonomy is off', async () => {
    mocks.predictNextTasks.mockResolvedValue(['next']);
    const callbacks = createTuiNextStepCallbacks({
      context: {
        todos: null,
        provider: { id: 'provider' },
        model: 'model',
      },
      getNextPredict: () => true,
      getAutonomy: () => 'off',
    });
    const request = { userRequest: 'request', assistantSummary: 'summary' };

    await expect(callbacks.predictNext(request)).resolves.toEqual(['next']);
    expect(mocks.predictNextTasks).toHaveBeenCalledWith(
      { ...request, todos: [] },
      { provider: { id: 'provider' }, model: 'model' },
    );

    const todos = [{ id: 'todo-1', content: 'Continue', status: 'pending' }] as never;
    await createTuiNextStepCallbacks({
      context: { todos, provider: {}, model: 'model' },
      getNextPredict: () => true,
      getAutonomy: () => 'off',
    }).predictNext(request);
    expect(mocks.predictNextTasks).toHaveBeenLastCalledWith(
      { ...request, todos },
      { provider: {}, model: 'model' },
    );

    await expect(
      createTuiNextStepCallbacks({
        context: { todos: [], provider: {}, model: 'model' },
      }).predictNext(request),
    ).resolves.toEqual([]);
    await expect(
      createTuiNextStepCallbacks({
        context: { todos: [], provider: {}, model: 'model' },
        getNextPredict: () => true,
        getAutonomy: () => 'full',
      }).predictNext(request),
    ).resolves.toEqual([]);
  });

  it('parses, stores, reads, and clears TUI suggestions', () => {
    mocks.parseSuggestionsFromOutput.mockReturnValueOnce(['one', 'two']).mockReturnValueOnce(null);
    const callbacks = createTuiNextStepCallbacks({
      context: { todos: [], provider: {}, model: 'model' },
      getSuggestions: () => ['stored'],
    });

    callbacks.onSuggestionsParsed('with suggestions');
    callbacks.onSuggestionsParsed('without suggestions');
    expect(mocks.setSuggestions).toHaveBeenNthCalledWith(1, ['one', 'two']);
    expect(mocks.setSuggestions).toHaveBeenNthCalledWith(2, []);
    expect(callbacks.getSuggestions()).toEqual(['stored']);
    expect(
      createTuiNextStepCallbacks({
        context: { provider: {}, model: 'model' },
      }).getSuggestions(),
    ).toEqual([]);

    callbacks.setSuggestions(['manual']);
    expect(mocks.setSuggestions).toHaveBeenLastCalledWith(['manual']);
  });

  it('interrupts active fleet members and updates leader pressure', () => {
    const remove = vi.fn((id: string) => {
      if (id === 'idle') throw new Error('already gone');
      return Promise.resolve();
    });
    const setLeaderContextPressure = vi.fn();
    const fallbackDirector = {
      status: () => ({
        subagents: [
          { id: 'running', status: 'running' },
          { id: 'idle', status: 'idle' },
          { id: 'done', status: 'completed' },
        ],
      }),
      remove,
      setLeaderContextPressure,
    };
    const dynamicDirector = {
      status: () => ({ subagents: [] }),
      remove: vi.fn(),
      setLeaderContextPressure: vi.fn(),
    };
    const callbacks = createReplFleetCallbacks({
      director: fallbackDirector as never,
      getDirector: undefined,
    });

    expect(callbacks.onInterruptFleet()).toBe(1);
    expect(remove).toHaveBeenCalledWith('running');
    expect(remove).toHaveBeenCalledWith('idle');
    callbacks.onAgentIterationComplete(321);
    expect(setLeaderContextPressure).toHaveBeenCalledWith(321);

    const dynamicCallbacks = createReplFleetCallbacks({
      director: fallbackDirector as never,
      getDirector: () => dynamicDirector as never,
    });
    expect(dynamicCallbacks.onInterruptFleet()).toBe(0);
    dynamicCallbacks.onAgentIterationComplete(123);
    expect(dynamicDirector.setLeaderContextPressure).toHaveBeenCalledWith(123);

    const emptyCallbacks = createReplFleetCallbacks({
      director: null,
      getDirector: () => undefined,
    });
    expect(emptyCallbacks.onInterruptFleet()).toBe(0);
    expect(() => emptyCallbacks.onAgentIterationComplete(1)).not.toThrow();
  });
});
