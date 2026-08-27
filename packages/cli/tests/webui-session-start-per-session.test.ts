import { describe, expect, it } from 'vitest';
import { createSessionStartPayloadBuilder } from '../src/webui-server/session-start-payload.js';

/**
 * `session.start` describes ONE session, and with four tabs open that session
 * is usually not the leader's.
 *
 * The payload carries model, provider, context-window mode, window size, cost
 * rates and the context-fill estimate. All six are properties of the tab being
 * announced. Building them from the leader agent — the only context this
 * builder used to read — meant a background tab was told it was running the
 * foreground tab's model, and then billed its own tokens at that model's
 * rates and drew its context bar against that model's window.
 */

type Ctx = {
  session: { id: string };
  model: string;
  provider: { id: string; capabilities: { maxContext: number } };
  meta: Record<string, unknown>;
  lastRequestTokens: number;
  projectRoot: string;
};

const ctxFor = (
  id: string,
  model: string,
  maxContext: number,
  contextWindowMode: string,
  lastRequestTokens: number,
): Ctx => ({
  session: { id },
  model,
  provider: { id: `${model}-provider`, capabilities: { maxContext } },
  meta: { contextWindowMode },
  lastRequestTokens,
  projectRoot: '/repo',
});

function builderWith(contexts: Record<string, Ctx>, leaderId: string) {
  const leader = contexts[leaderId] as Ctx;
  return createSessionStartPayloadBuilder({
    agent: { ctx: leader as never },
    session: { id: leaderId },
    projectRoot: '/repo',
    getSessionContext: (sessionId) => contexts[sessionId] as never,
  });
}

describe('session.start payload is built for the session it names', () => {
  const contexts = {
    sess_leader: ctxFor('sess_leader', 'big-model', 400_000, 'full', 12_000),
    sess_bg: ctxFor('sess_bg', 'small-model', 8_000, 'lean', 3_000),
  };

  it('reports the named tab’s model, provider and context window', async () => {
    const build = builderWith(contexts, 'sess_leader');

    const payload = await build({ sessionId: 'sess_bg' });

    expect(payload).toMatchObject({
      sessionId: 'sess_bg',
      model: 'small-model',
      provider: 'small-model-provider',
      maxContext: 8_000,
      contextMode: 'lean',
      lastInputTokens: 3_000,
    });
  });

  it('still describes the leader when no session is named', async () => {
    const build = builderWith(contexts, 'sess_leader');

    const payload = await build();

    expect(payload).toMatchObject({
      sessionId: 'sess_leader',
      model: 'big-model',
      maxContext: 400_000,
      contextMode: 'full',
    });
  });

  it('falls back to the leader for an id this host does not know', async () => {
    // The single-session host: it has no per-session registry at all, so every
    // payload must keep describing the one context it owns.
    const build = builderWith(contexts, 'sess_leader');

    const payload = await build({ sessionId: 'sess_unknown' });

    expect(payload).toMatchObject({ sessionId: 'sess_unknown', model: 'big-model' });
  });
});
