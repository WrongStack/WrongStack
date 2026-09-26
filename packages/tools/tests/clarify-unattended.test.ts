/**
 * A form nobody is there to answer, end to end: the clarify tool asks through
 * the run's Context, the Context hands the conversation's mode to the host's
 * awaiter, and in an eternal / parallel run the awaiter gives up so the tool
 * takes its recommended answers. An attended run keeps waiting for a person.
 */
import { Context, createEventUserInputAwaiter, isUnattendedAutonomy } from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it } from 'vitest';
import { clarifyTool } from '../src/index.js';

const RECOMMENDED = 'E.164 with a unique index';

function setup(autonomy: string) {
  const events = new EventBus();
  // A WebUI tab is open, so the question is shown — but nobody answers it.
  events.on('user.input_requested', () => undefined);
  const ctx = new Context({
    systemPrompt: [],
    provider: null as never,
    session: { id: 'sess-1' } as never,
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
  });
  ctx.meta['autonomy'] = autonomy;
  ctx.userInputAwaiter = createEventUserInputAwaiter(events, {
    isUnattended: (meta) => isUnattendedAutonomy(meta?.['autonomy'], 'off'),
    unattendedWaitMs: 20,
  });
  const ask = (signal: AbortSignal) =>
    clarifyTool.execute(
      {
        question: 'How should phone numbers be stored?',
        options: [RECOMMENDED, 'Freeform string'],
        recommendedOption: RECOMMENDED,
      },
      ctx as never,
      { signal },
    );
  return { ask };
}

describe('clarify with nobody there to answer', () => {
  it('takes the recommended answer in an eternal run', async () => {
    const output = await setup('eternal').ask(new AbortController().signal);
    expect(output.status).toBe('auto_decided');
    expect(output.selectedOptions).toContain(RECOMMENDED);
  });

  it('keeps waiting for a person in an attended run', async () => {
    const abort = new AbortController();
    let settled = false;
    const pending = setup('auto')
      .ask(abort.signal)
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    abort.abort();
    await pending;
  });
});
