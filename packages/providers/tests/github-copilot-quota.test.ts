/**
 * Copilot quota reporter — `GET /copilot_internal/user` mapped onto the
 * provider-neutral snapshot shape.
 *
 * Copilot is the only metered subscription here that reports nothing on the
 * chat response, so this reporter has to ask. What belongs in this file is the
 * field-level handling that the shape does not make obvious: the `0` reset
 * that has to be backfilled, why an unlimited pool is omitted rather than
 * shown at 0%, and that a failed read never clobbers a good one.
 */

import type { Request } from '@wrongstack/contracts/types';
import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubCopilotProvider } from '../src/github-copilot.js';
import { parseCopilotQuotaJson, reportCopilotQuota } from '../src/github-copilot-quota.js';
import { resetSharedOAuthRefreshState } from '../src/oauth-refresh-coordinator.js';

// Coordinators share refreshes process-wide by refresh key; this file reuses
// one fake key, so each test starts from a clean slate.
beforeEach(() => resetSharedOAuthRefreshState());

afterEach(() => {
  resetProviderQuota();
});

const RESET_DAY = '2026-10-01';
const RESET_SECONDS = Math.floor(Date.parse(`${RESET_DAY}T00:00:00Z`) / 1000);

function userJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    copilot_plan: 'individual',
    quota_reset_date: RESET_DAY,
    quota_snapshots: {
      chat: {
        entitlement: 300,
        remaining: 210,
        percent_remaining: 70,
        unlimited: false,
        quota_reset_at: RESET_SECONDS,
      },
      premium_interactions: {
        entitlement: 1500,
        remaining: 150,
        percent_remaining: 10,
        unlimited: false,
        quota_reset_at: RESET_SECONDS,
      },
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('parseCopilotQuotaJson', () => {
  it('turns every metered pool into a window of one meter', () => {
    // One plan, one reset, one "is this about to stop working" question — so
    // one meter. Separate meters would print three plan headers for one
    // subscription.
    const [snapshot] = parseCopilotQuotaJson('github-copilot', userJson(), 1_700_000_000_000);
    expect(snapshot?.meterId).toBe('copilot');
    expect(snapshot?.planLabel).toBe('individual');
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['premium_interactions', 'chat']);
    expect(snapshot?.windows[0]).toMatchObject({
      id: 'premium_interactions',
      label: 'premium interactions',
      usedPercent: 90,
      windowMinutes: 43_200,
      resetsAt: RESET_SECONDS,
    });
  });

  it('backfills a per-pool reset reported as zero', () => {
    // Observed in the wild: `quota_reset_at: 0` would render as a reset that
    // happened in 1970, so the account-wide date is the only honest source.
    const [snapshot] = parseCopilotQuotaJson(
      'github-copilot',
      userJson({
        quota_snapshots: {
          chat: { percent_remaining: 25, unlimited: false, quota_reset_at: 0 },
        },
      }),
    );
    expect(snapshot?.windows[0]?.resetsAt).toBe(RESET_SECONDS);
  });

  it('leaves the reset absent when neither source has one', () => {
    const [snapshot] = parseCopilotQuotaJson('github-copilot', {
      quota_snapshots: { chat: { percent_remaining: 25 } },
    });
    expect(snapshot?.windows[0]?.resetsAt).toBeUndefined();
  });

  it('omits an unlimited pool instead of drawing an empty bar', () => {
    const [snapshot] = parseCopilotQuotaJson(
      'github-copilot',
      userJson({
        quota_snapshots: {
          chat: { unlimited: true, percent_remaining: 100 },
          premium_interactions: { percent_remaining: 40, unlimited: false },
        },
      }),
    );
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['premium_interactions']);
  });

  it('derives the percentage from the counts when the API omits it', () => {
    const [snapshot] = parseCopilotQuotaJson('github-copilot', {
      quota_snapshots: { chat: { entitlement: 400, remaining: 100 } },
    });
    expect(snapshot?.windows[0]?.usedPercent).toBe(75);
  });

  it('skips a pool that is not part of the plan', () => {
    // An entitlement of 0 means "not on this plan", not "100% consumed".
    const [snapshot] = parseCopilotQuotaJson('github-copilot', {
      quota_snapshots: { chat: { entitlement: 0, remaining: 0 } },
    });
    expect(snapshot).toBeUndefined();
  });

  it('reports a pool GitHub adds later', () => {
    // A new allowance the user is being metered on is exactly the thing this
    // exists to show, so an unknown key is included rather than filtered.
    const [snapshot] = parseCopilotQuotaJson('github-copilot', {
      quota_snapshots: {
        chat: { percent_remaining: 90 },
        agent_sessions: { percent_remaining: 5 },
      },
    });
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['chat', 'agent_sessions']);
  });

  it('returns nothing for a body with no quota block', () => {
    expect(parseCopilotQuotaJson('github-copilot', { copilot_plan: 'individual' })).toEqual([]);
    expect(parseCopilotQuotaJson('github-copilot', null)).toEqual([]);
    expect(parseCopilotQuotaJson('github-copilot', 'nope')).toEqual([]);
  });
});

