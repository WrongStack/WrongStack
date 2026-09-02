/**
 * Tests for the thin mail_send / mail_inbox tools.
 *
 * These tools wrap SqliteMailbox with identity registration and ergonomic
 * input args. We do NOT need a real SqliteMailbox — a SqliteMailbox is
 * sufficient for testing the tool execute path, as long as we provide a
 * resolveMailbox function that returns it and a Context whose meta fields
 * resolve to predictable identities.
 *
 * The registerAgent/heartbeat calls inside the tool are best-effort (catch
 * swallows errors), so the SqliteMailbox stubs for those (no-ops) are fine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { makeMailSendTool, makeMailInboxTool } from '../../src/coordination/mail-tools.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import { mailboxSessionTag } from '../../src/coordination/mailbox-tool.js';
import type { Context } from '../../src/core/context.js';
import type { Mailbox } from '../../src/coordination/mailbox-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const SESSION_ID = 'test-session';
const SESSION_TAG = mailboxSessionTag(SESSION_ID);
const CALLER_ID = `test-agent@${SESSION_TAG}`;
const BASE_ID = 'test-agent';

function tmpDir(): string {
  return path.join(os.tmpdir(), `ws-mailtools-test-${randomUUID().slice(0, 8)}`);
}

/**
 * Build a minimal Context-shaped object that mail-tools can read.
 * mail-tools reads ctx.meta.agentId, ctx.meta.sessionId, and
 * ctx.meta.source, plus ctx.agentId / ctx.agentName as fallbacks.
 * The deriveCallerIdentity function computes the caller id as
 * <baseId>@<sessionTag> where sessionTag = sha256(sessionId).slice(0,8).
 */
