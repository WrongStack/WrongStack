import { FetchError, ParseError } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/github-copilot-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/github-copilot-token.js')>();
  return { ...actual, refreshCopilotToken: vi.fn() };
});

import { copilotBaseUrlFromToken, refreshCopilotToken } from '../src/github-copilot-token.js';
import { beginCopilotLogin } from '../src/oauth/copilot.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN = 'tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;sig';

type PollReply = { json: unknown } | { throws: Error } | { badJson: true };

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

function installFetch(opts: {
  device?: unknown;
  deviceStatus?: number;
  polls?: PollReply[];
  models?: { ok: boolean; body?: unknown };
}) {
  const polls = [...(opts.polls ?? [])];
  const pollTimes: number[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    if (url === DEVICE_CODE_URL) {
      const status = opts.deviceStatus ?? 200;
      return jsonResponse(opts.device, { ok: status < 400, status });
    }
    if (url === ACCESS_TOKEN_URL) {
      pollTimes.push(Date.now());
      const reply = polls.length > 1 ? polls.shift() : polls[0];
      if (!reply) return jsonResponse({ error: 'authorization_pending' });
      if ('throws' in reply) throw reply.throws;
      if ('badJson' in reply) {
        return {
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        };
      }
      return jsonResponse(reply.json);
    }
    if (url.endsWith('/models')) {
      const models = opts.models ?? { ok: false };
      return jsonResponse(models.body, { ok: models.ok, status: models.ok ? 200 : 500 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, pollTimes };
}

const DEVICE = {
  device_code: 'dev-123',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://github.com/login/device',
  interval: 1,
  expires_in: 900,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(refreshCopilotToken).mockResolvedValue({
    token: COPILOT_TOKEN,
    expires: Date.parse('2030-01-01T00:00:00Z'),
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('beginCopilotLogin — device-code request', () => {
  it('exposes the verification uri and user code without polling yet', async () => {
    const { fetchMock } = installFetch({ device: DEVICE });
    const session = await beginCopilotLogin(undefined);
    expect(session).toMatchObject({
      kind: 'copilot',
      providerId: 'github-copilot',
      bound: false,
      verificationUri: DEVICE.verification_uri,
      userCode: DEVICE.user_code,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(session.completeWithCode('x')).rejects.toThrow(/device-code flow/);
    expect(() => session.close()).not.toThrow();
  });

  it('throws a FetchError carrying the HTTP status when GitHub refuses', async () => {
    installFetch({ device: {}, deviceStatus: 503 });
    const err = await beginCopilotLogin(undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).message).toContain('503');
  });

  it.each([
    ['null body', null],
    ['missing device_code', { ...DEVICE, device_code: undefined }],
    ['missing user_code', { ...DEVICE, user_code: '' }],
    ['missing verification_uri', { ...DEVICE, verification_uri: undefined }],
    ['non-numeric expires_in', { ...DEVICE, expires_in: '900' }],
  ])('throws a ParseError on %s', async (_label, body) => {
    installFetch({ device: body });
    await expect(beginCopilotLogin(undefined)).rejects.toBeInstanceOf(ParseError);
  });
});

describe('beginCopilotLogin — polling', () => {
  it('survives pending, null, unparseable and network-failure polls, then completes', async () => {
    const { pollTimes } = installFetch({
      device: DEVICE,
      polls: [
        { json: { error: 'authorization_pending' } },
        { json: null },
        { badJson: true },
        { throws: new TypeError('fetch failed') },
        { json: { error: 'some_future_error' } },
        { json: { access_token: 'gho_github' } },
      ],
      models: {
        ok: true,
        body: {
          data: [
            { id: 'plain', capabilities: { type: 'chat', supports: { tool_calls: true } } },
            { id: 'embed', capabilities: { type: 'embeddings' } },
            {
              id: 'default-model',
              is_chat_default: true,
              capabilities: { type: 'chat', supports: { tool_calls: true } },
            },
            {
              id: 'fallback-model',
              is_chat_fallback: true,
              capabilities: { type: 'chat', supports: { tool_calls: true } },
            },
          ],
        },
      },
    });
    const session = await beginCopilotLogin(undefined);
    const outcome = session.waitForCompletion();
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await outcome;

    expect(pollTimes).toHaveLength(6);
    expect(refreshCopilotToken).toHaveBeenCalledWith('gho_github', expect.any(AbortSignal));
    expect(result).toMatchObject({
      providerId: 'github-copilot',
      family: 'github-copilot',
      baseUrl: copilotBaseUrlFromToken(COPILOT_TOKEN),
      models: ['default-model', 'fallback-model', 'plain'],
      apiKey: {
        label: 'oauth-default',
        apiKey: COPILOT_TOKEN,
        authMethod: 'oauth',
        refreshToken: 'gho_github',
        tokenType: 'bearer',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });
  });

  it('adds 5s to the poll interval on slow_down', async () => {
    const { pollTimes } = installFetch({
      device: DEVICE,
      polls: [{ json: { error: 'slow_down' } }, { json: { access_token: 'gho_x' } }],
    });
    const session = await beginCopilotLogin(undefined);
    const start = Date.now();
    const outcome = session.waitForCompletion();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollTimes).toHaveLength(1);
    // The next poll must wait 1s + 5s, not the original 1s.
    await vi.advanceTimersByTimeAsync(5_999);
    expect(pollTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollTimes).toHaveLength(2);
    expect(pollTimes[1]! - start).toBe(7_000);
    await expect(outcome).resolves.toMatchObject({ models: [] });
  });

  it('defaults the poll interval to 5s when GitHub omits it', async () => {
    const { pollTimes } = installFetch({
      device: { ...DEVICE, interval: undefined },
      polls: [{ json: { access_token: 'gho_x' } }],
    });
    const session = await beginCopilotLogin(undefined);
    const outcome = session.waitForCompletion();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pollTimes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.not.toBeNull();
  });

  it.each([
    'access_denied',
    'expired_token',
    'unsupported_grant_type',
    'incorrect_client_credentials',
    'incorrect_device_code',
    'device_flow_disabled',
  ])('fails fast on terminal error %s', async (error) => {
    const { pollTimes } = installFetch({ device: DEVICE, polls: [{ json: { error } }] });
    const session = await beginCopilotLogin(undefined);
    const assertion = expect(session.waitForCompletion()).rejects.toThrow(
      `Device flow failed: ${error}`,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(pollTimes).toHaveLength(1);
    expect(refreshCopilotToken).not.toHaveBeenCalled();
  });

  it('rejects with an expiry FetchError once the device code lapses', async () => {
    installFetch({ device: { ...DEVICE, expires_in: 3 } });
    const session = await beginCopilotLogin(undefined);
    const assertion = expect(session.waitForCompletion()).rejects.toMatchObject({
      message: expect.stringContaining('Device code expired'),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('resolves null when the wait signal aborts mid-poll and detaches its listener', async () => {
    installFetch({ device: DEVICE });
    const session = await beginCopilotLogin(undefined);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const outcome = session.waitForCompletion(controller.signal);
    await vi.advanceTimersByTimeAsync(2_500);
    controller.abort();
    await expect(outcome).resolves.toBeNull();
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('resolves null immediately when the begin signal is already aborted', async () => {
    installFetch({ device: DEVICE });
    const controller = new AbortController();
    const session = await beginCopilotLogin(undefined, controller.signal);
    controller.abort();
    await expect(session.waitForCompletion()).resolves.toBeNull();
  });

  it('returns no invented models when the account endpoint yields no usable chat model', async () => {
    installFetch({
      device: DEVICE,
      polls: [{ json: { access_token: 'gho_x' } }],
      models: { ok: true, body: { data: [{ id: 'embed', capabilities: { type: 'embeddings' } }] } },
    });
    const session = await beginCopilotLogin(undefined);
    const outcome = session.waitForCompletion();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toMatchObject({ models: [] });
  });

  it('propagates a Copilot token exchange failure', async () => {
    installFetch({ device: DEVICE, polls: [{ json: { access_token: 'gho_x' } }] });
    vi.mocked(refreshCopilotToken).mockRejectedValueOnce(new Error('no copilot seat'));
    const session = await beginCopilotLogin(undefined);
    const assertion = expect(session.waitForCompletion()).rejects.toThrow('no copilot seat');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
