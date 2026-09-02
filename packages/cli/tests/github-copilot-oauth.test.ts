import { isParseError } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isUsableCopilotChatModel,
  pollForGitHubToken,
  startDeviceFlow,
} from '../src/auth-menu/github-copilot-oauth.js';
import { expectFetchError } from './helpers/fetch-error.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startDeviceFlow', () => {
  it('POSTs to GitHub device-code and maps the response', async () => {
    let captured: {
      url: string | undefined;
      body: string | undefined;
    } = {
      url: undefined,
      body: undefined,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        captured = { url, body: init.body };
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'WXYZ-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 5,
            expires_in: 900,
          }),
          { status: 200 },
        );
      }),
    );

    const d = await startDeviceFlow();
    expect(captured.url).toBe('https://github.com/login/device/code');
    const body = new URLSearchParams(captured.body ?? '');
    expect(body.get('client_id')).toBe('Iv1.b507a08c87ecfe98');
    expect(body.get('scope')).toBe('read:user');
    expect(d.user_code).toBe('WXYZ-1234');
    expect(d.device_code).toBe('dc');
  });

  it('non-2xx response throws a structured FetchError (github-copilot device-code context)', async () => {
    // Locks in the FetchError shape (provider, op, url) so the migration
    // can't accidentally regress to a bare Error.
    const fe = await expectFetchError(() => startDeviceFlow(), {
      status: 429,
      body: 'rate limit',
      context: {
        provider: 'github-copilot',
        op: 'device-code',
        url: 'https://github.com/login/device/code',
      },
    });
    expect(fe).toBeDefined();
  });
});

describe('isUsableCopilotChatModel', () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    id: 'm',
    capabilities: { type: 'chat', supports: { tool_calls: true } },
    ...over,
  });

  it('keeps a normal enabled chat model with tool calls', () => {
    expect(isUsableCopilotChatModel(chat())).toBe(true);
  });

  it('keeps a legacy chat model with no supported_endpoints field', () => {
    expect(isUsableCopilotChatModel(chat({ id: 'gpt-4o' }))).toBe(true);
  });

  it('drops a /responses-only model (the picker 400 bug)', () => {
    // mai-code-1-flash-picker / gpt-5.4-mini-free-auto shape: chat + tools but
    // only callable via /responses, so /chat/completions returns HTTP 400.
    const picker = chat({ id: 'mai-code-1-flash-picker', supported_endpoints: ['/responses'] });
    expect(isUsableCopilotChatModel(picker)).toBe(false);
  });

  it('keeps a model whose supported_endpoints include /chat/completions', () => {
    const m = chat({ supported_endpoints: ['/chat/completions', '/responses'] });
    expect(isUsableCopilotChatModel(m)).toBe(true);
  });

  it('drops embedding and completion-only models', () => {
    expect(
      isUsableCopilotChatModel({
        id: 'text-embedding-3-small',
        capabilities: { type: 'embeddings', supports: {} },
      }),
    ).toBe(false);
    expect(
      isUsableCopilotChatModel({
        id: 'gpt-41-copilot',
        capabilities: { type: 'completion', supports: { tool_calls: true } },
      }),
    ).toBe(false);
  });

  it('drops models without tool-call support', () => {
    expect(
      isUsableCopilotChatModel({ id: 'm', capabilities: { type: 'chat', supports: {} } }),
    ).toBe(false);
  });

  it('drops policy-disabled models (not enabled in GitHub settings)', () => {
    expect(isUsableCopilotChatModel(chat({ policy: { state: 'disabled' } }))).toBe(false);
    expect(isUsableCopilotChatModel(chat({ policy: { state: 'enabled' } }))).toBe(true);
  });

  it('drops experimental internal models', () => {
    expect(isUsableCopilotChatModel(chat({ vendor: 'Experimental' }))).toBe(false);
  });

  it('drops entries with no id', () => {
    expect(isUsableCopilotChatModel(chat({ id: undefined }))).toBe(false);
  });
});

