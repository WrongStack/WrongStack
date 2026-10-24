import type { Message } from '@wrongstack/contracts/types/messages';
import type {
  Provider,
  ReasoningConfig,
  Request,
  Response,
  Usage,
} from '@wrongstack/contracts/types/provider';
import { describe, expect, it, vi } from 'vitest';
import type { EnhanceOutcome, EnhancePassInfo } from '../../src/execution/prompt-enhancer.js';
import {
  buildRefinerContextSections,
  completeRefinerPass,
  ENHANCER_SYSTEM_PROMPT,
  enhanceUserPrompt,
  gatedEnhancerReasoning,
  isValidEnglishRefinement,
  normalizedEqual,
  parseBilingualEnhancement,
  recentTextTurns,
  shouldEnhance,
} from '../../src/execution/prompt-enhancer.js';

function makeProvider(
  impl: (req: Request, opts: { signal: AbortSignal }) => Promise<Response>,
): Provider {
  return {
    id: 'test',
    capabilities: {
      tools: false,
      parallelTools: false,
      vision: false,
      streaming: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      maxContext: 128000,
      cacheControl: 'none',
    },
    stream() {
      return (async function* () {})();
    },
    complete: impl,
  };
}

function textResponse(text: string): Response {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 10, output: 5 },
    model: 'test',
  };
}

describe('shouldEnhance', () => {
  it('skips empty, slash, short, and affirmation inputs', () => {
    expect(shouldEnhance('')).toBe(false);
    expect(shouldEnhance('   ')).toBe(false);
    expect(shouldEnhance('/model')).toBe(false);
    expect(shouldEnhance('fix it')).toBe(false); // < 12 chars
    expect(shouldEnhance('yes')).toBe(false);
    expect(shouldEnhance('continue')).toBe(false);
    expect(shouldEnhance('go ahead')).toBe(false);
    expect(shouldEnhance('42')).toBe(false);
    expect(shouldEnhance('1, 2, 3')).toBe(false);
    expect(shouldEnhance('two words')).toBe(false); // 2 words
  });

  it('enhances genuine multi-word requests', () => {
    expect(shouldEnhance('fix the bug in the parser')).toBe(true);
    expect(shouldEnhance('make the login flow faster please')).toBe(true);
  });

  it('skips non-English control answers for lexicon-covered languages', () => {
    // Listed control phrase, long enough to pass every other gate.
    expect(shouldEnhance('evet devam et')).toBe(false);
    expect(shouldEnhance('EVET DEVAM ET.')).toBe(false);
    expect(shouldEnhance('devam')).toBe(false);
    expect(shouldEnhance('oui')).toBe(false);
    // Real instructions that merely start with a control word still refine.
    expect(shouldEnhance('evet ama önce parser düzelt')).toBe(true);
    expect(shouldEnhance('ja und danach die Tests ausführen')).toBe(true);
  });
});

describe('ENHANCER_SYSTEM_PROMPT', () => {
  it('loads the file-backed helper prompt', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('request refiner');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('Output ONLY');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('control tags such as `[VIBE]`');
  });
});

