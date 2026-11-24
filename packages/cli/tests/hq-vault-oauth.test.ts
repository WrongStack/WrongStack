/**
 * Provider sign-ins run on HQ: a fake strategy stands in for the provider (its
 * browser and device-code shapes are the engine's own), the store is real.
 * A finished sign-in lands on a vault profile with its refresh token kept on
 * HQ; the paste-code path works when HQ's loopback callback is not listening.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategyMetadata,
} from '@wrongstack/contracts/types';
import { type HqVaultProfileMeta, HqVaultStore } from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HqVaultAuthRegistry,
  HqVaultSignInError,
  HqVaultSignIns,
} from '../src/hq-server/routes/vault-oauth.js';

let root: string;
let store: HqVaultStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-oauth-'));
  store = await HqVaultStore.open(path.join(root, '.wrongstack', 'hq'), undefined);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const OUTCOME: ProviderAuthOutcome = {
  providerId: 'openai-codex',
  family: 'openai-codex',
  models: ['gpt-5.5-codex'],
  credential: {
    label: 'chatgpt',
    apiKey: 'access-token-0001',
    refreshToken: 'refresh-token-secret',
    createdAt: '2026-11-24T10:00:00Z',
    authMethod: 'oauth',
    expiresAt: '2026-11-24T11:00:00Z',
    accountId: 'acct-1',
  },
};

/** A strategy whose completion the test releases. */
function fakeRegistry(kind: 'device' | 'browser-bound' | 'browser-unbound'): {
  registry: HqVaultAuthRegistry;
  complete: (outcome: ProviderAuthOutcome | null) => void;
  closed: () => number;
} {
  let release: (outcome: ProviderAuthOutcome | null) => void = () => undefined;
  let closed = 0;
  const meta: ProviderAuthStrategyMetadata = {
    id: 'chatgpt',
    providerId: 'openai-codex',
    label: 'ChatGPT',
    interactionTypes: [kind === 'device' ? 'device_code' : 'browser'],
  };
  const registry: HqVaultAuthRegistry = {
    list: () => [meta],
    resolveId: (id) => (id === 'chatgpt' || id === 'codex' ? 'chatgpt' : undefined),
    async begin(): Promise<ProviderAuthSession> {
      const done = new Promise<ProviderAuthOutcome | null>((resolve) => {
        release = resolve;
      });
      return {
        strategyId: 'chatgpt',
        providerId: 'openai-codex',
        interaction:
          kind === 'device'
            ? {
                type: 'device_code',
                verificationUri: 'https://example.test/device',
                userCode: 'ABCD-1234',
              }
            : {
                type: 'browser',
                authorizeUrl: 'https://auth.example.test/authorize?x=1',
                bound: kind === 'browser-bound',
              },
        waitForCompletion: () => done,
        async completeWithCode(input) {
          if (!input.includes('code=')) throw new Error('That is not the redirected URL.');
          return OUTCOME;
        },
        close: () => {
          closed += 1;
        },
      };
    },
  };
  return { registry, complete: (o) => release(o), closed: () => closed };
}

async function settle(signIns: HqVaultSignIns, id: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { phase } = signIns.view(id);
    if (phase === 'success' || phase === 'error') return phase;
    await new Promise((r) => setTimeout(r, 10));
  }
  return signIns.view(id).phase;
}

function signInsFor(registry: HqVaultAuthRegistry): HqVaultSignIns {
  return new HqVaultSignIns(
    registry,
    (input, actor) => store.saveSignIn(input, actor),
    () => undefined,
  );
}