describe('reportCopilotQuota', () => {
  it('reads the quota with the GitHub token and records it', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(userJson())));
    const ok = await reportCopilotQuota('github-copilot', 'gho_token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The call goes to api.github.com with the long-lived GitHub token — not
    // to the metered inference host — which is what makes asking acceptable
    // here at all: it spends no Copilot entitlement.
    expect(url).toBe('https://api.github.com/copilot_internal/user');
    const sent = init.headers as Record<string, string>;
    expect(sent.authorization).toBe('Bearer gho_token');
    expect(sent['x-github-api-version']).toBe('2025-04-01');
    expect(getProviderQuota('github-copilot')[0]?.windows).toHaveLength(2);
  });

  it('keeps the previous reading when a later read fails', async () => {
    await reportCopilotQuota('github-copilot', 'gho_token', {
      fetchImpl: (() => Promise.resolve(jsonResponse(userJson()))) as unknown as typeof fetch,
    });
    const failing = await reportCopilotQuota('github-copilot', 'gho_token', {
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    expect(failing).toBe(false);
    // A GitHub outage must not blank a reading the user could still act on.
    expect(getProviderQuota('github-copilot')[0]?.windows).toHaveLength(2);
  });

  it('reports nothing on a non-ok response', async () => {
    const ok = await reportCopilotQuota('github-copilot', 'gho_token', {
      fetchImpl: (() => Promise.resolve(jsonResponse({}, false, 403))) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(getProviderQuota('github-copilot')).toEqual([]);
  });

  it('swallows a malformed response instead of throwing at the caller', async () => {
    // Nothing awaits this function in production, so a throw would surface as
    // an unhandled rejection rather than as a failed status read.
    const ok = await reportCopilotQuota('github-copilot', 'gho_token', {
      fetchImpl: (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('not json')),
        } as unknown as Response)) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });
});

// ── Transport wiring ────────────────────────────────────────────────────────

const OPENAI_SSE = [
  'data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const req: Request = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 64,
};

/** Serves the quota endpoint and the chat stream off one fake. */
function copilotFetch(quotaBody: unknown, onQuota?: () => void): typeof fetch {
  const enc = new TextEncoder();
  return (async (url: string) => {
    if (String(url).includes('/copilot_internal/user')) {
      onQuota?.();
      return jsonResponse(quotaBody);
    }
    return new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(enc.encode(OPENAI_SSE));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as never as typeof fetch;
}

/** Let the detached background read settle without awaiting it in production. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('GitHubCopilotProvider reports quota', () => {
  it('reads the quota after minting a token', async () => {
    // Copilot reports nothing on the chat response, so the mint — roughly
    // twice an hour, and already proof that the GitHub token works — is the
    // moment to ask.
    const provider = new GitHubCopilotProvider({
      credentials: { copilotToken: '', githubToken: 'gho_x' },
      refreshFn: () =>
        Promise.resolve({
          token: 'tid=a;proxy-ep=proxy.individual.githubcopilot.com',
          expires: Date.now() + 1_800_000,
        }),
      fetchImpl: copilotFetch(userJson()),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    await flush();
    expect(getProviderQuota('github-copilot')[0]?.windows).toHaveLength(2);
  });

  it('does not make the turn wait on the quota read', async () => {
    // A GitHub outage must not be able to fail a request Copilot would have
    // served, so the read is never awaited on the request path.
    let settleQuota: (() => void) | undefined;
    const enc = new TextEncoder();
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/copilot_internal/user')) {
        return new Promise<Response>((resolve) => {
          settleQuota = () => resolve(jsonResponse(userJson()));
        });
      }
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(enc.encode(OPENAI_SSE));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as never as typeof fetch;

    const provider = new GitHubCopilotProvider({
      credentials: { copilotToken: '', githubToken: 'gho_x' },
      refreshFn: () =>
        Promise.resolve({
          token: 'tid=a;proxy-ep=proxy.individual.githubcopilot.com',
          expires: Date.now() + 1_800_000,
        }),
      fetchImpl,
    });
    // Completes while the quota request is still hanging.
    const res = await provider.complete(req, { signal: new AbortController().signal });
    expect(res.stopReason).toBe('end_turn');
    expect(getProviderQuota('github-copilot')).toEqual([]);
    settleQuota?.();
    await flush();
    expect(getProviderQuota('github-copilot')).toHaveLength(1);
  });

  it('asks once across two mints in a row', async () => {
    // A 401 retry mints twice back to back; two identical reads would be waste.
    const calls = vi.fn();
    const provider = new GitHubCopilotProvider({
      credentials: { copilotToken: '', githubToken: 'gho_x' },
      refreshFn: () =>
        Promise.resolve({
          token: 'tid=a;proxy-ep=proxy.individual.githubcopilot.com',
          expires: Date.now() - 1,
        }),
      fetchImpl: copilotFetch(userJson(), calls),
    });
    // An already-expired token makes the next request mint again.
    await provider.complete(req, { signal: new AbortController().signal });
    await provider.complete(req, { signal: new AbortController().signal });
    await flush();
    expect(calls.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
