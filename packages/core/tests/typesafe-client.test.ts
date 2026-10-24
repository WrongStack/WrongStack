import { FetchError } from '@wrongstack/contracts/types/errors';
import { describe, expect, it, vi } from 'vitest';
import {
  createTypeSafeClient,
  DEFAULT_TYPESAFE_ENDPOINT,
  DEFAULT_TYPESAFE_MODEL,
  parseSystemOneResult,
} from '../src/typesafe/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseSystemOneResult', () => {
  it('parses noul and choice answers', () => {
    const result = parseSystemOneResult({
      model: 'jev-latest',
      answers: {
        urgent: { type: 'noul', noul: 0.92 },
        which: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.85, technical: 0.15 },
          confidence: 0.82,
        },
      },
      usage: { input_tokens: 312, output_tokens: 48 },
    });
    expect(result.answers['urgent']).toEqual({ type: 'noul', noul: 0.92 });
    expect(result.answers['which']).toMatchObject({ choice: 'billing', confidence: 0.82 });
    expect(result.usage).toEqual({ inputTokens: 312, outputTokens: 48 });
  });

  it('drops malformed answers instead of coercing them', () => {
    // A caller reading a dropped id gets `undefined` and takes its own "no
    // answer" path. Coercing these would put a made-up probability in front of
    // a real decision.
    const result = parseSystemOneResult({
      answers: {
        missing_value: { type: 'noul' },
        not_a_number: { type: 'noul', noul: 'high' },
        no_choice: { type: 'choice', probabilities: { a: 1 }, confidence: 1 },
        no_score: { type: 'score', probabilities: { '0': 1 }, confidence: 1 },
        unknown_type: { type: 'rank', value: 1 },
        good: { type: 'noul', noul: 0.4 },
      },
    });
    expect(Object.keys(result.answers)).toEqual(['good']);
  });

  it('rejects out-of-range probabilities and tolerates a missing usage block', () => {
    const result = parseSystemOneResult({
      answers: { n: { type: 'noul', noul: 1.4 }, m: { type: 'noul', noul: -0.2 } },
    });
    expect(result.answers).toEqual({});
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it.each([
    { choice: 'a', probabilities: {}, confidence: 1 },
    { choice: 'a', probabilities: { b: 1 }, confidence: 1 },
    { choice: 'a', probabilities: { a: 2, b: -1 }, confidence: 1 },
    { choice: 'a', probabilities: { a: 0.1, b: 0.9 }, confidence: 1 },
    { choice: 'a', probabilities: { a: 0.8, b: 0.8 }, confidence: 1 },
    { choice: 'a', probabilities: { a: 1 }, confidence: 3 },
  ])('drops an invalid choice distribution: %j', (answer) => {
    expect(parseSystemOneResult({ answers: { q: { type: 'choice', ...answer } } }).answers).toEqual(
      {},
    );
  });

  it('returns an empty result for a body that is not an object', () => {
    expect(parseSystemOneResult('nope').answers).toEqual({});
    expect(parseSystemOneResult(null).answers).toEqual({});
  });
});

describe('createTypeSafeClient', () => {
  it('does not contact the host after cancellation during retry backoff', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
      const client = createTypeSafeClient({ apiKey: 'k', fetchImpl });
      const pending = client.systemOne({ state: 's', questions: {} }, ctrl.signal);
      const rejected = expect(pending).rejects.toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      ctrl.abort();
      await vi.runAllTimersAsync();
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('posts state, model and questions to the documented endpoint with bearer auth', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ answers: {}, usage: {} }));
    const client = createTypeSafeClient({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });

    await client.systemOne({
      state: { request: 'hello' },
      questions: { q: { type: 'noul', instructions: 'yes?' } },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DEFAULT_TYPESAFE_ENDPOINT);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toEqual({
      state: { request: 'hello' },
      model: DEFAULT_TYPESAFE_MODEL,
      questions: { q: { type: 'noul', instructions: 'yes?' } },
    });
  });

  it('retries a 529 and returns the successful attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'overloaded' }, 529))
      .mockResolvedValueOnce(jsonResponse({ answers: { q: { type: 'noul', noul: 0.7 } } }));
    const client = createTypeSafeClient({ apiKey: 'k', fetchImpl: fetchImpl as never });

    const result = await client.systemOne({ state: 's', questions: {} });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.answers['q']).toEqual({ type: 'noul', noul: 0.7 });
  });

  it('does not retry a 401 — the second attempt would fail identically', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    const client = createTypeSafeClient({ apiKey: 'bad', fetchImpl: fetchImpl as never });

    await expect(client.systemOne({ state: 's', questions: {} })).rejects.toBeInstanceOf(
      FetchError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a transport failure as FetchError with status 0', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const client = createTypeSafeClient({
      apiKey: 'k',
      maxAttempts: 1,
      fetchImpl: fetchImpl as never,
    });

    const err = await client.systemOne({ state: 's', questions: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(0);
    // The key rides in a header, never in the URL, so the error context cannot
    // carry it into a log.
    expect(JSON.stringify(err)).not.toContain('k');
  });

  it('rejects a non-JSON body rather than handing back a half-parsed result', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }));
    const client = createTypeSafeClient({
      apiKey: 'k',
      maxAttempts: 1,
      fetchImpl: fetchImpl as never,
    });
    await expect(client.systemOne({ state: 's', questions: {} })).rejects.toBeInstanceOf(
      FetchError,
    );
  });
});

describe('score answers and usage accounting', () => {
  it('parses a score answer without clamping the score to a probability', () => {
    // `score` is a position across the levels we sent, not a 0..1 chance. An
    // earlier version dropped score answers entirely; clamping them would be
    // the same mistake with a number attached.
    const result = parseSystemOneResult({
      model: 'jev-1.13.0',
      answers: {
        severity: {
          type: 'score',
          score: 3.4,
          probabilities: { '0': 0.05, '1': 0.1, '2': 0.2, '3': 0.4, '4': 0.25 },
          confidence: 0.61,
          legend: { '0': 'no impact', '4': 'outage' },
        },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    expect(result.answers['severity']).toMatchObject({ type: 'score', score: 3.4 });
    expect(result.model).toBe('jev-1.13.0');
  });

  it('drops a score answer with no numeric score', () => {
    const result = parseSystemOneResult({
      answers: { bad: { type: 'score', probabilities: {}, confidence: 1 } },
    });
    expect(result.answers['bad']).toBeUndefined();
  });

  it('reports usage once per successful response and never fails the call', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 99, output_tokens: 0 },
      }),
    );
    const onUsage = vi.fn((_usage: { inputTokens: number; model?: string | undefined }) => {
      throw new Error('sink exploded');
    });
    const client = createTypeSafeClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as never,
      onUsage,
    });
    const result = await client.systemOne({ state: 's', questions: {} });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ inputTokens: 99, model: 'jev-1.13.0' });
    // An accounting sink must not be able to fail the judgment it accounts for.
    expect(result.answers['q']).toEqual({ type: 'noul', noul: 0.5 });
  });
});
