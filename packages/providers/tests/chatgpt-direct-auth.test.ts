import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderApiKey } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createChatGPTDirectAuthStrategy,
  refreshChatGPTDirect,
} from '../src/oauth/chatgpt-direct.js';
import { chatGPTHostId } from '../src/oauth/chatgpt-host.js';
import { verifyChatGPTIdentity } from '../src/oauth/chatgpt-identity.js';
import { CODEX_CLIENT_VERSION } from '../src/oauth/codex-protocol.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'identity-key',
  alg: 'RS256',
  use: 'sig',
};
const hostId = 'urn:uuid:e61bbe28-07ef-466d-8e5d-a344f94ab305';
const planScope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const tokenUrl = 'https://auth.openai.com/api/accounts/oauth/token';

function idToken(
  clientId: string,
  nonce?: string,
  overrides: Record<string, unknown> = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'identity-key' })).toString(
    'base64url',
  );
  const claims = Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      aud: clientId,
      sub: 'verified-user',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      ...overrides,
    }),
  ).toString('base64url');
  return `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url')}`;
}

function fetcher(
  getNonce: () => string | undefined,
  options: { scope?: string; claims?: Record<string, unknown> } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init?.redirect).toBe('error');
    if (url === tokenUrl) {
      const fields = new URLSearchParams(String(init?.body));
      expect(fields.get('resource')).toBe('https://api.openai.com/v1');
      return Response.json({
        access_token: 'direct-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        scope: options.scope ?? planScope,
        id_token: idToken(fields.get('client_id')!, getNonce(), options.claims),
      });
    }
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    // The plan API gates its catalog on the Codex client version exactly like
    // the Codex backend; a bare request returns only the oldest model set.
    expect(url).toBe(`https://api.openai.com/v1/models?client_version=${CODEX_CLIENT_VERSION}`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer direct-access');
    return Response.json({
      models: [
        {
          slug: 'account-model',
          display_name: 'Account model',
          visibility: 'list',
          context_window: 400000,
        },
        { slug: 'hidden-model', visibility: 'hide' },
      ],
    });
  });
}

function callbackUrl(authorize: URL, clientId?: string): URL {
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', authorize.searchParams.get('state')!);
  callback.searchParams.set('code', 'one-time-code');
  if (clientId) callback.searchParams.set('client_id', clientId);
  return callback;
}

function existing(): ProviderApiKey {
  return {
    label: 'personal',
    apiKey: 'old-access',
    refreshToken: 'old-refresh',
    createdAt: 'then',
    oauthStrategyId: 'chatgpt-api',
    oauthClientId: 'oaiapp_existing',
    oauthSubject: 'verified-user',
    authMethod: 'oauth',
    scope: planScope,
  };
}