describe('HQ sign-ins', () => {
  it('a device-code sign-in lands on a new profile, refresh token kept on HQ', async () => {
    const fake = fakeRegistry('device');
    const signIns = signInsFor(fake.registry);
    const started = await signIns.start('codex', undefined, 'admin');
    expect(started).toMatchObject({
      phase: 'awaiting_code',
      userCode: 'ABCD-1234',
      profileId: 'openai-codex',
    });
    fake.complete(OUTCOME);
    expect(await settle(signIns, started.attemptId)).toBe('success');
    expect(signIns.view(started.attemptId).profile).toMatchObject({
      id: 'openai-codex',
      family: 'openai-codex',
      models: ['gpt-5.5-codex'],
      activeKey: 'chatgpt',
      keys: [
        expect.objectContaining({
          label: 'chatgpt',
          authMethod: 'oauth',
          signIn: 'chatgpt',
          accountId: 'acct-1',
          expiresAt: '2026-11-24T11:00:00.000Z',
        }),
      ],
    });
    expect(fake.closed()).toBe(1);
    const raw = await fs.readFile(path.join(root, '.wrongstack', 'hq', 'hq-vault.json'), 'utf8');
    expect(raw).not.toMatch(/refresh-token-secret|access-token-0001/);
    const audit = await store.readAudit(5);
    expect(audit[0]).toMatchObject({
      kind: 'oauth.signin',
      profileId: 'openai-codex',
      detail: 'chatgpt',
    });
  });

  it('a browser sign-in HQ cannot receive is finished by pasting the redirected URL', async () => {
    const fake = fakeRegistry('browser-unbound');
    const signIns = signInsFor(fake.registry);
    const started = await signIns.start('chatgpt', 'work-chatgpt', 'admin');
    expect(started).toMatchObject({
      phase: 'awaiting_browser',
      bound: false,
      profileId: 'work-chatgpt',
    });
    const wrong = await signIns.code(started.attemptId, 'nonsense', 'admin');
    expect(wrong).toMatchObject({ phase: 'error', message: 'That is not the redirected URL.' });

    const again = await signIns.start('chatgpt', 'work-chatgpt', 'admin');
    const done = await signIns.code(again.attemptId, 'http://localhost:1455/cb?code=abc', 'admin');
    expect(done).toMatchObject({ phase: 'success', profileId: 'work-chatgpt' });
    expect(store.getProfile('work-chatgpt')).toMatchObject({
      type: 'openai-codex',
      activeKey: 'chatgpt',
    });
  });

  it('refuses to sign in onto a profile of another provider', async () => {
    await store.createProfile({ id: 'openai' }, 'admin');
    const fake = fakeRegistry('browser-bound');
    const signIns = signInsFor(fake.registry);
    const started = await signIns.start('chatgpt', 'openai', 'admin');
    fake.complete(OUTCOME);
    expect(await settle(signIns, started.attemptId)).toBe('error');
    expect(signIns.view(started.attemptId).message).toMatch(/belongs to openai/);
  });

  it('cancels, rejects unknown sign-ins, and caps attempts in flight', async () => {
    const fake = fakeRegistry('device');
    const signIns = signInsFor(fake.registry);
    await expect(signIns.start('claude', undefined, 'admin')).rejects.toMatchObject({
      status: 400,
    });
    const first = await signIns.start('chatgpt', undefined, 'admin');
    expect(signIns.cancel(first.attemptId)).toMatchObject({
      phase: 'error',
      message: 'Sign-in cancelled.',
    });
    // A late completion of a cancelled attempt stores nothing.
    fake.complete(OUTCOME);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.listProfiles()).toEqual([]);
    for (let i = 0; i < 4; i++) await signIns.start('chatgpt', undefined, 'admin');
    await expect(signIns.start('chatgpt', undefined, 'admin')).rejects.toMatchObject({
      status: 409,
    });
    expect(() => signIns.view('f'.repeat(24))).toThrow(/No such sign-in/);
  });
});

/**
 * HQ's own loopback callback and a pasted code can complete the same
 * authorization code at once. The code is spent either way, so a failure on
 * one path must not settle the attempt while the other is still exchanging:
 * that would discard a successful sign-in and make the operator redo the flow.
 */
