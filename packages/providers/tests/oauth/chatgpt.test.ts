import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildCodexAuthorizeUrl: vi.fn(),
  createState: vi.fn(),
  exchangeCodexAuthorizationCode: vi.fn(),
  extractAccountId: vi.fn(),
  generatePkce: vi.fn(),
  parseAuthorizationInput: vi.fn(),
  resolveCodexModels: vi.fn(),
  startLoopbackServer: vi.fn(),
}));

vi.mock('../../src/openai-codex-account.js', () => ({ extractAccountId: mocks.extractAccountId }));
vi.mock('../../src/oauth/codex-models.js', () => ({
  resolveCodexModels: mocks.resolveCodexModels,
}));
vi.mock('../../src/oauth/codex-protocol.js', () => ({
  buildCodexAuthorizeUrl: mocks.buildCodexAuthorizeUrl,
  CODEX_BASE_URL: 'https://chatgpt.test/backend-api',
  CODEX_FALLBACK_REDIRECT_PORT: 1457,
  CODEX_PROVIDER_ID: 'openai-codex',
  CODEX_REDIRECT_HOST: '127.0.0.1',
  CODEX_REDIRECT_PATH: '/auth/callback',
  CODEX_REDIRECT_PORT: 1455,
  CODEX_SCOPE: 'openid offline_access',
  exchangeCodexAuthorizationCode: mocks.exchangeCodexAuthorizationCode,
}));
vi.mock('../../src/oauth/shared.js', () => ({
  createState: mocks.createState,
  generatePkce: mocks.generatePkce,
  parseAuthorizationInput: mocks.parseAuthorizationInput,
  startLoopbackServer: mocks.startLoopbackServer,
}));

import { beginChatGPTLogin } from '../../src/oauth/chatgpt.js';

describe('beginChatGPTLogin', () => {
  const server = {
    bound: true,
    port: 1455,
    waitForCode: vi.fn(),
    close: vi.fn(),
  };
  const tokens = {
    access: 'access-token',
    refresh: 'refresh-token',
    expires: Date.parse('2026-08-10T12:00:00.000Z'),
    idToken: 'id-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    server.bound = true;
    mocks.generatePkce.mockReturnValue({ verifier: 'verifier', challenge: 'challenge' });
    mocks.createState.mockReturnValue('expected-state');
    mocks.startLoopbackServer.mockResolvedValue(server);
    mocks.buildCodexAuthorizeUrl.mockReturnValue('https://auth.test/authorize');
    mocks.exchangeCodexAuthorizationCode.mockResolvedValue(tokens);
    mocks.extractAccountId.mockReturnValue('account-1');
    mocks.resolveCodexModels.mockResolvedValue(['gpt-5-codex']);
  });

  it('completes the bound loopback flow and assembles a persistence-ready outcome', async () => {
    server.waitForCode.mockResolvedValue({ code: 'callback-code', state: 'expected-state' });
    const modelsRegistry = { getModels: vi.fn() };
    const signal = new AbortController().signal;
    const session = await beginChatGPTLogin({ modelsRegistry: modelsRegistry as never }, signal);

    expect(mocks.startLoopbackServer).toHaveBeenCalledWith({
      port: 1455,
      fallbackPorts: [1457],
      host: '127.0.0.1',
      path: '/auth/callback',
      expectedState: 'expected-state',
      signal,
    });
    expect(mocks.buildCodexAuthorizeUrl).toHaveBeenCalledWith('challenge', 'expected-state', 1455);
    expect(session.authorizeUrl).toBe('https://auth.test/authorize');

    await expect(session.waitForCompletion()).resolves.toEqual({
      providerId: 'openai-codex',
      family: 'openai-codex',
      baseUrl: 'https://chatgpt.test/backend-api',
      models: ['gpt-5-codex'],
      apiKey: expect.objectContaining({
        label: 'oauth-default',
        apiKey: 'access-token',
        authMethod: 'oauth',
        expiresAt: '2026-08-10T12:00:00.000Z',
        refreshToken: 'refresh-token',
        scope: 'openid offline_access',
        accountId: 'account-1',
      }),
    });
    expect(mocks.exchangeCodexAuthorizationCode).toHaveBeenCalledWith(
      'callback-code',
      'verifier',
      signal,
      1455,
    );
    expect(mocks.resolveCodexModels).toHaveBeenCalledWith(
      modelsRegistry,
      'access-token',
      'https://chatgpt.test/backend-api',
      signal,
    );
  });

  it('supports manual paste while rejecting missing and mismatched values', async () => {
    const session = await beginChatGPTLogin(undefined);
    mocks.parseAuthorizationInput.mockReturnValueOnce({ code: 'manual-code' });
    await expect(session.completeWithCode('manual-code')).resolves.toMatchObject({
      providerId: 'openai-codex',
    });

    mocks.parseAuthorizationInput.mockReturnValueOnce({ code: 'code', state: 'wrong-state' });
    await expect(session.completeWithCode('wrong')).rejects.toThrow('State mismatch');
    mocks.parseAuthorizationInput.mockReturnValueOnce({});
    await expect(session.completeWithCode('empty')).rejects.toThrow('No authorization code');
    session.close();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('returns null without a usable callback and rejects tokens without an account id', async () => {
    server.bound = false;
    let session = await beginChatGPTLogin(undefined);
    await expect(session.waitForCompletion()).resolves.toBeNull();

    server.bound = true;
    server.waitForCode.mockResolvedValue(null);
    session = await beginChatGPTLogin(undefined);
    await expect(session.waitForCompletion()).resolves.toBeNull();

    server.waitForCode.mockResolvedValue({ code: 'callback-code' });
    mocks.extractAccountId.mockReturnValue(null);
    session = await beginChatGPTLogin(undefined);
    await expect(session.waitForCompletion()).rejects.toThrow('no ChatGPT account id');
  });
});
