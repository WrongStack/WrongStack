import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, UserInputResponse } from '@wrongstack/contracts/types';
import { createEventUserInputAwaiter } from '@wrongstack/core/agent';
import { expect, it } from 'vitest';
import { bindAcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';

it.each([
  ['submitted', { action: 'accept', content: { strategy: 'conservative', retries: 3 } }],
  ['declined', { action: 'decline' }],
  ['cancelled', { action: 'cancel' }],
] as const)('routes %s user input to its ACP conversation over stdio', async (status, expected) => {
  const events = new EventBus();
  const model = 'fixture-forms';
  const sessionId = 'tab-for-fixture';
  const config = {
    model,
    acp: {
      agents: {
        [model]: {
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./fixtures/acp-session-peer.ts', import.meta.url)),
            'elicit',
          ],
        },
      },
      bridge: { servers: [] },
    },
  } as Config;
  const formContext = { userInputAwaiter: createEventUserInputAwaiter(events), meta: {} };
  bindAcpLeaderHost({
    events,
    projectRoot: process.cwd(),
    confirmThroughEvents: true,
    getConfig: () => config,
    permission: () => ({ evaluate: async () => ({ permission: 'auto' }) }) as never,
    context: () => formContext as never,
    getTool: () => undefined,
    runTool: async () => ({ content: '', isError: false }),
  });
  const provider = new AcpLeaderProvider({ bootConfig: config, buildProvider: () => undefined });
  const requests: Array<{ sessionId?: string; title: string; declineLabel?: string }> = [];
  const off = events.on('user.input_requested', (event) => {
    requests.push({
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      title: event.request.title,
      ...(event.request.declineLabel ? { declineLabel: event.request.declineLabel } : {}),
    });
    const response: UserInputResponse = {
      requestId: event.request.id,
      status,
      answers:
        status === 'submitted'
          ? [
              { questionId: 'f0', selectedOptionIds: ['o0'], usedRecommendation: false },
              { questionId: 'f1', selectedOptionIds: [], text: '3', usedRecommendation: false },
            ]
          : [],
    };
    // A different tab cannot settle this form even with its request ID.
    events.emit('user.input_submitted', {
      sessionId: 'unrelated-tab',
      response: { ...response, status: 'declined', answers: [] },
    });
    events.emit('user.input_submitted', { sessionId, response });
  });
  try {
    const output: string[] = [];
    for await (const event of provider.stream(
      {
        model,
        cache: { sessionId, threadId: sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Ask for choices' }] }],
      } as never,
      { signal: AbortSignal.timeout(15_000) },
    )) {
      if (event.type === 'text_delta') output.push(event.text);
    }
    expect(requests).toEqual([
      {
        sessionId,
        title: 'ACP agent "fixture-forms" is asking for input',
        declineLabel: 'Decline',
      },
    ]);
    expect(JSON.parse(output.join(''))).toEqual(expected);
  } finally {
    off();
    await provider.closeAll();
    bindAcpLeaderHost(undefined);
  }
});
