import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserInputRequest, UserInputResponse } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPrivateOrigins } from '../src/browser/policy.js';
import { promptForPrivateOrigin } from '../src/browser/private-origin-prompt.js';
import { LOOPBACK_ALLOWANCE } from '../src/browser/security.js';
import { browserNavigateTool } from '../src/browser/tools.js';

let root: string;
beforeEach(async () => {
  vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', '');
  root = await mkdtemp(join(tmpdir(), 'browser-origin-prompt-'));
  vi.stubEnv('WRONGSTACK_HOME', join(root, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function ctxAnswering(choice: string | undefined, seen: UserInputRequest[] = []): Context {
  return {
    projectRoot: root,
    requestUserInput: async (request: UserInputRequest): Promise<UserInputResponse | undefined> => {
      seen.push(request);
      if (choice === undefined) return undefined;
      return {
        requestId: request.id,
        status: 'submitted',
        answers: [
          { questionId: 'private_origin', selectedOptionIds: [choice], usedRecommendation: false },
        ],
      };
    },
  } as unknown as Context;
}

const signal = new AbortController().signal;

describe('browser private-origin prompt', () => {
  it('saves the exact origin the user allowed', async () => {
    await promptForPrivateOrigin(ctxAnswering('origin'), 'http://127.0.0.1:51175/app', signal);
    expect(browserPrivateOrigins(root)).toEqual(['http://127.0.0.1:51175']);
  });

  it('saves the loopback allowance when chosen', async () => {
    await promptForPrivateOrigin(
      ctxAnswering(LOOPBACK_ALLOWANCE),
      'http://localhost:5173/',
      signal,
    );
    expect(browserPrivateOrigins(root)).toEqual([LOOPBACK_ALLOWANCE]);
  });

  it('leaves the policy alone on deny or no answer', async () => {
    await promptForPrivateOrigin(ctxAnswering('deny'), 'http://127.0.0.1:3000/', signal);
    await promptForPrivateOrigin(ctxAnswering(undefined), 'http://127.0.0.1:3000/', signal);
    expect(browserPrivateOrigins(root)).toEqual([]);
  });

  it('offers no loopback-wide option for a LAN address', async () => {
    const seen: UserInputRequest[] = [];
    await promptForPrivateOrigin(
      ctxAnswering(LOOPBACK_ALLOWANCE, seen),
      'http://192.168.1.5/',
      signal,
    );
    const ids = seen[0]?.tabs[0]?.questions[0]?.options?.map((option) => option.id);
    expect(ids).toEqual(['origin', 'deny']);
    expect(browserPrivateOrigins(root)).toEqual([]);
  });

  it('does not ask for or persist an origin when the browser session is invalid', async () => {
    const seen: UserInputRequest[] = [];
    await expect(
      browserNavigateTool.execute(
        { sessionId: 'missing-session', url: 'http://127.0.0.1:43123/private' },
        ctxAnswering('origin', seen),
        { signal },
      ),
    ).rejects.toThrow('browser: unknown session "missing-session"');
    expect(seen).toHaveLength(0);
    expect(browserPrivateOrigins(root)).toEqual([]);
  });

  it('does not ask for public hosts or already approved origins', async () => {
    const seen: UserInputRequest[] = [];
    await promptForPrivateOrigin(ctxAnswering('origin', seen), 'https://example.com/', signal);
    await promptForPrivateOrigin(ctxAnswering('origin'), 'http://127.0.0.1:4000/', signal);
    await promptForPrivateOrigin(ctxAnswering('origin', seen), 'http://127.0.0.1:4000/x', signal);
    expect(seen).toHaveLength(0);
  });
});