describe('gatedEnhancerReasoning', () => {
  const rc = (over: Partial<ReasoningConfig>): ReasoningConfig => ({
    default: 'adaptive',
    disableSupported: false,
    effortSupported: false,
    effortLevels: [],
    preserveThinking: 'unsupported',
    ...over,
  });

  it('returns undefined when capabilities are unknown', () => {
    expect(gatedEnhancerReasoning(undefined)).toBeUndefined();
  });

  it('picks the lowest advertised effort level (prefers "low")', () => {
    expect(
      gatedEnhancerReasoning(
        rc({ effortSupported: true, effortLevels: ['low', 'medium', 'high'] }),
      ),
    ).toEqual({ effort: 'low' });
  });

  it('falls back to "minimal" when "low" is not advertised', () => {
    expect(
      gatedEnhancerReasoning(rc({ effortSupported: true, effortLevels: ['minimal', 'medium'] })),
    ).toEqual({ effort: 'minimal' });
  });

  it('uses "none" only when it is the sole advertised level', () => {
    expect(gatedEnhancerReasoning(rc({ effortSupported: true, effortLevels: ['none'] }))).toEqual({
      effort: 'none',
    });
  });

  it('disables thinking when effort is unsupported but disabling is', () => {
    expect(gatedEnhancerReasoning(rc({ disableSupported: true }))).toEqual({ enabled: false });
  });

  it('returns undefined for an always-on model (no effort, no disable)', () => {
    expect(gatedEnhancerReasoning(rc({ default: 'always_on' }))).toBeUndefined();
  });

  it('falls through to disable when effortSupported but no levels are listed', () => {
    expect(
      gatedEnhancerReasoning(
        rc({ effortSupported: true, effortLevels: [], disableSupported: true }),
      ),
    ).toEqual({ enabled: false });
  });
});

describe('normalizedEqual', () => {
  it('treats whitespace/case differences as equal', () => {
    expect(normalizedEqual('Fix  the   Bug', 'fix the bug')).toBe(true);
    expect(normalizedEqual('fix the bug', 'fix the null deref')).toBe(false);
  });
});

describe('bilingual enhancement parsing', () => {
  it('validates English while rejecting Turkish text and dotted/dotless I variants', () => {
    expect(isValidEnglishRefinement('Fix the parser error in auth.ts.')).toBe(true);
    expect(isValidEnglishRefinement('Resolve the race condition.')).toBe(true);
    expect(isValidEnglishRefinement('auth.ts login()')).toBe(false);
    expect(isValidEnglishRefinement('auth.ts içindeki ayrıştırıcı hatasını düzelt.')).toBe(false);
    expect(isValidEnglishRefinement('İçindeki parser hatasını düzelt.')).toBe(false);
    expect(isValidEnglishRefinement('Içindeki parser hatasını düzelt.')).toBe(false);
  });

  it('allows a language-neutral first version for non-English input', () => {
    expect(
      parseBilingualEnhancement(
        'auth.ts login()\n---\nFix auth.ts login().',
        'auth.ts içindeki login hatasını düzelt',
      ),
    ).toEqual({ refined: 'auth.ts login()', english: 'Fix auth.ts login().' });
  });

  it('restores a source [VIBE] tag in both refined versions when the model drops it', () => {
    expect(
      parseBilingualEnhancement(
        'auth.ts içindeki giriş hatasını düzelt.\n---\nFix the login error in auth.ts.',
        '[vibe] auth.ts içindeki giriş hatasını düzelt',
      ),
    ).toEqual({
      refined: '[VIBE] auth.ts içindeki giriş hatasını düzelt.',
      english: '[VIBE] Fix the login error in auth.ts.',
    });
  });

  it('does not duplicate a preserved [VIBE] tag regardless of case', () => {
    expect(
      parseBilingualEnhancement(
        '[VIBE] auth.ts içindeki giriş hatasını düzelt.\n---\n[vibe] Fix the login error in auth.ts.',
        '[VIBE] auth.ts içindeki giriş hatasını düzelt',
      ),
    ).toEqual({
      refined: '[VIBE] auth.ts içindeki giriş hatasını düzelt.',
      english: '[vibe] Fix the login error in auth.ts.',
    });
  });

  it('rejects an English first version for non-English input', () => {
    expect(
      parseBilingualEnhancement(
        'Fix the login error in auth.ts.\n---\nFix the login error in auth.ts.',
        'auth.ts içindeki login hatasını düzelt',
      ),
    ).toBeNull();
  });

  it('rejects an unclassifiable first version for unclassifiable input', () => {
    expect(
      parseBilingualEnhancement(
        'auth login widget\n---\nFix the auth login widget.',
        'auth login widget',
      ),
    ).toBeNull();
  });

  it('does not reject valid English refinements that use unknown vocabulary', () => {
    expect(
      parseBilingualEnhancement(
        'Investigate intermittent deadlocks, checkout.ts.\n---\nFix the race condition in checkout.ts.',
        'Fix intermittent deadlocks in checkout.ts.',
      ),
    ).toEqual({
      refined: 'Investigate intermittent deadlocks, checkout.ts.',
      english: 'Fix the race condition in checkout.ts.',
    });
  });

  it('tolerates CRLF and visually blank separator padding', () => {
    const expected = {
      refined: 'auth.ts içindeki null hatasını düzelt.',
      english: 'Fix the null error in auth.ts.',
    };
    expect(
      parseBilingualEnhancement(
        'auth.ts içindeki null hatasını düzelt.\r\n  ---  \r\nFix the null error in auth.ts.',
        'auth.ts içindeki null hatasını düzelt',
      ),
    ).toEqual(expected);
    expect(
      parseBilingualEnhancement(
        'auth.ts içindeki null hatasını düzelt.\n\u00a0\u200d---\ufeff\nFix the null error in auth.ts.',
        'auth.ts içindeki null hatasını düzelt',
      ),
    ).toEqual(expected);
  });

  it('rejects a missing separator, extra separators, and a non-English second version', () => {
    const original = 'auth.ts içindeki hatayı düzelt';
    expect(parseBilingualEnhancement('Yalnızca Türkçe yanıt.', original)).toBeNull();
    expect(
      parseBilingualEnhancement('Türkçe.\n---\nUse the English version.\n---\nExtra.', original),
    ).toBeNull();
    expect(
      parseBilingualEnhancement('Türkçe sürüm.\n---\nİngilizce olmayan sürüm.', original),
    ).toBeNull();
  });
});

