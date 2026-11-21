import { describe, expect, it } from 'vitest';
import { ACPSessionError } from '../src/client/acp-session-errors.js';
import {
  type ACPSessionOpContext,
  executeCreateSession,
  executeOpenSession,
} from '../src/client/acp-session-ops.js';
import type { SessionId } from '../src/types/acp-v1.js';

function makeOpCtx(overrides?: Partial<ACPSessionOpContext>): ACPSessionOpContext {
  let id = 1;
  return {
    closed: false,
    sessionId: null,
    agentCapabilities: { loadSession: true },
    opts: { projectRoot: '/tmp', resumeSessionId: 'sess_prev' } as ACPSessionOpContext['opts'],
    allocId: () => id++,
    sendRequest: async () => ({ sessionId: 'sess_new' }),
    setSessionId(next) {
      this.sessionId = next;
    },
    resetScratch() {},
    async closeSession() {
      this.sessionId = null;
    },
    ...overrides,
  };
}

describe('acp-session-ops lifecycle & null-result guards', () => {
  it('executeOpenSession rejects and clears sessionId when closed while create() is in flight', async () => {
    const ctx = makeOpCtx();
    let release!: (id: SessionId) => void;
    const createPromise = new Promise<SessionId>((resolve) => {
      release = resolve;
    });

    const pending = executeOpenSession(ctx, () => createPromise);
    ctx.closed = true;
    release('sess_late' as SessionId);

    await expect(pending).rejects.toThrow(ACPSessionError);
    expect(ctx.sessionId).toBeNull();
  });

  it('executeCreateSession accepts null/undefined JSON-RPC results from session/load', async () => {
    const ctxNull = makeOpCtx({
      sendRequest: async (_id, method) =>
        method === 'session/load' ? null : { sessionId: 'sess_new' },
    });
    expect(await executeCreateSession(ctxNull)).toBe('sess_prev');

    const ctxUndef = makeOpCtx({
      sendRequest: async (_id, method) =>
        method === 'session/load' ? undefined : { sessionId: 'sess_new' },
    });
    expect(await executeCreateSession(ctxUndef)).toBe('sess_prev');
  });
});
