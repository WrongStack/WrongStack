import { isVolatileSystemBlock } from '@wrongstack/contracts/types/blocks';
import type { Config } from '@wrongstack/contracts/types/config/root';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Request } from '@wrongstack/contracts/types/provider';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import { describe, expect, it, vi } from 'vitest';
import {
  createSkillSuggestionMiddleware,
  renderSuggestionBlock,
} from '../../src/skills/suggest/middleware.js';
import { createSkillSuggestionSetup } from '../../src/skills/suggest/setup.js';
import {
  createSkillSuggester,
  type SkillSuggester,
  type SkillSuggestion,
  type SkillSuggestionTrace,
} from '../../src/skills/suggest/skill-suggester.js';

function userRequest(text: string, extra: Message[] = []): Request {
  return {
    model: 'm',
    system: [{ type: 'text', text: '## Skills\n| a | b |' }],
    messages: [{ role: 'user', content: text }, ...extra],
  };
}

function suggesterOf(suggestion: SkillSuggestion | undefined): SkillSuggester {
  return {
    suggest: vi.fn(async () => suggestion),
    explain: vi.fn(async () => traceOf(suggestion)),
  };
}

function traceOf(suggestion: SkillSuggestion | undefined): SkillSuggestionTrace {
  return {
    gate: 0,
    gateValues: {},
    ranked: [],
    shortlist: [],
    fits: {},
    winner: suggestion?.name,
    suggestion,
    stop: suggestion ? 'suggested' : 'gate',
    requests: 1,
    models: [],
    inputTokens: 0,
  };
}

async function unusedExplain(): Promise<never> {
  throw new Error('boom');
}

const HIT: SkillSuggestion = { name: 'git-flow', gate: 0.8, fits: 0.7 };

async function run(mw: ReturnType<typeof createSkillSuggestionMiddleware>, request: Request) {
  let seen: Request | undefined;
  await mw.handler(request, async (next) => {
    seen = next as Request;
    return { content: [], stopReason: 'end_turn' } as never;
  });
  return seen!;
}