describe('HQ sign-ins with two completion paths', () => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    return { promise, resolve, reject };
  }

  /** A bound browser sign-in whose callback and pasted code the test releases. */
  function twoPathHarness(): {
    signIns: HqVaultSignIns;
    callback: Deferred<ProviderAuthOutcome | null>;
    exchange: Deferred<ProviderAuthOutcome>;
    saved: ProviderAuthOutcome[];
  } {
    const callback = deferred<ProviderAuthOutcome | null>();
    const exchange = deferred<ProviderAuthOutcome>();
    const saved: ProviderAuthOutcome[] = [];
    const meta: ProviderAuthStrategyMetadata = {
      id: 'chatgpt',
      providerId: 'openai-codex',
      label: 'ChatGPT',
      interactionTypes: ['browser'],
    };
    const registry: HqVaultAuthRegistry = {
      list: () => [meta],
      resolveId: (id) => (id === 'chatgpt' ? 'chatgpt' : undefined),
      async begin(): Promise<ProviderAuthSession> {
        return {
          strategyId: 'chatgpt',
          providerId: 'openai-codex',
          interaction: {
            type: 'browser',
            authorizeUrl: 'https://auth.example.test/authorize?x=1',
            bound: true,
          },
          waitForCompletion: () => callback.promise,
          completeWithCode: () => exchange.promise,
          close: () => undefined,
        };
      },
    };
    const signIns = new HqVaultSignIns(
      registry,
      async (input) => {
        saved.push(input.result.credential as unknown as ProviderAuthOutcome);
        return {
          id: input.profileId ?? input.result.providerId,
        } as unknown as HqVaultProfileMeta;
      },
      () => undefined,
    );
    return { signIns, callback, exchange, saved };
  }

  it('keeps a pasted sign-in that succeeds after HQ’s callback failed', async () => {
    const h = twoPathHarness();
    const started = await h.signIns.start('chatgpt', 'work-chatgpt', 'admin');
    expect(started).toMatchObject({ phase: 'awaiting_browser', bound: true });
    const pasted = h.signIns.code(started.attemptId, 'http://localhost:1455/cb?code=abc', 'admin');
    expect(h.signIns.view(started.attemptId).phase).toBe('exchanging');
    h.callback.reject(new Error('HQ could not complete the callback'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.exchange.resolve(OUTCOME);
    await pasted;
    expect(h.saved).toHaveLength(1);
    expect(h.signIns.view(started.attemptId)).toMatchObject({
      phase: 'success',
      profileId: 'work-chatgpt',
    });
  });

  it('still reports a callback failure when nothing else completes the sign-in', async () => {
    const h = twoPathHarness();
    const started = await h.signIns.start('chatgpt', undefined, 'admin');
    h.callback.reject(new Error('HQ could not complete the callback'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.signIns.view(started.attemptId)).toMatchObject({
      phase: 'error',
      message: 'HQ could not complete the callback',
    });
    expect(h.saved).toHaveLength(0);
  });
});

/**
 * Concurrent starts must not all pass the in-flight cap. The check counts the
 * live attempts, so a slot has to be reserved before the provider call — a
 * check that only counted registered attempts let a burst register far more
 * than the documented maximum, each holding a provider session (and, for a
 * browser sign-in, a callback port).
 */
describe('HQ sign-ins under concurrent starts', () => {
  interface Gate {
    promise: Promise<void>;
    resolve: () => void;
  }

  function gate(): Gate {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** A sign-in engine the test can hold mid-`begin`. */
  function heldSignIns(hold: { current: Gate | undefined }): HqVaultSignIns {
    const meta: ProviderAuthStrategyMetadata = {
      id: 'chatgpt',
      providerId: 'openai-codex',
      label: 'ChatGPT',
      interactionTypes: ['browser'],
    };
    const registry: HqVaultAuthRegistry = {
      list: () => [meta],
      resolveId: (id) => (id === 'chatgpt' ? 'chatgpt' : undefined),
      async begin(): Promise<ProviderAuthSession> {
        const pending = hold.current;
        if (pending) await pending.promise;
        return {
          strategyId: 'chatgpt',
          providerId: 'openai-codex',
          interaction: {
            type: 'browser',
            authorizeUrl: 'https://auth.example.test/authorize?x=1',
            bound: false,
          },
          waitForCompletion: () => new Promise<ProviderAuthOutcome | null>(() => undefined),
          completeWithCode: async () => OUTCOME,
          close: () => undefined,
        };
      },
    };
    return new HqVaultSignIns(
      registry,
      async () => ({ id: 'openai-codex' }) as unknown as HqVaultProfileMeta,
      () => undefined,
    );
  }

  it('refuses a concurrent burst past the cap instead of registering them all', async () => {
    const hold: { current: Gate | undefined } = { current: undefined };
    const signIns = heldSignIns(hold);
    try {
      for (let i = 0; i < 3; i++) await signIns.start('chatgpt', undefined, 'admin');
      hold.current = gate();
      // Handlers attach at creation, so the refusal is never an unobserved rejection.
      const settle = (pending: Promise<unknown>) =>
        pending.then(
          () => 'accepted' as const,
          (error: unknown) =>
            error instanceof HqVaultSignInError ? `refused:${error.status}` : 'failed',
        );
      const first = settle(signIns.start('chatgpt', undefined, 'admin'));
      const second = settle(signIns.start('chatgpt', undefined, 'admin'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      hold.current.resolve();
      expect(await Promise.all([first, second])).toEqual(['accepted', 'refused:409']);
    } finally {
      signIns.close();
    }
  });
});
