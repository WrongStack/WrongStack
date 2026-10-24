/**
 * Route selection, the three account states, and the auth breaker.
 *
 * The behaviour under test here is mostly about what does NOT happen: a stray
 * `OPENROUTER_API_KEY` must not reroute a configured TypeSafe account, an
 * unconfigured install must not report a problem, and a rate limit must not
 * disable a feature.
 */

import { FetchError } from '@wrongstack/contracts/types/errors';
import { describe, expect, it, vi } from 'vitest';
import {
  createTypeSafeBreaker,
  resolveTypeSafeAccount,
  resolveTypeSafeRoute,
  TYPESAFE_ROUTES,
  TypeSafeDisabledError,
} from '../src/typesafe/index.js';

const noEnv: NodeJS.ProcessEnv = {};

function fetchError(status: number): FetchError {
  return new FetchError({ message: `boom ${status}`, status, context: { op: 'test' } });
}

describe('resolveTypeSafeRoute', () => {
  it('infers the native route from a configured key', () => {
    expect(resolveTypeSafeRoute({ typesafe: { enabled: true, apiKey: 'k' } }, noEnv)).toBe(
      'typesafe',
    );
  });

  it('never infers openrouter from a chat OPENROUTER_API_KEY alone', () => {
    // That key is almost always there for chat. Inferring the route from it
    // moved prompt egress and billing to OpenRouter without the user choosing
    // it for this feature; the route must be named explicitly.
    expect(resolveTypeSafeRoute({}, { OPENROUTER_API_KEY: 'sk-or-x' })).toBe('typesafe');
    const account = resolveTypeSafeAccount({
      config: { typesafe: { enabled: true } },
      env: { OPENROUTER_API_KEY: 'sk-or-x' },
    });
    expect(account.status).toBe('unconfigured');
  });

  it('prefers TypeSafe when both credentials are in the environment', () => {
    // A chat OpenRouter key sitting in the shell must not silently move an
    // existing TypeSafe setup to another host — or another bill.
    expect(
      resolveTypeSafeRoute({}, { OPENROUTER_API_KEY: 'sk-or-x', TYPESAFE_API_KEY: 'ts' }),
    ).toBe('typesafe');
  });

  it('treats an explicit endpoint as the custom route', () => {
    expect(
      resolveTypeSafeRoute({ typesafe: { enabled: true, endpoint: 'https://proxy/x' } }, noEnv),
    ).toBe('custom');
  });

  it('honours an explicit route over inference', () => {
    expect(resolveTypeSafeRoute({ typesafe: { enabled: true, route: 'openrouter' } }, noEnv)).toBe(
      'openrouter',
    );
  });
});

describe('resolveTypeSafeAccount', () => {
  it.each(['not a URL', 'file:///tmp/jev', 'https://user:secret@proxy.test/decisions'])(
    'reports an unusable endpoint: %s',
    (endpoint) => {
      expect(
        resolveTypeSafeAccount({
          config: { typesafe: { enabled: true, endpoint, apiKey: 'k' } },
          env: noEnv,
        }).status,
      ).toBe('unusable');
    },
  );
  it('reports unconfigured when nothing is set, naming the variable to set', () => {
    const account = resolveTypeSafeAccount({ config: { typesafe: { enabled: true } }, env: noEnv });
    expect(account.status).toBe('unconfigured');
    expect(account.status === 'unconfigured' && account.reason).toContain('TYPESAFE_API_KEY');
  });

  it('applies the route endpoint and model when ready', () => {
    const account = resolveTypeSafeAccount({
      config: { typesafe: { enabled: true, route: 'openrouter' } },
      env: { OPENROUTER_API_KEY: 'sk-or-x' },
    });
    expect(account.status).toBe('ready');
    if (account.status !== 'ready') return;
    expect(account.endpoint).toBe(TYPESAFE_ROUTES.openrouter.url);
    expect(account.model).toBe(TYPESAFE_ROUTES.openrouter.model);
    expect(account.keySource).toBe('env');
    expect(account.keyEnv).toBe('OPENROUTER_API_KEY');
  });

  it('prefers a configured key over the environment and says so', () => {
    const account = resolveTypeSafeAccount({
      config: { typesafe: { enabled: true, apiKey: 'from-config' } },
      env: { TYPESAFE_API_KEY: 'from-env' },
    });
    expect(account.status === 'ready' && account.keySource).toBe('config');
  });

  it('keeps an explicit endpoint but does not force a route model onto it', () => {
    const account = resolveTypeSafeAccount({
      config: {
        typesafe: { enabled: true, endpoint: 'https://proxy.internal/systemone', apiKey: 'k' },
      },
      env: noEnv,
    });
    expect(account.status).toBe('ready');
    if (account.status !== 'ready') return;
    expect(account.route).toBe('custom');
    expect(account.endpoint).toBe('https://proxy.internal/systemone');
    // A proxy in front of TypeSafe speaks TypeSafe's model names, never
    // OpenRouter's.
    expect(account.model).toBe(TYPESAFE_ROUTES.typesafe.model);
  });

  it('reports unusable — not unconfigured — for a custom route with no endpoint', () => {
    const account = resolveTypeSafeAccount({
      config: { typesafe: { enabled: true, route: 'custom', apiKey: 'k' } },
      env: noEnv,
    });
    expect(account.status).toBe('unusable');
  });
});

describe('createTypeSafeBreaker', () => {
  const req = { state: 's', questions: {} };

  it('opens after the threshold of consecutive auth rejections', async () => {
    const systemOne = vi.fn(async () => {
      throw fetchError(401);
    });
    const onOpen = vi.fn();
    const breaker = createTypeSafeBreaker({
      client: { systemOne } as never,
      threshold: 2,
      onOpen,
    });

    await expect(breaker.systemOne(req)).rejects.toBeInstanceOf(FetchError);
    expect(breaker.open).toBe(false);
    await expect(breaker.systemOne(req)).rejects.toBeInstanceOf(FetchError);
    expect(breaker.open).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Once open, nothing reaches the network again.
    await expect(breaker.systemOne(req)).rejects.toBeInstanceOf(TypeSafeDisabledError);
    expect(systemOne).toHaveBeenCalledTimes(2);
  });

  it('never opens on rate limits or network errors', async () => {
    const systemOne = vi
      .fn()
      .mockRejectedValueOnce(fetchError(429))
      .mockRejectedValueOnce(fetchError(529))
      .mockRejectedValueOnce(fetchError(0));
    const breaker = createTypeSafeBreaker({ client: { systemOne } as never, threshold: 2 });
    for (let i = 0; i < 3; i++) await breaker.systemOne(req).catch(() => undefined);
    expect(breaker.open).toBe(false);
  });

  it('resets the count on a success so a rotated key recovers without a restart', async () => {
    const ok = { answers: {}, usage: { inputTokens: 0, outputTokens: 0 }, model: 'jev' };
    const systemOne = vi
      .fn()
      .mockRejectedValueOnce(fetchError(401))
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(fetchError(401));
    const breaker = createTypeSafeBreaker({ client: { systemOne } as never, threshold: 2 });
    await breaker.systemOne(req).catch(() => undefined);
    await breaker.systemOne(req);
    await breaker.systemOne(req).catch(() => undefined);
    expect(breaker.open).toBe(false);
  });
});