describe('createSkillSuggestionMiddleware', () => {
  it('re-evaluates when host tools change, but reuses a reordered equivalent catalog', async () => {
    const suggester = suggesterOf(HIT);
    let tools = ['read', 'skill'];
    const mw = createSkillSuggestionMiddleware({ suggester, getAvailableToolNames: () => tools });
    const request = userRequest('Review and improve this module');
    await run(mw, request);
    tools = ['skill', 'read'];
    await run(mw, request);
    expect(suggester.explain).toHaveBeenCalledTimes(1);
    tools = ['read', 'skill', 'bash'];
    await run(mw, request);
    expect(suggester.explain).toHaveBeenCalledTimes(2);
    expect(suggester.explain).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(AbortSignal),
      { availableToolNames: tools },
    );
  });

  it('does not tell the model no skill fits when the real client fails', async () => {
    const loader = {
      listEntries: async () => [
        { name: 'a', trigger: 'coding' },
        { name: 'b', trigger: 'design' },
      ],
      list: async () => [],
    } as unknown as SkillLoader;
    const client = {
      systemOne: vi.fn(async () => {
        throw new Error('HTTP 401');
      }),
    };
    const mw = createSkillSuggestionMiddleware({
      suggester: createSkillSuggester({ loader, client }),
    });
    const original = userRequest('Review and improve this module');
    expect(await run(mw, original)).toBe(original);
    expect(await run(mw, original)).toBe(original);
    expect(client.systemOne).toHaveBeenCalledTimes(1);
  });
  it('appends the suggestion as a volatile block without touching the roster text', async () => {
    const mw = createSkillSuggestionMiddleware({ suggester: suggesterOf(HIT) });
    const original = userRequest('Cut a release branch for 1.2.0');

    const seen = await run(mw, original);

    expect(seen.system).toHaveLength(2);
    // The roster block is untouched, which is what keeps the cached prefix
    // valid across turns.
    expect(seen.system![0]).toBe(original.system![0]);
    const block = seen.system![1]!;
    expect(block.text).toContain('Relevant to the current request: git-flow');
    expect(isVolatileSystemBlock(block)).toBe(true);
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('still emits a block when nothing fits', async () => {
    // The manifest carries a standing "load a skill when one is relevant"
    // instruction. Sending nothing would leave that unopposed on exactly the
    // turns where the gate decided nothing applies.
    const mw = createSkillSuggestionMiddleware({ suggester: suggesterOf(undefined) });
    const seen = await run(mw, userRequest('Explain what a monad is, in general'));
    expect(seen.system![1]!.text).toContain('No skill in the roster appears relevant');
  });

  it('asks once per user message and replays the answer through the tool loop', async () => {
    // The request pipeline runs on every provider call. The judgment is about
    // the user's request, which does not change between tool-loop iterations.
    const suggester = suggesterOf(HIT);
    const mw = createSkillSuggestionMiddleware({
      suggester,
      getSessionId: () => 'session-a',
    });
    const first = userRequest('Cut a release branch for 1.2.0');
    const afterTool = userRequest('Cut a release branch for 1.2.0', [
      { role: 'assistant', content: 'running' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ] as never);

    const a = await run(mw, first);
    const b = await run(mw, afterTool);

    expect(suggester.explain).toHaveBeenCalledTimes(1);
    expect(b.system![1]!.text).toBe(a.system![1]!.text);
  });

  it('re-asks when the user says something new', async () => {
    const suggester = suggesterOf(HIT);
    const mw = createSkillSuggestionMiddleware({ suggester, getSessionId: () => 's' });
    await run(mw, userRequest('Cut a release branch for 1.2.0'));
    await run(mw, userRequest('Now restyle the settings page header'));
    expect(suggester.explain).toHaveBeenCalledTimes(2);
  });

  it('caches a miss too', async () => {
    const suggester = suggesterOf(undefined);
    const mw = createSkillSuggestionMiddleware({ suggester, getSessionId: () => 's' });
    await run(mw, userRequest('Explain what a monad is, in general'));
    await run(mw, userRequest('Explain what a monad is, in general'));
    expect(suggester.explain).toHaveBeenCalledTimes(1);
  });

  it('keeps sessions apart', async () => {
    const suggester = suggesterOf(HIT);
    let session = 'a';
    const mw = createSkillSuggestionMiddleware({ suggester, getSessionId: () => session });
    await run(mw, userRequest('Cut a release branch for 1.2.0'));
    session = 'b';
    await run(mw, userRequest('Cut a release branch for 1.2.0'));
    expect(suggester.explain).toHaveBeenCalledTimes(2);
  });

  it('skips turns too short to carry a request', async () => {
    const suggester = suggesterOf(HIT);
    const mw = createSkillSuggestionMiddleware({ suggester });
    const seen = await run(mw, userRequest('go on'));
    expect(suggester.explain).not.toHaveBeenCalled();
    expect(seen.system).toHaveLength(1);
  });

  it('passes the request through unchanged when the suggester throws', async () => {
    const mw = createSkillSuggestionMiddleware({
      suggester: {
        explain: unusedExplain,
        suggest: async () => {
          throw new Error('boom');
        },
      },
    });
    const original = userRequest('Cut a release branch for 1.2.0');
    const seen = await run(mw, original);
    expect(seen).toBe(original);
  });

  it('abandons the suggestion at the deadline instead of holding the turn', async () => {
    let aborted = false;
    const mw = createSkillSuggestionMiddleware({
      deadlineMs: 10,
      suggester: {
        suggest: async () => undefined,
        explain: (_request, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              resolve({ ...traceOf(undefined), stop: 'error' });
            });
          }),
      },
    });
    const seen = await run(mw, userRequest('Cut a release branch for 1.2.0'));
    expect(aborted).toBe(true);
    expect(seen.system).toHaveLength(1);
  });

  it('does not let an observer failure break the turn', async () => {
    const mw = createSkillSuggestionMiddleware({
      suggester: suggesterOf(HIT),
      onSuggestion: () => {
        throw new Error('observer exploded');
      },
    });
    const seen = await run(mw, userRequest('Cut a release branch for 1.2.0'));
    expect(seen.system![1]!.text).toContain('git-flow');
  });

  it('enforces the deadline even when a loader ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const suggester = { suggest: vi.fn(), explain: vi.fn(() => new Promise<never>(() => {})) };
      const mw = createSkillSuggestionMiddleware({ suggester, deadlineMs: 10 });
      const original = userRequest('Review and improve this module');
      const pending = run(mw, original);
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toBe(original);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renderSuggestionBlock', () => {
  it('tells the model it may ignore the suggestion', () => {
    // Pushing harder wins compliance on the WRONG suggestions too, and a
    // confident wrong pointer is worse than none.
    expect(renderSuggestionBlock('git-flow')).toContain('Ignore this if it does not fit');
  });
});

function configWith(suggest: unknown): Config {
  return {
    typesafe: { enabled: true },
    features: { skills: true },
    skills: { suggest },
  } as unknown as Config;
}

const stubLoader = { list: async () => [], listEntries: async () => [] } as unknown as SkillLoader;

describe('createSkillSuggestionSetup', () => {
  it('is off unless explicitly enabled', () => {
    expect(
      createSkillSuggestionSetup({
        config: configWith(undefined),
        skillLoader: stubLoader,
        env: { TYPESAFE_API_KEY: 'k' },
      }),
    ).toBeUndefined();
  });

  it('stays off when enabled without a key, and says so at warn level', () => {
    // This used to be a debug line, which in practice was silence: a switch
    // the operator turned on did nothing and nothing said why. Suppression
    // after the first message is covered in skill-suggest-setup-warning.test.ts.
    const warn = vi.fn();
    const mw = createSkillSuggestionSetup({
      config: configWith({ enabled: true }),
      skillLoader: stubLoader,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as never,
      env: {},
    });
    expect(mw).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TYPESAFE_API_KEY'));
  });

  it('installs when enabled with a key from the environment', () => {
    const mw = createSkillSuggestionSetup({
      config: configWith({ enabled: true }),
      skillLoader: stubLoader,
      env: { TYPESAFE_API_KEY: 'sk-test' },
    });
    expect(mw?.name).toBe('skills.suggest');
  });

  it('stays off when skills are disabled or no loader exists', () => {
    const config = {
      features: { skills: false },
      skills: { suggest: { enabled: true } },
    } as unknown as Config;
    expect(
      createSkillSuggestionSetup({
        config,
        skillLoader: stubLoader,
        env: { TYPESAFE_API_KEY: 'k' },
      }),
    ).toBeUndefined();
    expect(
      createSkillSuggestionSetup({
        config: configWith({ enabled: true }),
        skillLoader: undefined,
        env: { TYPESAFE_API_KEY: 'k' },
      }),
    ).toBeUndefined();
  });
});
