/**
 * Smoke test — full dependency watcher → mailbox → tech-stack round-trip.
 * Verifies the complete pipeline works end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import { makeMailboxTool, mailboxSessionTag } from '../../src/coordination/mailbox-tool.js';
import { makeDependencyWatcherConfig } from '../../src/coordination/dep-watcher.js';

describe('mailbox end-to-end smoke test', () => {
  let tmpRoot: string;
  let sessionDir: string;
  let mailbox: SqliteMailbox;
  let mockCtx: Record<string, unknown>;
  /** Extra stores a test opened; closed in afterEach so the temp dir unlinks. */
  const extraStores: SqliteMailbox[] = [];

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), `ws-smoke-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(tmpRoot, { recursive: true });
    sessionDir = path.join(tmpRoot, 'session');
    await fs.mkdir(sessionDir, { recursive: true });
    mailbox = new SqliteMailbox(sessionDir);
    mockCtx = {
      meta: {},
      session: { transcriptPath: path.join(sessionDir, 'session.jsonl') },
    };
  });

  afterEach(async () => {
    // Close the store first: SQLite holds `_mailbox.sqlite` (plus `-wal`/`-shm`)
    // open for the life of the connection, and Windows refuses to unlink them.
    for (const store of extraStores.splice(0)) await store.close().catch(() => {});
    await mailbox.close().catch(() => {});
    // Best-effort cleanup of the per-test temp dir.
    await fs
      .rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      .catch(() => {});
  });

  it('full round-trip: dep-watcher → mailbox → tech-stack → result', async () => {
    // ── Step 1: Simulate file watcher detecting package.json change ────
    const watcherCfg = makeDependencyWatcherConfig({
      projectRoot: tmpRoot,
      mailbox,
      targetAgent: 'tech-stack',
      watcherAgentId: 'dep-watcher',
      debounceMs: 10,
    });

    await watcherCfg.onChange({
      path: path.join(tmpRoot, 'package.json'),
      event: 'change',
      timestamp: new Date().toISOString(),
    });

    // The watcher writes after a 10ms debounce. A fixed sleep flakes under
    // full-suite load (the debounce timer is delayed past the wait), so poll
    // the read-only query until the assign message lands instead.
    await expect
      .poll(async () => (await mailbox.query({ to: 'tech-stack', type: 'assign' })).length, {
        timeout: 5000,
      })
      .toBeGreaterThanOrEqual(1);

    // ── Step 2: Tech-stack agent checks mailbox ────────────────────────
    const techStackTool = makeMailboxTool({
      resolveMailbox: () => mailbox,
      agentId: 'tech-stack',
    });

    const checkResult = await techStackTool.execute({ action: 'check' }, mockCtx as any);

    expect(checkResult.ok).toBe(true);
    expect(checkResult.count).toBeGreaterThanOrEqual(1);
    const msg = checkResult.messages[0];
    expect(msg.type).toBe('assign');
    expect(msg.body).toContain('package.json');
    expect(msg.from).toBe('dep-watcher');

    // ── Step 3: Tech-stack agent ack's the task ────────────────────────
    const ackResult = await techStackTool.execute(
      {
        action: 'ack',
        messageId: msg.id,
        completed: true,
        outcome: 'All packages current. No issues.',
      },
      mockCtx as any,
    );
    expect(ackResult.ok).toBe(true);

    // ── Step 4: Tech-stack agent posts result back ─────────────────────
    const sendResult = await techStackTool.execute(
      {
        action: 'send',
        to: 'dep-watcher',
        type: 'result',
        subject: 'Audit complete',
        body: 'package.json audit passed.',
      },
      mockCtx as any,
    );
    expect(sendResult.ok).toBe(true);

    // ── Step 5: Verify complete round-trip ─────────────────────────────
    const allMsgs = await mailbox.query({});
    expect(allMsgs.length).toBeGreaterThanOrEqual(2);

    // Assign message should be completed
    const assignMsgs = await mailbox.query({ type: 'assign' });
    const completedAssign = assignMsgs.find((m) => m.completed);
    expect(completedAssign).toBeDefined();
  });

  it('mailbox status discovers agents across the fleet', async () => {
    // Post status from two agents
    const tool1 = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'worker-1' });
    const tool2 = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'worker-2' });

    await tool1.execute(
      {
        action: 'send',
        to: '*',
        type: 'status',
        subject: 'Auditing package.json',
        body: '',
      },
      mockCtx as any,
    );

    await tool2.execute(
      {
        action: 'send',
        to: '*',
        type: 'status',
        subject: 'Scanning for bugs',
        body: '',
      },
      mockCtx as any,
    );

    // Director checks status
    const dirTool = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'director' });
    const statusResult = await dirTool.execute({ action: 'status' }, mockCtx as any);
    expect(statusResult.ok).toBe(true);
    expect(statusResult.count).toBeGreaterThanOrEqual(2);
  });

  it('cross-session: two sessions share the same project mailbox', async () => {
    // Simulate a real project directory
    const projectDir = path.join(tmpRoot, '.wrongstack', 'projects', 'testproj-a1b2c3');
    await fs.mkdir(projectDir, { recursive: true });

    // Session A — terminal 1
    const mbA = new SqliteMailbox(projectDir);
    extraStores.push(mbA);
    const toolA = makeMailboxTool({ resolveMailbox: () => mbA, agentId: 'leader-sessA' });
    const ctxA = {
      meta: { sessionId: 'sess-A', agentId: 'leader-sessA', agentName: 'Leader A' },
      session: { id: 'sess-A' },
    };

    // Session B — terminal 2
    const mbB = new SqliteMailbox(projectDir);
    extraStores.push(mbB);
    const toolB = makeMailboxTool({ resolveMailbox: () => mbB, agentId: 'leader-sessB' });
    const ctxB = {
      meta: { sessionId: 'sess-B', agentId: 'leader-sessB', agentName: 'Leader B' },
      session: { id: 'sess-B' },
    };

    // Session A sends a message to session B's leader
    const sendResult = await toolA.execute(
      {
        action: 'send',
        to: 'leader-sessB',
        type: 'ask',
        subject: 'Cross-session test',
        body: 'Can you see this from another terminal?',
      },
      ctxA as any,
    );
    expect(sendResult.ok).toBe(true);

    // Session B checks mailbox — should see the message
    const checkB = await toolB.execute({ action: 'check' }, ctxB as any);
    expect(checkB.ok).toBe(true);
    expect(checkB.count).toBeGreaterThanOrEqual(1);
    const msg = checkB.messages[0];
    // Sends carry the process-unique identity (`<base>#<pid>`) so replies
    // route back to the exact process; the bare base id remains an alias.
    expect(msg.from).toBe(`leader-sessA@${mailboxSessionTag('sess-A')}`);
    expect(msg.readByMe).toBe(true); // auto-read on check

    // Session B replies
    const replyResult = await toolB.execute(
      {
        action: 'send',
        to: 'leader-sessA',
        type: 'result',
        subject: 'Re: Cross-session test',
        body: 'Yes, got it!',
      },
      ctxB as any,
    );
    expect(replyResult.ok).toBe(true);

    // Session A checks — should see the reply
    const checkA = await toolA.execute({ action: 'check' }, ctxA as any);
    expect(checkA.ok).toBe(true);
    expect(checkA.count).toBeGreaterThanOrEqual(1);

    // Both agents should appear in online list
    const statusA = await toolA.execute({ action: 'online' }, ctxA as any);
    expect(statusA.ok).toBe(true);
    const agentIds = statusA.agents.map((a: { agentId: string }) => a.agentId);
    // Agents register under their process-unique identity.
    expect(agentIds).toContain(`leader-sessA@${mailboxSessionTag('sess-A')}`);
    expect(agentIds).toContain(`leader-sessB@${mailboxSessionTag('sess-B')}`);

    // Unread count for session A
    const unreadA = await toolA.execute({ action: 'unread' }, ctxA as any);
    expect(unreadA.ok).toBe(true);
    expect(typeof unreadA.count).toBe('number');
  });

  it('dep-watcher-bridge: file-watcher event → mailbox notification', async () => {
    // Simulate an event bus with onPattern support
    const listeners = new Map<string, Array<(event: string, payload: unknown) => void>>();
    const mockEvents = {
      onPattern(pattern: string, fn: (event: string, payload: unknown) => void) {
        if (!listeners.has(pattern)) listeners.set(pattern, []);
        listeners.get(pattern)!.push(fn);
        return () => {
          const arr = listeners.get(pattern);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        };
      },
      emitCustom(event: string, payload: unknown) {
        for (const [pattern, fns] of listeners) {
          if (event === pattern) {
            for (const fn of fns) fn(event, payload);
          }
        }
      },
    };

    const { attachDepWatcherBridge } = await import('../../src/coordination/dep-watcher-bridge.js');

    const dispose = attachDepWatcherBridge({
      events: mockEvents as any,
      mailbox,
      projectRoot: tmpRoot,
      targetAgent: 'tech-stack',
      watcherAgentId: 'dep-watcher',
      debounceMs: 10,
    });

    // Simulate file-watcher plugin emitting a change event
    mockEvents.emitCustom('file-watcher:changed', {
      watchId: 'watch_1',
      path: path.join(tmpRoot, 'package.json'),
      event: 'change',
      filename: 'package.json',
      timestamp: new Date().toISOString(),
    });

    // Poll past the 10ms debounce rather than a fixed sleep (load-tolerant).
    await expect
      .poll(async () => (await mailbox.query({ to: 'tech-stack', type: 'assign' })).length, {
        timeout: 5000,
      })
      .toBe(1);

    // Verify the mailbox received the assign message
    const msgs = await mailbox.query({ to: 'tech-stack', type: 'assign' });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.body).toContain('package.json');
    expect(msgs[0]!.from).toBe('dep-watcher');

    // Non-dependency files should be ignored
    mockEvents.emitCustom('file-watcher:changed', {
      watchId: 'watch_1',
      path: path.join(tmpRoot, 'src', 'index.ts'),
      event: 'change',
      filename: 'index.ts',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 30));
    const allMsgs = await mailbox.query({ to: 'tech-stack' });
    expect(allMsgs.length).toBe(1); // still just the one package.json message

    dispose();
  });
});
