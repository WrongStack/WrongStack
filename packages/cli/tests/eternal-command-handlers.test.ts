import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eternalOptions: [] as unknown[],
  parallelOptions: [] as unknown[],
  eternalInstances: [] as Array<{
    prime: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  parallelInstances: [] as Array<{
    prime: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@wrongstack/core/execution', () => ({
  EternalAutonomyEngine: class {
    prime = vi.fn();
    stop = vi.fn();

    constructor(options: unknown) {
      mocks.eternalOptions.push(options);
      mocks.eternalInstances.push(this);
    }
  },
  ParallelEternalEngine: class {
    prime = vi.fn();
    stop = vi.fn();

    constructor(options: unknown) {
      mocks.parallelOptions.push(options);
      mocks.parallelInstances.push(this);
    }
  },
}));

import { createEternalCommandHandlers } from '../src/wiring/eternal-command-handlers.js';

function harness(maxContext = 8_000) {
  let autonomyMode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' = 'off';
  let eternal: unknown = null;
  let parallel: unknown = null;
  const setAutonomyMode = vi.fn(
    (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => {
      autonomyMode = mode;
    },
  );
  const makeSubagentFactory = vi.fn(() => ({ create: vi.fn() }));
  const input = {
    agent: { id: 'agent' },
    projectRoot: 'C:/repo',
    compactor: { compact: vi.fn() },
    effectiveMaxContext: { current: maxContext },
    onIteration: vi.fn(),
    onStage: vi.fn(),
    multiAgentHost: { makeSubagentFactory },
    getConfig: vi.fn(() => ({ provider: 'provider', model: 'model' })),
    events: { emit: vi.fn() },
    logger: { debug: vi.fn(), warn: vi.fn() },
    brain: { decide: vi.fn() },
    getAutonomyMode: vi.fn(() => autonomyMode),
    setAutonomyMode,
    autonomyModeRef: {
      current: 'off' as 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel',
    },
    getEternalEngine: vi.fn(() => eternal),
    setEternalEngine: vi.fn((engine: unknown) => {
      eternal = engine;
    }),
    getParallelEngine: vi.fn(() => parallel),
    setParallelEngine: vi.fn((engine: unknown) => {
      parallel = engine;
    }),
  };
  const handlers = createEternalCommandHandlers(input as never) as {
    onAutonomy: (
      mode?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel',
    ) => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
    onEternalStart: (mode?: 'eternal' | 'eternal-parallel') => void;
    onEternalStop: () => void;
  };
  return { handlers, input };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eternalOptions.length = 0;
  mocks.parallelOptions.length = 0;
  mocks.eternalInstances.length = 0;
  mocks.parallelInstances.length = 0;
});

describe('createEternalCommandHandlers', () => {
  it('reads and updates autonomy mode and its shared reference', () => {
    const { handlers, input } = harness();

    expect(handlers.onAutonomy()).toBe('off');
    expect(handlers.onAutonomy('eternal')).toBe('eternal');
    expect(input.setAutonomyMode).toHaveBeenCalledWith('eternal');
    expect(input.autonomyModeRef.current).toBe('eternal');
    expect(handlers.onAutonomy()).toBe('eternal');
  });

  it('creates, stores, primes, and reuses the sequential engine', () => {
    const { handlers, input } = harness();

    handlers.onEternalStart();
    expect(mocks.eternalOptions).toEqual([
      expect.objectContaining({
        agent: input.agent,
        projectRoot: 'C:/repo',
        maxContextTokens: 8_000,
        brain: input.brain,
      }),
    ]);
    expect(input.setEternalEngine).toHaveBeenCalledOnce();
    expect(mocks.eternalInstances[0]?.prime).toHaveBeenCalledOnce();

    handlers.onEternalStart('eternal');
    expect(mocks.eternalOptions).toHaveLength(1);
    expect(mocks.eternalInstances[0]?.prime).toHaveBeenCalledTimes(2);
  });

  it('creates a parallel engine with a subagent factory and no invalid token cap', () => {
    const { handlers, input } = harness(0);

    handlers.onEternalStart('eternal-parallel');
    expect(input.multiAgentHost.makeSubagentFactory).toHaveBeenCalledWith({
      provider: 'provider',
      model: 'model',
    });
    expect(mocks.parallelOptions).toEqual([
      expect.objectContaining({
        maxContextTokens: undefined,
        subagentFactory: expect.any(Object),
      }),
    ]);
    expect(input.setParallelEngine).toHaveBeenCalledOnce();
    expect(mocks.parallelInstances[0]?.prime).toHaveBeenCalledOnce();

    handlers.onEternalStart('eternal-parallel');
    expect(mocks.parallelOptions).toHaveLength(1);
    expect(mocks.parallelInstances[0]?.prime).toHaveBeenCalledTimes(2);
  });

  it('supports an existing parallel engine without an optional prime hook', () => {
    const input = harness().input;
    input.getParallelEngine.mockReturnValue({ stop: vi.fn() });
    const handlers = createEternalCommandHandlers(input as never) as {
      onEternalStart: (mode?: 'eternal' | 'eternal-parallel') => void;
      onEternalStop: () => void;
    };

    expect(() => handlers.onEternalStart('eternal-parallel')).not.toThrow();
    expect(input.setParallelEngine).not.toHaveBeenCalled();
  });

  it('stops whichever sequential and parallel engines are active', () => {
    const { handlers } = harness();
    handlers.onEternalStart('eternal');
    handlers.onEternalStart('eternal-parallel');

    handlers.onEternalStop();
    expect(mocks.eternalInstances[0]?.stop).toHaveBeenCalledOnce();
    expect(mocks.parallelInstances[0]?.stop).toHaveBeenCalledOnce();
  });

  it('does nothing when stop is requested before engines exist', () => {
    const { handlers } = harness();
    expect(() => handlers.onEternalStop()).not.toThrow();
  });

  it('omits a non-positive sequential context limit', () => {
    const { handlers } = harness(0);
    handlers.onEternalStart('eternal');
    expect(mocks.eternalOptions[0]).toEqual(
      expect.objectContaining({ maxContextTokens: undefined }),
    );
  });
});
