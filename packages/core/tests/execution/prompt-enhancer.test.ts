import { describe, expect, it, vi } from 'vitest';
import {
  enhanceUserPrompt,
  ENHANCER_SYSTEM_PROMPT,
  gatedEnhancerReasoning,
  normalizedEqual,
  recentTextTurns,
  shouldEnhance,
} from '../../src/execution/prompt-enhancer.js';
import type { Message } from '../../src/types/messages.js';
import type { Provider, ReasoningConfig, Request, Response } from '../../src/types/provider.js';

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
});

describe('ENHANCER_SYSTEM_PROMPT', () => {
  it('loads the file-backed helper prompt', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('request refiner');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('Output ONLY');
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

describe('enhanceUserPrompt', () => {
  it('returns a single English version for both fields (no "---")', async () => {
    const provider = makeProvider(async () =>
      textResponse('Fix the null-deref in auth.ts login() when the token is missing.'),
    );
    const out = await enhanceUserPrompt({ provider, model: 'm', text: 'fix the bug' });
    expect(out).toEqual({
      refined: 'Fix the null-deref in auth.ts login() when the token is missing.',
      english: 'Fix the null-deref in auth.ts login() when the token is missing.',
    });
  });

  it('does NOT report an error for a single-version (English) response', async () => {
    const onError = vi.fn();
    const provider = makeProvider(async () => textResponse('Refined English instruction.'));
    const out = await enhanceUserPrompt({
      provider,
      model: 'm',
      text: 'refine this please',
      onError,
    });
    expect(out).toEqual({
      refined: 'Refined English instruction.',
      english: 'Refined English instruction.',
    });
    // A single version is now the legitimate English fast path, not a format error.
    expect(onError).not.toHaveBeenCalled();
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

  it('keeps a "---" that appears inside the English version (splits on the first only)', async () => {
    const provider = makeProvider(async () =>
      textResponse('Türkçe sürüm.\n---\nEnglish version.\n---\nstill English.'),
    );
    const out = await enhanceUserPrompt({ provider, model: 'm', text: 'bir şey yap' });
    expect(out).toEqual({
      refined: 'Türkçe sürüm.',
      english: 'English version.\n---\nstill English.',
    });
  });

  it('sends the enhancer system prompt and the raw text as a user message', async () => {
    const complete = vi.fn(async () => textResponse('refined'));
    const provider = makeProvider(complete);
    await enhanceUserPrompt({ provider, model: 'gpt-x', text: 'do the thing properly' });
    const req = complete.mock.calls[0]![0] as Request;
    expect(req.model).toBe('gpt-x');
    expect(req.system?.[0]?.text).toMatch(/request refiner/i);
    expect(req.messages).toEqual([{ role: 'user', content: 'do the thing properly' }]);
  });

  it('embeds conversation history as context in a single user message', async () => {
    const complete = vi.fn(async () => textResponse('refined'));
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

  it('forwards a reasoning directive when supplied', async () => {
    const complete = vi.fn(async () => textResponse('refined'));
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
    const complete = vi.fn(async () => textResponse('refined'));
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
    const out = await enhanceUserPrompt({ provider, model: 'm', text: 'fix the bug here', onError });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(String), 'provider_error');
  });

  it('returns null when the provider yields empty text', async () => {
    const provider = makeProvider(async () => textResponse('   '));
    const onError = vi.fn();
    const out = await enhanceUserPrompt({ provider, model: 'm', text: 'fix the bug here', onError });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(String), 'empty');
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