function mockContext(overrides: Record<string, unknown> = {}): Context {
  return {
    agentId: BASE_ID,
    agentName: 'TestAgent',
    meta: {
      agentId: BASE_ID,
      sessionId: SESSION_ID,
      source: 'cli',
      ...((overrides.meta as Record<string, unknown>) ?? {}),
    },
    session: { id: SESSION_ID },
    projectRoot: '/tmp/test-project',
    ...overrides,
  } as never as Context;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('makeMailSendTool', () => {
  let mailbox: Mailbox;
  let dir: string;
  let tool: ReturnType<typeof makeMailSendTool>;

  beforeEach(async () => {
    dir = tmpDir();
    await fs.mkdir(dir, { recursive: true });
    mailbox = new SqliteMailbox(dir);
    tool = makeMailSendTool({
      resolveMailbox: () => mailbox,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('has the correct metadata', () => {
    expect(tool.name).toBe('mail_send');
    expect(tool.category).toBe('Coordination');
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(true);
    expect(tool.capabilities?.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.required).toContain('to');
    expect(tool.inputSchema.required).toContain('subject');
    expect(tool.inputSchema.required).toContain('body');
  });

  it('sends a note to a specific agent', async () => {
    const result = await tool.execute(
      { to: 'other-agent', subject: 'hello', body: 'world' },
      mockContext(),
    );
    expect(result).toMatchObject({
      ok: true,
      to: 'other-agent',
    });
    expect(result).toMatchObject({ summary: expect.stringContaining('other-agent') });

    // Verify the message landed in the mailbox
    const messages = await mailbox.query({ to: 'other-agent' });
    expect(messages.length).toBe(1);
    expect(messages[0]?.subject).toBe('hello');
    expect(messages[0]?.body).toBe('world');
    expect(messages[0]?.type).toBe('note'); // default type for direct messages
  });

  it('sends a broadcast when to is "*"', async () => {
    const result = await tool.execute(
      { to: '*', subject: 'announce', body: 'everyone' },
      mockContext(),
    );
    expect(result).toMatchObject({ ok: true, to: '*' });
    expect(result).toMatchObject({ summary: expect.stringContaining('all agents') });
  });

  it('normalizes "all" to "*"', async () => {
    const result = await tool.execute({ to: 'all', subject: 'hey', body: 'all' }, mockContext());
    expect(result).toMatchObject({ ok: true, to: '*' });
  });

  it('canonicalizes "@session" and records the sender session', async () => {
    const result = await tool.execute(
      { to: '@session', subject: 'session update', body: 'local' },
      mockContext(),
    );

    expect(result).toMatchObject({ ok: true, to: `@session:${SESSION_ID}` });
    const messages = await mailbox.query({ to: `@session:${SESSION_ID}` });
    expect(messages[0]).toMatchObject({
      type: 'broadcast',
      senderSessionId: SESSION_ID,
      subject: 'session update',
    });
  });

  it('documents when session scope is too narrow', () => {
    expect(tool.description).toContain('another session may be affected');
    expect(tool.inputSchema.properties.to.description).toContain('@session');
  });

  it('uses broadcast type when to is "*" and no type given', async () => {
    const result = await tool.execute({ to: '*', subject: 's', body: 'b' }, mockContext());
    expect(result.ok).toBe(true);
    const msgs = await mailbox.query({ to: '*' });
    expect(msgs[0]?.type).toBe('broadcast');
  });

  it('accepts an explicit type', async () => {
    const result = await tool.execute(
      { to: 'other', subject: 'urgent', body: 'do this', type: 'assign', priority: 'high' },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    const msgs = await mailbox.query({ to: 'other' });
    expect(msgs[0]?.type).toBe('assign');
    expect(msgs[0]?.priority).toBe('high');
  });

  it('persists the leaders-only audience', async () => {
    const result = await tool.execute(
      { to: '*', subject: 'operator note', body: 'leader context', audience: 'leaders' },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    const msgs = await mailbox.query({ to: '*' });
    expect(msgs[0]?.audience).toBe('leaders');
  });

  it('forces Chimera mail to the leader-only route', async () => {
    const result = await tool.execute(
      { to: '*', subject: 'review', body: 'finding', type: 'result' },
      mockContext({
        agentId: 'chimera-review',
        agentName: 'chimera-review',
        meta: {
          agentId: 'chimera-review',
          agentName: 'chimera-review',
          sessionId: SESSION_ID,
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, to: 'leader' });
    const msgs = await mailbox.query({ to: 'leader' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      to: 'leader',
      audience: 'leaders',
      type: 'result',
    });
    expect(await mailbox.query({ to: '*' })).toHaveLength(0);
  });

  it('re-derives the default type from the FINAL recipient when the policy retargets it', async () => {
    // Regression pin: for a chimera sender with to="*" and NO explicit type,
    // the codec resolves the default ("broadcast") against the REQUESTED
    // recipient ("*"), but the send policy then retargets to the single
    // recipient "leader". Freezing the codec-defaulted type sent "broadcast"
    // to one agent; the canonical default for a directed send is "note".
    // Re-derivation must therefore start from the RAW input type, not the
    // codec-resolved one.
    const result = await tool.execute(
      { to: '*', subject: 'no explicit type', body: 'finding' },
      mockContext({
        agentId: 'chimera-review',
        agentName: 'chimera-review',
        meta: {
          agentId: 'chimera-review',
          agentName: 'chimera-review',
          sessionId: SESSION_ID,
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, to: 'leader' });
    const msgs = await mailbox.query({ to: 'leader' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.type).toBe('note');
  });

  it('includes replyTo when provided', async () => {
    await tool.execute(
      { to: 'bob', subject: 'first', body: 'msg1', replyTo: 'abc-123' },
      mockContext(),
    );
    const msgs = await mailbox.query({ to: 'bob' });
    expect(msgs[0]?.replyTo).toBe('abc-123');
  });

  it('surfaces stripped clutter fields in the result summary', async () => {
    // Pin both branches of the clutter-filter contract: junk fields are
    // removed from the persisted envelope AND reported to the sender.
    const result = (await tool.execute(
      {
        to: 'bob',
        subject: 's',
        body: 'b',
        clientMeta: { theme: 'dark' },
        debugFlag: true,
      },
      mockContext(),
    )) as { ok: boolean; strippedFields?: string[]; summary?: string };

    expect(result.ok).toBe(true);
    expect(result.strippedFields).toEqual(['clientMeta', 'debugFlag']);
    expect(result.summary).toContain('Ignored 2 unrecognized field(s)');
    expect(result.summary).toContain('clientMeta, debugFlag');
    // The clutter must NOT reach the persisted envelope.
    const msgs = await mailbox.query({ to: 'bob' });
    expect(msgs).toHaveLength(1);
    expect(JSON.stringify(msgs[0])).not.toContain('clientMeta');
    expect(JSON.stringify(msgs[0])).not.toContain('debugFlag');
  });

  it('omits the stripped-fields suffix when the payload was clean', async () => {
    const result = (await tool.execute({ to: 'bob', subject: 's', body: 'b' }, mockContext())) as {
      strippedFields?: string[];
      summary?: string;
    };
    expect(result.strippedFields).toBeUndefined();
    expect(result.summary).not.toContain('Ignored');
  });

  it('rejects missing required fields', async () => {
    const ctx = mockContext();
    // Missing to
    const r1 = await tool.execute({ subject: 's', body: 'b' }, ctx);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('required');

    // Missing subject
    const r2 = await tool.execute({ to: 'x', body: 'b' }, ctx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('required');

    // Missing body
    const r3 = await tool.execute({ to: 'x', subject: 's' }, ctx);
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('required');
  });

  it('handles null/undefined body gracefully', async () => {
    const r = await tool.execute({ to: 'x', subject: 's', body: null }, mockContext());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('required');
  });
});

describe('makeMailInboxTool', () => {
  let mailbox: Mailbox;
  let dir: string;
  let _sendTool: ReturnType<typeof makeMailSendTool>;
  let inboxTool: ReturnType<typeof makeMailInboxTool>;

  beforeEach(async () => {
    dir = tmpDir();
    await fs.mkdir(dir, { recursive: true });
    mailbox = new SqliteMailbox(dir);
    _sendTool = makeMailSendTool({
      resolveMailbox: () => mailbox,
    });
    inboxTool = makeMailInboxTool({
      resolveMailbox: () => mailbox,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('has the correct metadata', () => {
    expect(inboxTool.name).toBe('mail_inbox');
    expect(inboxTool.category).toBe('Coordination');
    expect(inboxTool.permission).toBe('auto');
    expect(inboxTool.mutating).toBe(true);
    expect(inboxTool.inputSchema).toBeDefined();
  });

  it('returns empty inbox when no messages', async () => {
    const result = await inboxTool.execute({}, mockContext());
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.summary).toContain('Inbox empty');
  });

  it('returns messages addressed to the caller', async () => {
    // Send a message from another agent to the caller's identity
    await mailbox.send({
      from: 'sender-1',
      to: CALLER_ID,
      type: 'note',
      subject: 'hello',
      body: 'world',
    });

    const result = await inboxTool.execute({}, mockContext());
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.messages[0]?.subject).toBe('hello');
    expect(result.messages[0]?.body).toBe('world');
  });

  it('hides leaders-only broadcasts from subagents but delivers them to the leader', async () => {
    await mailbox.send({
      from: 'system',
      to: '*',
      type: 'broadcast',
      audience: 'leaders',
      subject: 'leader context',
      body: 'do not inject into workers',
    });

    const workerResult = await inboxTool.execute({}, mockContext());
    expect(workerResult.count).toBe(0);

    const leaderResult = await inboxTool.execute(
      {},
      mockContext({ agentId: 'leader', meta: { agentId: 'leader', sessionId: SESSION_ID } }),
    );
    expect(leaderResult.count).toBe(1);
    expect(leaderResult.messages[0]).toMatchObject({
      subject: 'leader context',
      audience: 'leaders',
    });
  });

  it('returns broadcasts as well', async () => {
    await mailbox.send({
      from: 'sender',
      to: '*',
      type: 'broadcast',
      subject: 'all',
      body: 'everyone',
    });

    const result = await inboxTool.execute({}, mockContext());
    expect(result.count).toBe(1);
    expect(result.messages[0]?.subject).toBe('all');
  });

  it('returns mail for the current session but not another session', async () => {
    await mailbox.send({
      from: 'sender-a',
      to: '@session',
      type: 'broadcast',
      subject: 'current-session',
      body: 'local',
      senderSessionId: SESSION_ID,
    });
    await mailbox.send({
      from: 'sender-b',
      to: '@session',
      type: 'broadcast',
      subject: 'other-session',
      body: 'foreign',
      senderSessionId: 'other-session',
    });

    const result = await inboxTool.execute({}, mockContext());
    expect(result.messages.map((m: { subject: string }) => m.subject)).toContain('current-session');
    expect(result.messages.map((m: { subject: string }) => m.subject)).not.toContain(
      'other-session',
    );
  });

  it('marks messages as read by default', async () => {
    await mailbox.send({
      from: 'other',
      to: CALLER_ID,
      type: 'note',
      subject: 'unread',
      body: 'body',
    });

    await inboxTool.execute({}, mockContext());

    // After reading, the message should not appear again
    const again = await inboxTool.execute({}, mockContext());
    expect(again.count).toBe(0);

    // Verify read receipt was recorded
    const query = await mailbox.query({ to: CALLER_ID });
    expect(query[0]?.readBy[CALLER_ID]).toBeDefined();
  });

  it('skip-read mode: markRead=false does not add read receipt', async () => {
    await mailbox.send({
      from: 'other',
      to: CALLER_ID,
      type: 'note',
      subject: 'peek',
      body: 'still unread',
    });

    const result = await inboxTool.execute({ markRead: false }, mockContext());
    expect(result.count).toBe(1);
    expect(result.summary).not.toContain('marked read');

    // Message should appear again since it wasn't marked read
    const again = await inboxTool.execute({}, mockContext());
    expect(again.count).toBe(1);
  });

  it('completed=true marks all returned messages as completed', async () => {
    await mailbox.send({
      from: 'other',
      to: CALLER_ID,
      type: 'assign',
      subject: 'task1',
      body: 'do it',
    });

    const result = await inboxTool.execute({ completed: true, outcome: 'handled' }, mockContext());
    expect(result.count).toBe(1);
    expect(result.summary).toContain('completed');

    // Verify completion was recorded
    const query = await mailbox.query({ to: CALLER_ID });
    expect(query[0]?.completed).toBe(true);
    expect(query[0]?.outcome).toBe('handled');
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await mailbox.send({
        from: 'sender',
        to: CALLER_ID,
        type: 'note',
        subject: `msg-${i}`,
        body: `body-${i}`,
      });
    }

    const result = await inboxTool.execute({ limit: 2 }, mockContext());
    expect(result.count).toBe(2);
  });

  it('filters out messages from self', async () => {
    // Send a message FROM the caller's identity
    await mailbox.send({
      from: CALLER_ID,
      to: CALLER_ID,
      type: 'note',
      subject: 'self',
      body: 'should not appear',
    });

    const result = await inboxTool.execute({}, mockContext());
    expect(result.count).toBe(0);
  });

  it('truncates long bodies over 2000 chars', async () => {
    const longBody = 'x'.repeat(3000);
    await mailbox.send({
      from: 'other',
      to: CALLER_ID,
      type: 'note',
      subject: 'long',
      body: longBody,
    });

    const result = await inboxTool.execute({}, mockContext());
    expect(result.messages[0]?.body.length).toBeLessThan(3000);
    expect(result.messages[0]?.body).toContain('[truncated]');
  });

  it('deduplicates messages sent to both callerId and baseId', async () => {
    // Send one to the unique id and one to the base id
    await mailbox.send({
      from: 'other',
      to: CALLER_ID,
      type: 'note',
      subject: 'unique',
      body: 'to unique id',
    });
    await mailbox.send({
      from: 'other',
      to: BASE_ID,
      type: 'note',
      subject: 'base',
      body: 'to base id',
    });

    const result = await inboxTool.execute({}, mockContext());
    expect(result.count).toBe(2);
  });

  it('handles errors from ackMany gracefully (no crash)', async () => {
    // Simulate by having the resolveMailbox return a broken mailbox
    const brokenMailbox = {
      query: async (_q: unknown) => [
        {
          id: 'm1',
          from: 'x',
          to: 'me',
          type: 'note',
          subject: 's',
          body: 'hello',
          timestamp: new Date().toISOString(),
        },
      ],
      ackMany: async () => {
        throw new Error('broken');
      },
    } as never as Mailbox;

    const brokenTool = makeMailInboxTool({
      resolveMailbox: () => brokenMailbox,
    });

    const result = await brokenTool.execute({ markRead: true }, mockContext());
    // Should not throw — catch(() => null) inside the tool
    expect(result.ok).toBe(true);
  });
});