describe('pollForGitHubToken', () => {
  it('keeps polling on authorization_pending then returns the token', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(
          JSON.stringify(
            calls === 1 ? { error: 'authorization_pending' } : { access_token: 'gho_TOKEN' },
          ),
          { status: 200 },
        );
      }),
    );

    const token = await pollForGitHubToken(
      {
        device_code: 'dc',
        user_code: 'x',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 60,
      },
      new AbortController().signal,
    );
    expect(token).toBe('gho_TOKEN');
    expect(calls).toBe(2);
  });

  it('throws on a hard error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'access_denied' }), { status: 200 })),
    );
    await expect(
      pollForGitHubToken(
        {
          device_code: 'dc',
          user_code: 'x',
          verification_uri: 'https://github.com/login/device',
          interval: 0,
          expires_in: 60,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/access_denied/);
  });

  it('device code expiry throws a structured FetchError (status 408 + reason: expired)', async () => {
    // The "device code expired" path is unique in the OAuth flow: it's a
    // TIMEOUT, not an HTTP error. FetchError(status: 408) with reason: 'expired'
    // in context preserves the cause-class signal for consumers. The HTTP
    // response from the poll is 200 (authorization_pending) but the FetchError
    // is synthesized with status 408 — `expectedStatus` overrides the helper's
    // status-vs-expectedStatus coupling for this case.
    const fe = await expectFetchError(
      () =>
        pollForGitHubToken(
          {
            device_code: 'dc',
            user_code: 'x',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: -1, // already expired
          },
          new AbortController().signal,
        ),
      {
        // The 200 OK is what pollForGitHubToken sees for the initial pending
        // poll — but the expires_in: -1 short-circuits the loop to the expiry
        // branch before the next poll.
        status: 200,
        expectedStatus: 408,
        body: 'authorization_pending',
        context: {
          provider: 'github-copilot',
          op: 'device-code-poll',
          reason: 'expired',
        },
      },
    );
    expect(fe).toBeDefined();
  });

  it('2xx device-code response with missing fields throws a structured ParseError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ device_code: 'dc', user_code: 'x' }), { status: 200 }),
      ),
    );
    let caught: unknown;
    try {
      await startDeviceFlow();
    } catch (err) {
      caught = err;
    }
    expect(isParseError(caught)).toBe(true);
    const pe = caught as ReturnType<typeof isParseError> & {
      source?: string;
    };
    expect(pe.source).toBe('github-copilot-device-code-response');
  });

  it('sleep() removes its abort listener on the timeout path — no accumulation across poll iterations', async () => {
    // RAM-leak audit 2026-08-16, LOW: the device-flow poll loop reuses ONE
    // AbortSignal across iterations, so a sleep() that registers an abort
    // listener without detaching it on the timeout path accumulates one
    // listener-closure per poll. The fix (token-throttle pattern) removes
    // the listener when the timer fires. Regression contract: exactly one
    // 'abort' add and one 'abort' remove per completed sleep.
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls += 1;
          return new Response(
            JSON.stringify(
              calls < 3 ? { error: 'authorization_pending' } : { access_token: 'gho_T' },
            ),
            { status: 200 },
          );
        }),
      );
      const controller = new AbortController();
      const signal = controller.signal;
      const addSpy = vi.spyOn(signal, 'addEventListener');
      const removeSpy = vi.spyOn(signal, 'removeEventListener');

      const pollPromise = pollForGitHubToken(
        {
          device_code: 'dc',
          user_code: 'x',
          verification_uri: 'https://github.com/login/device',
          interval: 5,
          expires_in: 60,
        },
        signal,
      );
      // Three poll iterations: two pending, third returns the token. Each
      // iteration completes exactly one sleep() timeout.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const token = await pollPromise;

      expect(token).toBe('gho_T');
      const abortAdds = addSpy.mock.calls.filter((c) => c[0] === 'abort').length;
      const abortRemoves = removeSpy.mock.calls.filter((c) => c[0] === 'abort').length;
      expect(abortAdds).toBe(3); // one sleep per poll iteration
      expect(abortRemoves).toBe(3); // pre-fix this was 0 — the leak
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sleep() abort-listener hygiene (RAM-leak audit 2026-08-16)', () => {
  it('removes each abort listener on the timeout path so the reused poll signal does not accumulate them', async () => {
    // The device-flow poll loop reuses ONE AbortSignal across iterations;
    // before the fix, every completed sleep() left its { once: true } abort
    // listener attached until the flow-scoped controller was GC'd. Assert
    // add/remove symmetry on the timeout path by spying on the EventTarget
    // prototype and filtering to this signal's 'abort' registrations.
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(
          JSON.stringify(
            calls < 4 ? { error: 'authorization_pending' } : { access_token: 'gho_T' },
          ),
          { status: 200 },
        );
      }),
    );
    const controller = new AbortController();
    const signal = controller.signal;
    const addSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    try {
      const token = await pollForGitHubToken(
        {
          device_code: 'dc',
          user_code: 'x',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 60,
        },
        signal,
      );
      expect(token).toBe('gho_T');
      expect(calls).toBe(4); // 4 poll iterations (3 pending + 1 token) -> 4 completed sleep() calls

      const added: unknown[] = [];
      const removed: unknown[] = [];
      addSpy.mock.calls.forEach((args, i) => {
        if (args[0] === 'abort' && addSpy.mock.contexts[i] === signal) added.push(args[1]);
      });
      removeSpy.mock.calls.forEach((args, i) => {
        if (args[0] === 'abort' && removeSpy.mock.contexts[i] === signal) removed.push(args[1]);
      });

      expect(added.length).toBe(4);
      // One-to-one comparison (chimera review): a containment-only check
      // would pass even if the SAME callback were removed repeatedly while
      // other listeners stayed attached. The poll loop is strictly
      // sequential (add → timeout-remove per sleep), so order matches.
      expect(removed).toEqual(added);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