describe('completeRefinerPass', () => {
  it('uses the direct provider with the supplied request and signal', async () => {
    const complete = vi.fn(async (_req: Request) => textResponse('  Refined output.  '));
    const provider = makeProvider(complete);
    const signal = new AbortController().signal;
    const request: Request = {
      model: 'm',
      messages: [],
      maxTokens: 256,
    };

    await expect(
      completeRefinerPass('raw prompt', {
        provider,
        request,
        signal,
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({ text: 'Refined output.', usage: { input: 10, output: 5 } });
    expect(complete).toHaveBeenCalledWith(
      { ...request, messages: [{ role: 'user', content: 'raw prompt' }] },
      { signal },
    );
  });
});

describe('enhanceUserPrompt', () => {
  it('accepts the strict two-version contract for English input', async () => {
    const text = 'Fix the null-deref in auth.ts login() when the token is missing.';
    const provider = makeProvider(async () => textResponse(`${text}\n---\n${text}`));
    const out = await enhanceUserPrompt({ provider, model: 'm', text: 'fix the parser bug' });
    expect(out).toEqual({ refined: text, english: text });
  });

  it('corrects a single English response to the required two-version contract', async () => {
    const refined = 'Fix the null-deref in auth.ts login() when the token is missing.';
    const complete = vi
      .fn()
      .mockResolvedValueOnce(textResponse(refined))
      .mockResolvedValueOnce(textResponse(`${refined}\n---\n${refined}`));
    const provider = makeProvider(complete);
    const onError = vi.fn();
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'Fix the parser bug in auth.ts.',
      onError,
    });
    expect(out).toEqual({ refined, english: refined });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('corrects a single Turkish response with one retry', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(textResponse('auth.ts içindeki hatayı düzelt.'))
      .mockResolvedValueOnce(
        textResponse('auth.ts içindeki hatayı düzelt.\n---\nFix the error in auth.ts.'),
      );
    const provider = makeProvider(complete);
    const onError = vi.fn();
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'auth.ts içindeki hatayı düzelt',
      onError,
    });
    expect(out).toEqual({
      refined: 'auth.ts içindeki hatayı düzelt.',
      english: 'Fix the error in auth.ts.',
    });
    expect(complete).toHaveBeenCalledTimes(2);
    const correction = complete.mock.calls[1]![0] as Request;
    expect(correction.messages[0]!.content).toContain('required bilingual output contract');
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries when the English half contains no English instruction vocabulary', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(textResponse('auth.ts içindeki hatayı düzelt.\n---\nauth.ts login()'))
      .mockResolvedValueOnce(
        textResponse('auth.ts içindeki hatayı düzelt.\n---\nFix the login error in auth.ts.'),
      );
    const provider = makeProvider(complete);
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'auth.ts içindeki hatayı düzelt',
    });
    expect(out?.english).toBe('Fix the login error in auth.ts.');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('uses the orchestrator for both the malformed response and corrective retry', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        text: 'auth.ts içindeki hatayı düzelt.',
        tokens: { input: 3, output: 2, total: 5 },
      })
      .mockResolvedValueOnce({
        text: 'auth.ts içindeki hatayı düzelt.\n---\nFix the error in auth.ts.',
        tokens: { input: 4, output: 3, total: 7 },
      });
    const provider = makeProvider(async () => {
      throw new Error('direct provider should not run');
    });
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'auth.ts içindeki hatayı düzelt',
      oneShotOrchestrator: { call } as never,
    });
    expect(out).toEqual({
      refined: 'auth.ts içindeki hatayı düzelt.',
      english: 'Fix the error in auth.ts.',
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]![0].messages[0].content).toContain(
      'required bilingual output contract',
    );
  });

  it('reports empty after exactly one unsuccessful corrective retry', async () => {
    const complete = vi.fn(async (_req: Request) => textResponse('Yalnızca Türkçe yanıt.'));
    const provider = makeProvider(complete);
    const onError = vi.fn();
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'auth.ts içindeki hatayı düzelt',
      onError,
    });
    expect(out).toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('corrective retry'), 'empty');
  });

  it('splits two "---"-separated versions into distinct refined/english', async () => {
    const provider = makeProvider(async () =>
      textResponse(
        'auth.ts login() içindeki null-deref hatasını düzelt.\n---\nFix the null-deref in auth.ts login().',
      ),
    );
    const out = await enhanceUserPrompt({ provider, model: 'm', text: 'hatayı düzelt' });
    expect(out).toEqual({
      refined: 'auth.ts login() içindeki null-deref hatasını düzelt.',
      english: 'Fix the null-deref in auth.ts login().',
    });
  });

  it('rejects additional separator lines after one corrective retry', async () => {
    const complete = vi.fn(async (_req: Request) =>
      textResponse('Türkçe sürüm.\n---\nUse the English version.\n---\nExtra English text.'),
    );
    const provider = makeProvider(complete);
    const onError = vi.fn();
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'bir şey yap',
      onError,
    });
    expect(out).toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
    const correction = complete.mock.calls[1]![0] as Request;
    expect(correction.messages[0]!.content).toContain('required bilingual output contract');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('corrective retry'), 'empty');
  });

  it('sends the enhancer system prompt and the raw text as a user message', async () => {
    const complete = vi.fn(async (_req: Request) =>
      textResponse('Refine the request.\n---\nRefine the request.'),
    );
    const provider = makeProvider(complete);
    await enhanceUserPrompt({ provider, model: 'gpt-x', text: 'do the thing properly' });
    const req = complete.mock.calls[0]![0] as Request;
    expect(req.model).toBe('gpt-x');
    expect(req.system?.[0]?.text).toMatch(/request refiner/i);
    expect(req.messages).toEqual([{ role: 'user', content: 'do the thing properly' }]);
  });

  it('embeds conversation history as context in a single user message', async () => {
    const complete = vi.fn(async (_req: Request) =>
      textResponse('Refine the request.\n---\nRefine the request.'),
    );
    const provider = makeProvider(complete);
    await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'do the same for the other file',
      history: [
        { role: 'user', text: 'fix the null deref in auth.ts' },
        { role: 'assistant', text: 'Fixed auth.ts login().' },
      ],
    });
    const req = complete.mock.calls[0]![0] as Request;
    // Still a single user message (no role-alternation risk).
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe('user');
    const content = req.messages[0]!.content as string;
    expect(content).toMatch(/context only/i);
    expect(content).toContain('User: fix the null deref in auth.ts');
    expect(content).toContain('Assistant: Fixed auth.ts login().');
    expect(content).toContain('Latest message to refine:');
    expect(content).toContain('do the same for the other file');
  });

  it('embeds project/session context and retry context in the same user message', async () => {
    const complete = vi.fn(async (_req: Request) =>
      textResponse('Refine the request.\n---\nRefine the request.'),
    );
    const provider = makeProvider(complete);
    await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'make it cleaner',
      contextSections: [
        { title: 'Relevant project memory', items: ['Use pnpm for package commands.'] },
      ],
      previousRefinement: {
        refined: 'Make the implementation cleaner.',
        english: 'Make the implementation cleaner.',
      },
      retryFeedback: 'Make it more specific without expanding scope.',
    });
    const req = complete.mock.calls[0]![0] as Request;
    expect(req.messages).toHaveLength(1);
    const content = req.messages[0]!.content as string;
    expect(content).toContain('Additional project/session context');
    expect(content).toContain('Relevant project memory:');
    expect(content).toContain('- Use pnpm for package commands.');
    expect(content).toContain('Retry context');
    expect(content).toContain('Previous refined version: Make the implementation cleaner.');
    expect(content).toContain('Retry instruction: Make it more specific without expanding scope.');
    expect(content).toContain('Latest message to refine:');
    expect(content).toContain('make it cleaner');
  });

  it('forwards a reasoning directive when supplied', async () => {
    const complete = vi.fn(async (_req: Request) =>
      textResponse('Refine the request.\n---\nRefine the request.'),
    );
    const provider = makeProvider(complete);
    await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'do the thing properly',
      reasoning: { effort: 'low' },
    });
    const req = complete.mock.calls[0]![0] as Request;
    expect(req.reasoning).toEqual({ effort: 'low' });
  });

  it('sends no reasoning field when none is supplied (default behavior)', async () => {
    const complete = vi.fn(async (_req: Request) =>
      textResponse('Refine the request.\n---\nRefine the request.'),
    );
    const provider = makeProvider(complete);
    await enhanceUserPrompt({ provider, model: 'm', text: 'do the thing properly' });
    const req = complete.mock.calls[0]![0] as Request;
    expect(req.reasoning).toBeUndefined();
  });

  it('returns null on provider error (best-effort, never throws)', async () => {
    const provider = makeProvider(async () => {
      throw new Error('boom');
    });
    const onError = vi.fn();
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'fix the bug here',
      onError,
    });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(String), 'provider_error');
  });

  it('returns null when both provider attempts yield empty text', async () => {
    const complete = vi.fn(async (_req: Request) => textResponse('   '));
    const provider = makeProvider(complete);
    const onError = vi.fn();
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'fix the bug here',
      onError,
    });
    expect(out).toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(String), 'empty');
  });

  it('gives the corrective pass a fresh timeout window', async () => {
    vi.useFakeTimers();
    try {
      const complete = vi
        .fn()
        .mockImplementationOnce(
          async () =>
            await new Promise<Response>((resolve) => {
              setTimeout(() => resolve(textResponse('malformed output')), 15);
            }),
        )
        .mockImplementationOnce(
          async () =>
            await new Promise<Response>((resolve) => {
              setTimeout(
                () => resolve(textResponse('Refine the request.\n---\nRefine the request.')),
                15,
              );
            }),
        );
      const provider = makeProvider(complete);
      const result = enhanceUserPrompt({
        provider,
        model: 'm',
        text: 'refine the request properly',
        timeoutMs: 20,
      });
      await vi.advanceTimersByTimeAsync(15);
      await vi.advanceTimersByTimeAsync(15);
      await expect(result).resolves.toEqual({
        refined: 'Refine the request.',
        english: 'Refine the request.',
      });
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null on timeout and reports the timeout kind', async () => {
    const provider = makeProvider(
      (_req, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const onError = vi.fn();
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'fix the bug here',
      timeoutMs: 20,
      onError,
    });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(String), 'timeout');
  });

  it('stays silent (no onError) when the caller aborts', async () => {
    const controller = new AbortController();
    const provider = makeProvider(
      (_req, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const onError = vi.fn();
    const p = enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'fix the bug here',
      signal: controller.signal,
      onError,
    });
    controller.abort();
    expect(await p).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('buildRefinerContextSections', () => {
  it('collects relevant memory and current session state', async () => {
    const search = vi.fn(async () => []);
    const memoryStore = {
      search,
      scoreRelevant: vi.fn(async () => [
        {
          scope: 'project-memory',
          text: 'Use pnpm test filters for focused package checks.',
          ts: '2026-01-01T00:00:00.000Z',
          type: 'convention',
          priority: 'high',
          tags: ['tests'],
          score: 0.9,
          matchReason: 'test request',
        },
      ]),
    } as never;

    const sections = await buildRefinerContextSections({
      text: 'fix the prompt refining tests',
      memoryStore,
      context: {
        projectRoot: '/repo',
        workingDir: '/repo/packages/core',
        readFiles: new Set(['/repo/packages/core/src/execution/prompt-enhancer.ts']),
        writtenFiles: new Set(['/repo/packages/core/tests/execution/prompt-enhancer.test.ts']),
        todos: [
          { content: 'Wire retry context into WebUI', status: 'completed' },
          { content: 'Add focused tests for prompt refiner context', status: 'pending' },
        ],
      },
    });

    expect(search).not.toHaveBeenCalled();
    expect(sections).toEqual([
      {
        title: 'Relevant project memory',
        items: [
          '[project-memory/convention/high] Use pnpm test filters for focused package checks. tags: tests',
        ],
      },
      {
        title: 'Current session state',
        items: [
          'project root: /repo',
          'working dir: /repo/packages/core',
          'recently read file: /repo/packages/core/src/execution/prompt-enhancer.ts',
          'recently written file: /repo/packages/core/tests/execution/prompt-enhancer.test.ts',
          'open todo (pending): Add focused tests for prompt refiner context',
        ],
      },
    ]);
  });
});

describe('recentTextTurns', () => {
  const msg = (role: Message['role'], content: Message['content']): Message => ({ role, content });

  it('extracts user/assistant text turns oldest→newest', () => {
    const out = recentTextTurns([
      msg('user', 'first'),
      msg('assistant', [{ type: 'text', text: 'reply' }]),
      msg('user', 'second'),
    ]);
    expect(out).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply' },
      { role: 'user', text: 'second' },
    ]);
  });

  it('skips system messages and tool-only turns', () => {
    const out = recentTextTurns([
      msg('system', 'you are a bot'),
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'big output' }]),
      msg('assistant', [{ type: 'tool_use', id: 't1', name: 'read', input: {} }]),
      msg('user', 'real question'),
    ]);
    expect(out).toEqual([{ role: 'user', text: 'real question' }]);
  });

  it('keeps only the last maxTurns', () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg('user', `m${i}`));
    const out = recentTextTurns(messages, 3);
    expect(out.map((t) => t.text)).toEqual(['m7', 'm8', 'm9']);
  });

  it('truncates long turns to maxChars', () => {
    const out = recentTextTurns([msg('user', 'x'.repeat(100))], 6, 10);
    expect(out[0]!.text.length).toBe(10);
    expect(out[0]!.text.endsWith('…')).toBe(true);
  });
});

