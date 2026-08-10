import type { MessageRole, Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createSageDomainTermExtractorMiddleware,
  type SageDomainTermExtractorMiddlewareOptions,
} from '../src/middleware/domain-term-extractor-middleware.js';

function makeRequest(messages: ReadonlyArray<{ role: MessageRole; text: string }>): Request {
  return {
    model: 'test-model',
    messages: messages.map((m) => ({ role: m.role, content: m.text })),
  };
}

function makeFakeExtractor() {
  const extractFromConversation = vi.fn().mockReturnValue([]);
  const persistVia = vi.fn().mockResolvedValue({ added: 0, updated: 0, skipped: 0, outcomes: [] });
  const persistViaAndMirror = vi.fn().mockResolvedValue({
    report: { added: 0, updated: 0, skipped: 0, outcomes: [] },
    mirrorPath: '/tmp/.wrongstack/domain-terms.md',
  });
  return {
    instance: {
      extractFromConversation,
      persistVia,
      persistViaAndMirror,
    } as never,
    spies: { extractFromConversation, persistVia, persistViaAndMirror },
  };
}

function buildMiddleware(
  fake: ReturnType<typeof makeFakeExtractor>['instance'],
  opts: Omit<SageDomainTermExtractorMiddlewareOptions, 'extractorFactory'> & {
    extractorFactory?: SageDomainTermExtractorMiddlewareOptions['extractorFactory'];
  } = {},
) {
  return createSageDomainTermExtractorMiddleware({
    ...opts,
    extractorFactory: () => fake as never,
  });
}

describe('createSageDomainTermExtractorMiddleware', () => {
  it('passes through unchanged when memory port is omitted', async () => {
    const mw = buildMiddleware(makeFakeExtractor().instance, { projectRoot: '/tmp' });
    let called = false;
    const request = makeRequest([{ role: 'user', text: 'hi' }]);
    const result = await mw.handler(request, async (value) => {
      called = true;
      return value;
    });
    expect(called).toBe(true);
    expect(result).toBe(request);
  });

  it('passes through unchanged when projectRoot is omitted', async () => {
    const mw = buildMiddleware(makeFakeExtractor().instance, { memory: {} as never });
    let called = false;
    const request = makeRequest([]);
    const result = await mw.handler(request, async (value) => {
      called = true;
      return value;
    });
    expect(called).toBe(true);
    expect(result).toBe(request);
  });

  it('runs extraction after next() and persists via the canonical entry points', async () => {
    const fake = makeFakeExtractor();
    fake.spies.extractFromConversation.mockReturnValue([
      { term: 'WrongStack', definition: 'internal codename', confidence: 0.8, sources: [] },
    ]);
    fake.spies.persistViaAndMirror.mockResolvedValue({
      report: { added: 1, updated: 0, skipped: 0, outcomes: [] },
      mirrorPath: '/tmp/proj/.wrongstack/domain-terms.md',
    });

    const mw = buildMiddleware(fake.instance, {
      memory: { dummy: true } as never,
      projectRoot: '/tmp/proj',
    });
    const processed = makeRequest([
      { role: 'user', text: 'Build me a WrongStack component.' },
      { role: 'assistant', text: 'Sure, the WrongStack glossary is the contract.' },
    ]);
    const next = vi.fn().mockResolvedValue(processed);

    const result = await mw.handler(
      makeRequest([{ role: 'user', text: 'Build me a WrongStack component.' }]),
      next,
    );

    // Downstream request middleware runs first; extraction uses its result.
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toBe(processed);

    // Drain the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.spies.extractFromConversation).toHaveBeenCalledTimes(1);
    const extractArgs = fake.spies.extractFromConversation.mock.calls[0]?.[0] as {
      messages: ReadonlyArray<{ role: 'user' | 'agent'; text: string }>;
    };
    expect(extractArgs.messages).toEqual([
      { role: 'user', text: 'Build me a WrongStack component.' },
      { role: 'agent', text: 'Sure, the WrongStack glossary is the contract.' },
    ]);

    expect(fake.spies.persistViaAndMirror).toHaveBeenCalledTimes(1);
    expect(fake.spies.persistViaAndMirror).toHaveBeenCalledWith(
      { dummy: true },
      expect.any(Array),
      expect.objectContaining({ projectRoot: '/tmp/proj' }),
    );
  });

  it('skips persist and mirror when no candidates are produced', async () => {
    const fake = makeFakeExtractor();
    fake.spies.extractFromConversation.mockReturnValue([]);

    const mw = buildMiddleware(fake.instance, {
      memory: {} as never,
      projectRoot: '/tmp/proj',
    });
    const next = vi.fn(async (value: Request) => value);

    await mw.handler(makeRequest([{ role: 'user', text: 'no jargon here' }]), next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.spies.extractFromConversation).toHaveBeenCalledTimes(1);
    expect(fake.spies.persistVia).not.toHaveBeenCalled();
    expect(fake.spies.persistViaAndMirror).not.toHaveBeenCalled();
  });

  it('does not throw when extraction itself throws (fire-and-forget)', async () => {
    const fake = makeFakeExtractor();
    fake.spies.extractFromConversation.mockImplementation(() => {
      throw new Error('regex blew up');
    });
    const log = vi.fn();

    const mw = buildMiddleware(fake.instance, {
      memory: {} as never,
      projectRoot: '/tmp/proj',
      log,
    });
    const request = makeRequest([]);
    const next = vi.fn(async (value: Request) => value);

    const result = await mw.handler(request, next);
    expect(result).toBe(request);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.spies.persistVia).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0] as string).toMatch(/domain-term extraction failed/);
  });

  it('isolates extraction errors from the request response', async () => {
    const fake = makeFakeExtractor();
    fake.spies.extractFromConversation.mockReturnValue([
      { term: 'Jargon', definition: 'x', confidence: 0.9, sources: [] },
    ]);
    fake.spies.persistViaAndMirror.mockRejectedValue(new Error('disk full'));
    const log = vi.fn();

    const mw = buildMiddleware(fake.instance, {
      memory: {} as never,
      projectRoot: '/tmp/proj',
      log,
    });

    await mw.handler(
      makeRequest([{ role: 'user', text: 'Jargon lives here' }]),
      async (value) => value,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.spies.persistViaAndMirror).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0] as string).toMatch(/disk full/);
  });

  it('skips extraction silently when system-only messages are present', async () => {
    const fake = makeFakeExtractor();
    const mw = buildMiddleware(fake.instance, {
      memory: {} as never,
      projectRoot: '/tmp/proj',
    });
    const next = vi.fn(async (value: Request) => value);

    await mw.handler(makeRequest([{ role: 'system', text: 'You are a helpful assistant.' }]), next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.spies.extractFromConversation).toHaveBeenCalledTimes(1);
    // Empty snapshot -> no persist, no mirror.
    expect(fake.spies.persistVia).not.toHaveBeenCalled();
    expect(fake.spies.persistViaAndMirror).not.toHaveBeenCalled();
  });
});