describe('public ChatGPT plan sign-in', () => {
  it('registers WrongStack with PKCE, verifies the ID token and lists only account-visible models', async () => {
    let authorize: URL;
    const fetchImpl = fetcher(() => authorize.searchParams.get('nonce')!);
    const session = await createChatGPTDirectAuthStrategy(fetchImpl, async () => hostId).begin();
    try {
      if (session.interaction.type !== 'browser') throw new Error('Expected browser sign-in');
      authorize = new URL(session.interaction.authorizeUrl);
      expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(authorize.searchParams.get('agent_name_hint')).toBe('WrongStack');
      expect(authorize.searchParams.get('ext_agent_host_id')).toBe(hostId);
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('nonce')).toBeTruthy();
      const completion = session.waitForCompletion();
      // Exercise the actual loopback listener, not just the manual paste path.
      const response = await fetch(callbackUrl(authorize, 'oaiapp_new'));
      expect(response.status).toBe(200);
      const outcome = await completion;
      expect(outcome).toMatchObject({
        providerId: 'openai-chatgpt',
        family: 'openai',
        models: ['account-model'],
        credential: {
          oauthClientId: 'oaiapp_new',
          oauthSubject: 'verified-user',
          oauthStrategyId: 'chatgpt-api',
        },
      });
      expect(outcome?.credential.idToken).toBeTruthy();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      session.close();
    }
  });

  it('reauthorizes the selected account with its issued client ID and allows a callback without client_id', async () => {
    let authorize: URL;
    const fetchImpl = fetcher(() => authorize.searchParams.get('nonce')!);
    const previous = existing();
    const session = await createChatGPTDirectAuthStrategy(fetchImpl, async () => hostId).begin({
      credential: previous,
    });
    try {
      if (session.interaction.type !== 'browser') throw new Error('Expected browser sign-in');
      authorize = new URL(session.interaction.authorizeUrl);
      expect(authorize.searchParams.get('client_id')).toBe(previous.oauthClientId);
      expect(authorize.searchParams.has('agent_name_hint')).toBe(false);
      const outcome = await session.completeWithCode(callbackUrl(authorize).href);
      expect(outcome.credential.label).toBe('personal');
      expect(outcome.credential.createdAt).toBe('then');
      expect(previous.apiKey).toBe('old-access');
    } finally {
      session.close();
    }
  });

  it.each(['state', 'origin', 'path', 'client'])(
    'rejects a mismatching %s before exchanging tokens',
    async (mismatch) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const session = await createChatGPTDirectAuthStrategy(fetchImpl, async () => hostId).begin({
        credential: existing(),
      });
      try {
        if (session.interaction.type !== 'browser') throw new Error('Expected browser sign-in');
        const callback = callbackUrl(new URL(session.interaction.authorizeUrl), 'oaiapp_existing');
        if (mismatch === 'state') callback.searchParams.set('state', 'wrong');
        if (mismatch === 'origin') callback.hostname = 'attacker.test';
        if (mismatch === 'path') callback.pathname = '/callback';
        if (mismatch === 'client') callback.searchParams.set('client_id', 'oaiapp_someone_else');
        await expect(session.completeWithCode(callback.href)).rejects.toThrow();
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        session.close();
      }
    },
  );

  it('rejects a new registration with no issued client ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const session = await createChatGPTDirectAuthStrategy(fetchImpl, async () => hostId).begin();
    try {
      if (session.interaction.type !== 'browser') throw new Error('Expected browser sign-in');
      await expect(
        session.completeWithCode(callbackUrl(new URL(session.interaction.authorizeUrl)).href),
      ).rejects.toThrow('issued client ID');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it('does not replace credentials when the selected account changes identity', async () => {
    let authorize: URL;
    const fetchImpl = fetcher(() => authorize.searchParams.get('nonce')!, {
      claims: { sub: 'another-user' },
    });
    const session = await createChatGPTDirectAuthStrategy(fetchImpl, async () => hostId).begin({
      credential: existing(),
    });
    try {
      if (session.interaction.type !== 'browser') throw new Error('Expected browser sign-in');
      authorize = new URL(session.interaction.authorizeUrl);
      await expect(session.completeWithCode(callbackUrl(authorize).href)).rejects.toThrow(
        'account changed',
      );
    } finally {
      session.close();
    }
  });

  it('does not enable inference when ChatGPT plan permission was not granted', async () => {
    let authorize: URL;
    const fetchImpl = fetcher(() => authorize.searchParams.get('nonce')!, {
      scope: 'openid profile email',
    });
    const session = await createChatGPTDirectAuthStrategy(fetchImpl, async () => hostId).begin();
    try {
      if (session.interaction.type !== 'browser') throw new Error('Expected browser sign-in');
      authorize = new URL(session.interaction.authorizeUrl);
      await expect(
        session.completeWithCode(callbackUrl(authorize, 'oaiapp_new').href),
      ).rejects.toThrow('plan usage was not granted');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it('closing a pending login releases the browser wait', async () => {
    const session = await createChatGPTDirectAuthStrategy(vi.fn(), async () => hostId).begin();
    const pending = session.waitForCompletion();
    session.close();
    expect(await pending).toBeNull();
  });

  it('renews using the issued account client ID and retains verified identity', async () => {
    const previous = existing();
    const fetchImpl = fetcher(() => undefined);
    const renewed = await refreshChatGPTDirect(previous, fetchImpl);
    expect(renewed).toMatchObject({
      label: 'personal',
      oauthClientId: 'oaiapp_existing',
      oauthSubject: 'verified-user',
      refreshToken: 'rotated-refresh',
    });
    const fields = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(fields.get('grant_type')).toBe('refresh_token');
    expect(fields.get('client_id')).toBe(previous.oauthClientId);
    expect(fields.has('scope')).toBe(false);
  });
});

describe('ChatGPT identity verification', () => {
  it.each([
    { iss: 'https://attacker.test' },
    { aud: 'other-client' },
    { nonce: 'other-nonce' },
    { exp: 0 },
    { sub: '' },
    { aud: ['client', 'other'], azp: 'other' },
    { iat: Number.MAX_SAFE_INTEGER },
  ])('rejects signed claims that do not match %j', async (overrides) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ keys: [jwk] }));
    await expect(
      verifyChatGPTIdentity(idToken('client', 'nonce', overrides), 'client', 'nonce', fetchImpl),
    ).rejects.toThrow();
  });

  it('rejects a forged signature', async () => {
    const signed = idToken('client', 'nonce');
    const segments = signed.split('.');
    segments[1] = Buffer.from(
      JSON.stringify({ iss: 'https://auth.openai.com', aud: 'client', sub: 'forged' }),
    ).toString('base64url');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ keys: [jwk] }));
    await expect(
      verifyChatGPTIdentity(segments.join('.'), 'client', 'nonce', fetchImpl),
    ).rejects.toThrow('signature');
  });

  it('shares one stable host ID across concurrent callers and later launches', async () => {
    const root = fileURLToPath(new URL('../../../.temp_files/', import.meta.url));
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'chatgpt-host-test-'));
    try {
      const path = join(dir, 'host');
      const ids = await Promise.all([chatGPTHostId(path), chatGPTHostId(path)]);
      expect(ids[0]).toBe(ids[1]);
      expect(await chatGPTHostId(path)).toBe(ids[0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
