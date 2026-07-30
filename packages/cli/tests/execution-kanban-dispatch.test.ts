import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKanbanDispatchHandler } from '../src/execution-kanban-dispatch.js';

const mocks = vi.hoisted(() => ({
  resolveRoute: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});
vi.mock('../src/kanban-dispatch-route.js', () => ({
  resolveKanbanDispatchRoute: mocks.resolveRoute,
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.randomUUID
    .mockReturnValueOnce('12345678-0000-0000-0000-000000000000')
    .mockReturnValueOnce('task-uuid');
  mocks.resolveRoute.mockReturnValue({
    provider: 'openai',
    model: 'gpt-test',
    fallbackModels: ['fallback-a'],
  });
});

describe('createKanbanDispatchHandler', () => {
  it('returns no callback when the subagent factory is unavailable', () => {
    expect(
      createKanbanDispatchHandler({
        config: {} as never,
        events: {} as never,
        skillLoader: undefined,
        sddSubagentFactory: undefined,
      }),
    ).toEqual({});
  });

  it('loads requested skills, routes the agent, reports success, and disposes it', async () => {
    const onDone = vi.fn();
    const dispose = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ status: 'done', finalText: 'completed' });
    const factory = vi.fn().mockResolvedValue({ agent: { run }, dispose });
    const events = { emit: vi.fn() };
    const skillLoader = {
      find: vi.fn().mockResolvedValue({ name: 'coverage' }),
      readBody: vi.fn().mockResolvedValue('Run every test.'),
    };
    const callbacks = createKanbanDispatchHandler({
      config: {} as never,
      events: events as never,
      skillLoader: skillLoader as never,
      sddSubagentFactory: factory as never,
    });

    const message = await callbacks.onKanbanDispatch?.('Cover sources', {
      name: 'tester',
      skills: ['coverage'],
      tools: ['read'],
      fallbackProfile: 'backup',
      onDone,
    });
    await flush();

    expect(message).toContain('kanban-12345678');
    expect(message).toContain('openai / gpt-test');
    expect(message).toContain('fallback=fallback-a');
    expect(message).toContain('profile=backup');
    expect(message).toContain('skills=coverage');
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'tester',
        provider: 'openai',
        model: 'gpt-test',
        fallbackModels: ['fallback-a'],
        prompt: expect.stringContaining('Run every test.'),
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.stringContaining('Required agentic skill'));
    expect(onDone).toHaveBeenCalledWith({ status: 'completed', result: 'completed' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('reports missing skills and runtime failures through the error event', async () => {
    const events = { emit: vi.fn() };
    const missing = createKanbanDispatchHandler({
      config: {} as never,
      events: events as never,
      skillLoader: { find: vi.fn().mockResolvedValue(undefined) } as never,
      sddSubagentFactory: vi.fn() as never,
    });
    await expect(missing.onKanbanDispatch?.('task', { skills: ['missing'] })).rejects.toThrow(
      'Kanban skill not found',
    );

    const onDone = vi.fn();
    const dispose = vi.fn();
    const failed = createKanbanDispatchHandler({
      config: {} as never,
      events: events as never,
      skillLoader: undefined,
      sddSubagentFactory: vi.fn().mockResolvedValue({
        agent: { run: vi.fn().mockRejectedValue('agent failed') },
        dispose,
      }) as never,
    });
    await failed.onKanbanDispatch?.('task', { onDone });
    await flush();

    expect(onDone).toHaveBeenCalledWith({ status: 'failed', error: 'agent failed' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(events.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ phase: 'kanban.dispatch', err: expect.any(Error) }),
    );
  });
});
