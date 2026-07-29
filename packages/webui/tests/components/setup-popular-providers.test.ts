import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_POPULAR_PROVIDERS,
  loadPopularProviders,
  type PopularProvider,
} from '../../src/components/SetupScreen/popular-providers';

const URL = 'https://example.test/providers.json';

/** Install a `fetch` stub returning the given Response-ish object. */
function stubFetch(impl: () => unknown) {
  const spy = vi.fn(async () => impl() as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const REMOTE: PopularProvider[] = [
  { id: 'acme', name: 'Acme AI', family: 'openai' } as PopularProvider,
  { id: 'zeta', name: 'Zeta', family: 'anthropic' } as PopularProvider,
];

describe('DEFAULT_POPULAR_PROVIDERS', () => {
  it('is projected from the real provider catalog and is non-empty', () => {
    expect(DEFAULT_POPULAR_PROVIDERS.length).toBeGreaterThan(0);
  });

  it('carries the id/name/family shape the loader validates against', () => {
    for (const p of DEFAULT_POPULAR_PROVIDERS) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.family).toBe('string');
    }
  });
});

describe('loadPopularProviders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the remote catalog when the response is a valid non-empty array', async () => {
    stubFetch(() => okJson(REMOTE));
    await expect(loadPopularProviders(URL)).resolves.toEqual(REMOTE);
  });

  it('forwards the AbortSignal to fetch', async () => {
    const spy = stubFetch(() => okJson(REMOTE));
    const controller = new AbortController();
    await loadPopularProviders(URL, controller.signal);
    expect(spy).toHaveBeenCalledWith(URL, { signal: controller.signal });
  });

  it('passes signal: undefined when none is supplied', async () => {
    const spy = stubFetch(() => okJson(REMOTE));
    await loadPopularProviders(URL);
    expect(spy).toHaveBeenCalledWith(URL, { signal: undefined });
  });

  it('falls back to the bundled defaults on a non-OK response', async () => {
    stubFetch(() => ({ ok: false, status: 503, json: async () => REMOTE }));
    await expect(loadPopularProviders(URL)).resolves.toBe(DEFAULT_POPULAR_PROVIDERS);
  });

  it('falls back when the payload is not an array', async () => {
    stubFetch(() => okJson({ providers: REMOTE }));
    await expect(loadPopularProviders(URL)).resolves.toBe(DEFAULT_POPULAR_PROVIDERS);
  });

  it('falls back when the network call rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(loadPopularProviders(URL)).resolves.toBe(DEFAULT_POPULAR_PROVIDERS);
  });

  it('falls back when the body is not valid JSON', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    await expect(loadPopularProviders(URL)).resolves.toBe(DEFAULT_POPULAR_PROVIDERS);
  });

  it('drops entries missing id, name or family', async () => {
    stubFetch(() =>
      okJson([
        { id: 'good', name: 'Good', family: 'openai' },
        { name: 'No id', family: 'openai' },
        { id: 'no-name', family: 'openai' },
        { id: 'no-family', name: 'No family' },
        { id: 42, name: 'Numeric id', family: 'openai' },
      ]),
    );
    await expect(loadPopularProviders(URL)).resolves.toEqual([
      { id: 'good', name: 'Good', family: 'openai' },
    ]);
  });

  it('falls back to defaults when every remote entry is invalid', async () => {
    stubFetch(() => okJson([{ nope: true }, { id: 1 }]));
    await expect(loadPopularProviders(URL)).resolves.toBe(DEFAULT_POPULAR_PROVIDERS);
  });

  it('falls back to defaults on an empty array rather than rendering nothing', async () => {
    stubFetch(() => okJson([]));
    await expect(loadPopularProviders(URL)).resolves.toBe(DEFAULT_POPULAR_PROVIDERS);
  });
});
