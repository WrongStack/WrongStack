import type { SessionWriter } from '@wrongstack/contracts/types/session';
import { describe, expect, it } from 'vitest';
import { makeMailSendTool } from '../../src/coordination/mail-tools.js';
import type { Mailbox, MailboxMessage } from '../../src/coordination/mailbox-types.js';
import { sessionNoteHub } from '../../src/coordination/session-note-hub.js';
import { makeSessionNoteTool } from '../../src/coordination/session-note-tool.js';
import { Context, resolveOwningSessionId } from '../../src/core/context.js';
import { consumeSessionNotes, enqueueSessionNote } from '../../src/core/session-notes.js';

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

  it('fails closed (no mail fallback) when an unstamped worker names a session no inbox is on', async () => {
    const leader = makeCtx('leader', 'tab-1');
    const off = sessionNoteHub.register({
      sessionId: 'tab-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(leader, n),
    });
    const sent: Record<string, unknown>[] = [];
    try {
      // No stamp: the writer is all there is, and it names the worker's own
      // journal. Fail-closed by design — mis-delivery is worse than silence.
      const worker = makeCtx('explore-companion-abc', 'sub-sess-9');
      // An unscoped "leader" mail would reach every leader on the project, so
      // the fallback refuses and the call fails visibly instead of dropping.
      await expect(
        makeSessionNoteTool({ resolveMailbox: () => recordingMailbox(sent) }).execute(
          { to: 'leader', kind: 'result', body: 'lost' },
          worker,
          exec,
        ),
      ).rejects.toThrow(/no owning-session stamp/);
      expect(sent).toEqual([]);
      expect(consumeSessionNotes(leader)).toEqual([]);
    } finally {
      off();
    }
  });
});

describe('session_note leader fallback to mail', () => {
  it('delivers live — and sends no mail — when the leader inbox is registered', async () => {
    const leader = makeCtx('leader', 'tab-1');
    const off = sessionNoteHub.register({
      sessionId: 'tab-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(leader, n),
    });
    const sent: Record<string, unknown>[] = [];
    try {
      const out = (await makeSessionNoteTool({
        resolveMailbox: () => recordingMailbox(sent),
      }).execute(
        { to: 'leader', kind: 'result', body: 'live' },
        makeCtx('worker-1', 'sub-sess-9', 'tab-1'),
        exec,
      )) as { delivered: number; channel: string };
      expect(out).toMatchObject({ delivered: 1, channel: 'session' });
      expect(sent).toEqual([]);
    } finally {
      off();
    }
  });

  it('mails the owning leader when no leader inbox is live', async () => {
    const sent: Record<string, unknown>[] = [];
    const out = (await makeSessionNoteTool({
      resolveMailbox: () => recordingMailbox(sent),
    }).execute(
      { to: 'leader', kind: 'result', body: 'src/a.ts:12', subject: '[explore]' },
      makeCtx('worker-1', 'sub-sess-9', 'tab-1'),
      exec,
    )) as { delivered: number; channel: string; messageId: string };
    expect(out).toMatchObject({ delivered: 0, channel: 'mail', messageId: 'm1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'leader',
      type: 'result',
      subject: '[explore]',
      body: 'src/a.ts:12',
      // Scoped to the worker's own conversation, never every leader.
      sessionAffinity: { sessionId: 'tab-1' },
    });
  });

  it('fails the call when a non-leader recipient is not live (no silent drop, no mail)', async () => {
    const sent: Record<string, unknown>[] = [];
    await expect(
      makeSessionNoteTool({ resolveMailbox: () => recordingMailbox(sent) }).execute(
        { to: 'reviewer-1', body: 'ping' },
        makeCtx('worker-1', 'sub-sess-9', 'tab-1'),
        exec,
      ),
    ).rejects.toThrow(/not a live agent in this session/);
    expect(sent).toEqual([]);
  });

  it('treats a session broadcast with no live peers as a real zero-audience answer', async () => {
    const sent: Record<string, unknown>[] = [];
    const out = (await makeSessionNoteTool({
      resolveMailbox: () => recordingMailbox(sent),
    }).execute(
      { to: '@session', body: 'fyi' },
      makeCtx('worker-1', 'sub-sess-9', 'tab-1'),
      exec,
    )) as { delivered: number; channel: string };
    expect(out).toMatchObject({ delivered: 0, channel: 'session' });
    expect(sent).toEqual([]);
  });

  it('surfaces a failed mail fallback as a failed call', async () => {
    const failing = {
      registerAgent: async () => {},
      send: async () => {
        throw new Error('mailbox daemon down');
      },
    } as unknown as Mailbox;
    await expect(
      makeSessionNoteTool({ resolveMailbox: () => failing }).execute(
        { to: 'leader', body: 'x' },
        makeCtx('worker-1', 'sub-sess-9', 'tab-1'),
        exec,
      ),
    ).rejects.toThrow(/mail fallback failed: mailbox daemon down/);
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
    );
    expect(sent[0]?.['sessionAffinity']).toBeUndefined();
  });

  it('leaves an unstamped sender unscoped — a token it cannot get right is worse than none', async () => {
    const sent: Record<string, unknown>[] = [];
    const tool = makeMailSendTool({ resolveMailbox: () => recordingMailbox(sent) });
    await tool.execute(
      { to: 'leader', subject: 'found', body: 'src/a.ts:12' },
      makeCtx('worker-1', 'sub-sess-9'),
    );
    expect(sent[0]?.['sessionAffinity']).toBeUndefined();
  });
});