it('keeps selected skills when the refiner drops their mention tokens', () => {
  const candidate =
    'Review the current changes and report any defects with clear reproduction steps.';
  const result = parseBilingualEnhancement(
    `${candidate}\n---\n${candidate}`,
    '$code-review Review the current changes and report defects.',
  );
  expect(result?.refined).toContain('$code-review');
  expect(result?.english).toContain('$code-review');
});

// ---------------------------------------------------------------------------
// usage + outcome telemetry (F3: refiner tokens flow to the cost pipeline)
// ---------------------------------------------------------------------------

describe('usage + outcome telemetry', () => {
  it('completeRefinerPass surfaces direct-provider usage', async () => {
    const out = await completeRefinerPass('refine this', {
      provider: makeProvider(async () => textResponse('a\n---\nb')),
      request: { model: 'test' } as Request,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    expect(out.usage).toEqual({ input: 10, output: 5 });
  });

  it('completeRefinerPass maps one-shot orchestrator token totals into usage', async () => {
    const orchestrator = {
      call: vi.fn(async () => ({
        text: 'a\n---\nb',
        tokens: { input: 7, output: 3, total: 10 },
      })),
    };
    const out = await completeRefinerPass('refine this', {
      provider: makeProvider(async () => textResponse('unused')),
      request: { model: 'test' } as Request,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      oneShotOrchestrator: orchestrator as never,
    });
    expect(out.text).toBe('a\n---\nb');
    expect(out.usage).toEqual({ input: 7, output: 3 });
  });

  it('reports per-pass usage and a success outcome', async () => {
    const usageReports: Array<{ usage: Usage; pass: EnhancePassInfo }> = [];
    const outcomes: EnhanceOutcome[] = [];
    const result = await enhanceUserPrompt({
      provider: makeProvider(async () =>
        textResponse('the parser has a race condition\n---\nthe parser has a race condition'),
      ),
      model: 'test',
      text: 'fix the parser race please quickly',
      onUsage: (usage, pass) => usageReports.push({ usage, pass }),
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result).not.toBeNull();
    expect(usageReports).toEqual([
      { usage: { input: 10, output: 5 }, pass: { pass: 1, kind: 'initial' } },
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ result: 'success', passes: 1, parseRejections: 0 });
    expect(outcomes[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts parse rejections and the corrective pass', async () => {
    const responses = [
      textResponse('no separator in this response at all'),
      textResponse('the parser has a race condition\n---\nthe parser has a race condition'),
    ];
    let call = 0;
    const passes: EnhancePassInfo[] = [];
    const outcomes: EnhanceOutcome[] = [];
    const result = await enhanceUserPrompt({
      provider: makeProvider(async () => responses[Math.min(call++, responses.length - 1)]!),
      model: 'test',
      text: 'fix the parser race please quickly',
      onUsage: (_usage, pass) => passes.push(pass),
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result).not.toBeNull();
    expect(passes).toEqual([
      { pass: 1, kind: 'initial' },
      { pass: 2, kind: 'corrective' },
    ]);
    expect(outcomes[0]).toMatchObject({ result: 'success', passes: 2, parseRejections: 1 });
  });

  it('reports a timeout outcome when the pass exceeds its window', async () => {
    const onError = vi.fn();
    const outcomes: EnhanceOutcome[] = [];
    const result = await enhanceUserPrompt({
      provider: makeProvider(async (_req, { signal }) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
            once: true,
          });
        });
        return textResponse('unused');
      }),
      model: 'test',
      text: 'fix the parser race please quickly',
      timeoutMs: 20,
      onError,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'timeout');
    expect(outcomes[0]).toMatchObject({ result: 'timeout', passes: 1 });
  });

  it('reports cancelled without onError when the caller aborts (direct provider)', async () => {
    const controller = new AbortController();
    controller.abort();
    const onError = vi.fn();
    const outcomes: EnhanceOutcome[] = [];
    const result = await enhanceUserPrompt({
      provider: makeProvider(async (_req, { signal }) => {
        signal.throwIfAborted();
        return textResponse('unused');
      }),
      model: 'test',
      text: 'fix the parser race please quickly',
      signal: controller.signal,
      onError,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ result: 'cancelled' });
  });

  it('classifies a deadline hit as timeout even when the caller cancel races it', async () => {
    // Caller cancelled up-front; the deadline fires at 5ms; the provider's
    // late rejection lands at 20ms — by then BOTH abort flags are set, and
    // the fired deadline must win the classification.
    const controller = new AbortController();
    controller.abort();
    const onError = vi.fn();
    const outcomes: EnhanceOutcome[] = [];
    const result = await enhanceUserPrompt({
      provider: makeProvider(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('late provider failure');
      }),
      model: 'test',
      text: 'fix the parser race please quickly',
      signal: controller.signal,
      timeoutMs: 5,
      onError,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'timeout');
    expect(outcomes[0]).toMatchObject({ result: 'timeout', passes: 1 });
  });

  it('keeps the result and reports once when onOutcome throws', async () => {
    const onOutcome = vi.fn(() => {
      throw new Error('telemetry down');
    });
    const result = await enhanceUserPrompt({
      provider: makeProvider(async () =>
        textResponse('the parser has a race condition\n---\nthe parser has a race condition'),
      ),
      model: 'test',
      text: 'fix the parser race please quickly',
      onOutcome,
    });
    expect(result).not.toBeNull();
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it('classifies an orchestrator deadline as timeout, not provider_error', async () => {
    const onError = vi.fn();
    const outcomes: EnhanceOutcome[] = [];
    const orchestrator = {
      call: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { text: '', error: 'request timed out upstream' };
      }),
    };
    const result = await enhanceUserPrompt({
      provider: makeProvider(async () => textResponse('unused')),
      model: 'test',
      text: 'fix the parser race please quickly',
      timeoutMs: 5,
      oneShotOrchestrator: orchestrator as never,
      onError,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'timeout');
    expect(outcomes[0]).toMatchObject({ result: 'timeout', passes: 1 });
  });

  it('classifies orchestrator-path aborts as cancelled, not provider_error', async () => {
    const controller = new AbortController();
    controller.abort();
    const onError = vi.fn();
    const outcomes: EnhanceOutcome[] = [];
    const orchestrator = {
      call: vi.fn(async () => ({ text: '', error: 'aborted before completion' })),
    };
    const result = await enhanceUserPrompt({
      provider: makeProvider(async () => textResponse('unused')),
      model: 'test',
      text: 'fix the parser race please quickly',
      signal: controller.signal,
      oneShotOrchestrator: orchestrator as never,
      onError,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(result).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ result: 'cancelled' });
  });
});

describe('core execution barrel surface', () => {
  it('re-exports completeRefinerPass and ENHANCER_SYSTEM_PROMPT from both barrels', async () => {
    const execution = await import('../../src/execution/index.js');
    const publicApi = await import('../../src/public-execution.js');
    expect(typeof execution.completeRefinerPass).toBe('function');
    expect(typeof execution.ENHANCER_SYSTEM_PROMPT).toBe('string');
    expect(execution.ENHANCER_SYSTEM_PROMPT).toBe(ENHANCER_SYSTEM_PROMPT);
    expect(typeof publicApi.completeRefinerPass).toBe('function');
    expect(typeof publicApi.ENHANCER_SYSTEM_PROMPT).toBe('string');
    expect(publicApi.ENHANCER_SYSTEM_PROMPT).toBe(ENHANCER_SYSTEM_PROMPT);
  });
});
