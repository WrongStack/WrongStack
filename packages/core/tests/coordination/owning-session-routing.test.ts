import { describe, expect, it } from 'vitest';
import { makeMailSendTool } from '../../src/coordination/mail-tools.js';
import { sessionNoteHub } from '../../src/coordination/session-note-hub.js';
import { makeSessionNoteTool } from '../../src/coordination/session-note-tool.js';
import type { Mailbox, MailboxMessage } from '../../src/coordination/mailbox-types.js';
import { Context } from '../../src/core/context.js';
import { resolveOwningSessionId } from '../../src/core/context.js';
import { consumeSessionNotes, enqueueSessionNote } from '../../src/core/session-notes.js';
import type { SessionWriter } from '../../src/types/session.js';

/**
 * A worker belongs to the conversation that spawned it, not to its journal.
 *
 * With `sessionsRoot` configured — the real CLI always configures it — every
 * subagent is handed its OWN session writer, so `ctx.session.id` names a
 * private transcript no surface is subscribed to. Everything that routes
 * BETWEEN agents of one conversation has to key off the spawning session
 * instead: `session_note` inboxes, mailbox identity, and the affinity token
 * that keeps one tab's worker out of the other three tabs' leaders.
 *
 * `meta.sessionId` is that spawn-time stamp (host-subagent-factory sets it).
 */

function makeWriter(id: string): SessionWriter {
  return {
    id,
    pendingToolUses: [],
    append: async () => {},
    appendBatch: async () => {},
    flush: async () => {},
    close: async () => {},
    recordFileChange: () => {},
    recordSideEffect: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  };
}

function makeCtx(agentId: string, sessionId: string, owningSessionId?: string): Context {
  const ctx = new Context({
    systemPrompt: [],
    provider: null as never,
    session: makeWriter(sessionId),
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
    agentId,
  });
  if (owningSessionId) ctx.meta['sessionId'] = owningSessionId;
  return ctx;
}

const exec = { signal: new AbortController().signal };

describe('resolveOwningSessionId', () => {
  it('prefers the spawn-time stamp over the writer', () => {
    expect(resolveOwningSessionId(makeCtx('worker-1', 'sub-sess-9', 'tab-1'))).toBe('tab-1');
  });

  it('falls back to the writer for an agent with no stamp (every leader)', () => {
    expect(resolveOwningSessionId(makeCtx('leader', 'tab-1'))).toBe('tab-1');
  });
});

describe('session_note from a worker with its own journal', () => {
  it("reaches the spawning tab's leader, not its own transcript", async () => {
    const leader = makeCtx('leader', 'tab-1');
    const off = sessionNoteHub.register({
      sessionId: 'tab-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(leader, n),
    });
    try {
      const worker = makeCtx('explore-companion-abc', 'sub-sess-9', 'tab-1');
      const out = (await makeSessionNoteTool().execute(
        { to: 'leader', kind: 'result', body: 'map src/a.ts:12' },
        worker,
        exec,
      )) as { ok: boolean; delivered: number };
      expect(out.delivered).toBe(1);
      expect(consumeSessionNotes(leader)[0]?.body).toBe('map src/a.ts:12');
    } finally {
      off();
    }
  });

  it('still reaches nobody when it names a session no inbox is on', async () => {
    const leader = makeCtx('leader', 'tab-1');
    const off = sessionNoteHub.register({
      sessionId: 'tab-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(leader, n),
    });
    try {
      // No stamp: the writer is all there is, and it names the worker's own
      // journal. Fail-closed by design — mis-delivery is worse than silence.
      const worker = makeCtx('explore-companion-abc', 'sub-sess-9');
      const out = (await makeSessionNoteTool().execute(
        { to: 'leader', kind: 'result', body: 'lost' },
        worker,
        exec,
      )) as { delivered: number };
      expect(out.delivered).toBe(0);
      expect(consumeSessionNotes(leader)).toEqual([]);
    } finally {
      off();
    }
  });
});

function recordingMailbox(sent: Record<string, unknown>[]): Mailbox {
  return {
    registerAgent: async () => {},
    deregisterAgent: async () => {},
    send: async (input: Record<string, unknown>) => {
      sent.push(input);
      return { id: 'm1', ...input } as unknown as MailboxMessage;
    },
  } as unknown as Mailbox;
}

describe('mail_send scoping for agents', () => {
  it('scopes a stamped worker’s "leader" mail to its own conversation', async () => {
    const sent: Record<string, unknown>[] = [];
    const tool = makeMailSendTool({ resolveMailbox: () => recordingMailbox(sent) });
    await tool.execute(
      { to: 'leader', subject: 'found', body: 'src/a.ts:12' },
      makeCtx('explore-companion-abc', 'sub-sess-9', 'tab-1'),
      exec,
    );
    expect(sent[0]?.['sessionAffinity']).toEqual({ sessionId: 'tab-1' });
    expect(sent[0]?.['senderSessionId']).toBe('tab-1');
  });

  it('leaves a named recipient unscoped — no ambiguity to resolve', async () => {
    const sent: Record<string, unknown>[] = [];
    const tool = makeMailSendTool({ resolveMailbox: () => recordingMailbox(sent) });
    await tool.execute(
      { to: 'reviewer', subject: 'found', body: 'src/a.ts:12' },
      makeCtx('explore-companion-abc', 'sub-sess-9', 'tab-1'),
      exec,
    );
    expect(sent[0]?.['sessionAffinity']).toBeUndefined();
  });

  it('leaves an unstamped sender unscoped — a token it cannot get right is worse than none', async () => {
    const sent: Record<string, unknown>[] = [];
    const tool = makeMailSendTool({ resolveMailbox: () => recordingMailbox(sent) });
    await tool.execute(
      { to: 'leader', subject: 'found', body: 'src/a.ts:12' },
      makeCtx('worker-1', 'sub-sess-9'),
      exec,
    );
    expect(sent[0]?.['sessionAffinity']).toBeUndefined();
  });
});
