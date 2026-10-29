import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionCheckpointHandlers } from '../src/server/session-checkpoint-handlers.js';
import { createSessionTransitionGate } from '../src/server/session-handler-helpers.js';
import { handleSessionRoute } from '../src/server/session-routes.js';

const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) {
    const target = resolve(path);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('wrongstack-recovery-')
    )
      throw Error('Refusing cleanup outside the owned recovery fixture');
    await rm(target, { recursive: true, force: true });
  }
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-recovery-'));
  owned.push(root);
  const project = join(root, 'project'),
    dir = join(root, 'sessions');
  await mkdir(project);
  const store = new DefaultSessionStore({ dir });
  const writer = await store.create({
    id: 'recovery-test',
    title: 'Recovery fixture',
    model: 'test',
    provider: 'test',
  });
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const broadcast: typeof sent = [];
  let active = false;
  const ws = { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) };
  const context = { session: writer, state: { replaceMessages: () => {} }, meta: {} };
  const handlers = createSessionCheckpointHandlers({
    serializeSessionTransition: createSessionTransitionGate(),
    ctx: {
      getSessionStore: () => store,
      getProjectRoot: () => project,
      isRunActive: () => active,
      sessionStartPayload: async (options: unknown) => ({
        sessionId: writer.id,
        ...(options as object),
      }),
    },
    sendTo: (socket: typeof ws, frame: unknown) => socket.send(JSON.stringify(frame)),
    broadcastToAll: (frame: (typeof sent)[number]) => broadcast.push(frame),
    result: (socket: typeof ws, success: boolean, message: string) =>
      socket.send(JSON.stringify({ type: 'key.operation_result', payload: { success, message } })),
    actingSessionId: () => writer.id,
    ensureCurrentSession: () => true,
    contextForMessage: () => context,
    sessionsDirectory: () => dir,
  } as never);
  const call = async (type: string, payload = {}) => {
    sent.length = 0;
    await handleSessionRoute(
      ws as never,
      { type, payload: { ...payload, requestId: 'reviewed-request' } },
      handlers as never,
    );
    return sent[0]!;
  };
  return {
    root,
    dir,
    project,
    writer,
    call,
    broadcast,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

describe('desktop session recovery through the real session route', () => {
  it('reads a bounded transcript without opening a writer and refuses mixed-revision pages', async () => {
    const h = await harness();
    try {
      for (let i = 0; i < 12; i++)
        await h.writer.append({
          type: 'message_appended',
          ts: new Date().toISOString(),
          version: 1,
          message: {
            role: i % 2 ? 'assistant' : 'user',
            content: `Recorded transcript message ${i}`,
          },
        });
      await h.writer.flush();
      const before = await readFile(join(h.dir, `${h.writer.id}.jsonl`), 'utf8');
      const first = await h.call('session.inspect', {
        id: h.writer.id,
        transcript: { offset: 0, limit: 10 },
        transcriptOnly: true,
      });
      expect(first.payload.transcript).toBeDefined();
      const page = first.payload.transcript as {
        revision: string;
        messages: unknown[];
        nextOffset: number;
        total: number;
      };
      expect(page.messages).toHaveLength(10);
      expect(page.total).toBe(12);
      expect(page.nextOffset).toBe(10);
      expect(await readFile(join(h.dir, `${h.writer.id}.jsonl`), 'utf8')).toBe(before);
      await h.writer.append({
        type: 'message_appended',
        ts: new Date().toISOString(),
        version: 1,
        message: { role: 'user', content: 'Later transcript change' },
      });
      await h.writer.flush();
      const stale = await h.call('session.inspect', {
        id: h.writer.id,
        transcript: { offset: 10, expectedRevision: page.revision },
        transcriptOnly: true,
      });
      expect(stale.payload.error).toMatch(/changed/);
    } finally {
      await h.writer.close();
    }
  });
  it('pages side-effect records from the journal after the runtime window is gone', async () => {
    const h = await harness();
    try {
      for (let i = 0; i < 5; i++)
        await h.writer.append({
          type: 'side_effect',
          ts: new Date(Date.UTC(2026, 9, 29, 10, i)).toISOString(),
          toolUseId: `call-${i}`,
          toolName: 'bash',
          input: { command: `echo ${i}` },
          ...(i === 4 ? {} : { outcome: 'exit 0' }),
          risk: 'shell',
        });
      await h.writer.flush();
      const latest = await h.call('session.inspect', {
        id: h.writer.id,
        journalSideEffects: { limit: 2 },
      });
      const page = latest.payload.journalSideEffects as {
        sessionId: string;
        total: number;
        start: number;
        truncated: boolean;
        sideEffects: { toolUseId: string; outcome?: string }[];
      };
      expect(page).toMatchObject({ sessionId: h.writer.id, total: 5, start: 3, truncated: true });
      expect(page.sideEffects.map((effect) => effect.toolUseId)).toEqual(['call-3', 'call-4']);
      expect(page.sideEffects[1]).not.toHaveProperty('outcome');
      const older = await h.call('session.inspect', {
        id: h.writer.id,
        journalSideEffects: { before: 4, limit: 10 },
      });
      const olderPage = older.payload.journalSideEffects as typeof page;
      expect(olderPage.start).toBe(0);
      expect(olderPage.truncated).toBe(false);
      expect(olderPage.sideEffects.map((effect) => effect.toolUseId)).toEqual([
        'call-0',
        'call-1',
        'call-2',
        'call-3',
      ]);
      expect(older.payload).not.toHaveProperty('events');
    } finally {
      await h.writer.close();
    }
  });
  it('correlates inspection and checkpoint reads and reports unreadable journals', async () => {
    const h = await harness();
    try {
      const inspect = await h.call('session.inspect', { id: h.writer.id });
      expect(inspect.payload.requestId).toBe('reviewed-request');
      expect(inspect.payload.retainedMessageCount).toBe(0);
      expect(inspect.payload.journalTokenTotal).toBe(0);
      const checkpoints = await h.call('session.checkpoints', { includeRevision: true });
      expect(checkpoints.payload.requestId).toBe('reviewed-request');
      expect(checkpoints.payload.journalRevision).toMatch(/^[a-f0-9]{64}$/);
      await h.writer.close();
      await rm(join(h.dir, `${h.writer.id}.jsonl`));
      const missing = await h.call('session.checkpoints', { includeRevision: true });
      expect(missing.payload.error).toBeTruthy();
    } finally {
      await h.writer.close();
    }
  });

  it('refuses stale reviewed journal and active runs before changing real files', async () => {
    const h = await harness();
    const file = join(h.project, 'proof.txt');
    try {
      await h.writer.writeCheckpoint(0, 'First prompt');
      await h.writer.writeFileSnapshot(0, [
        { path: file, action: 'modified', before: 'before', after: 'after' },
      ]);
      await writeFile(file, 'after');
      await h.writer.flush();
      const snapshot = await h.call('session.checkpoints', { includeRevision: true });
      await h.writer.writeCheckpoint(1, 'A later prompt');
      await h.writer.flush();
      const stale = await h.call('session.rewind', {
        checkpointIndex: 0,
        expectedJournalRevision: snapshot.payload.journalRevision,
      });
      expect(stale.payload.success).toBe(false);
      expect(stale.payload.message).toMatch(/changed/);
      expect(await readFile(file, 'utf8')).toBe('after');
      h.setActive(true);
      const active = await h.call('session.rewind', { checkpointIndex: 0 });
      expect(active.payload.success).toBe(false);
      expect(active.payload.message).toMatch(/active/);
      expect(await readFile(file, 'utf8')).toBe('after');
    } finally {
      await h.writer.close();
    }
  });

  it('returns observed file errors and a replacement transcript after a real rewind', async () => {
    const h = await harness();
    const file = join(h.project, 'proof.txt'),
      outside = join(h.root, 'outside.txt');
    try {
      await h.writer.writeCheckpoint(0, 'First prompt');
      await h.writer.writeFileSnapshot(0, [
        { path: file, action: 'modified', before: 'before', after: 'after' },
        { path: outside, action: 'modified', before: 'protected', after: 'outside-after' },
      ]);
      await writeFile(file, 'after');
      await writeFile(outside, 'outside-after');
      await h.writer.flush();
      const snapshot = await h.call('session.checkpoints', { includeRevision: true });
      const reply = await h.call('session.rewind', {
        checkpointIndex: 0,
        expectedJournalRevision: snapshot.payload.journalRevision,
      });
      expect(reply.payload.requestId).toBe('reviewed-request');
      expect(reply.payload.success).toBe(true);
      expect(reply.payload.rewind).toMatchObject({ toPromptIndex: 0, revertedFiles: [file] });
      expect((reply.payload.rewind as { errors: string[] }).errors[0]).toMatch(
        /outside project root/,
      );
      expect(await readFile(file, 'utf8')).toBe('before');
      expect(await readFile(outside, 'utf8')).toBe('outside-after');
      expect(h.broadcast[0]?.payload).toMatchObject({ reset: true, replayMessages: [] });
    } finally {
      await h.writer.close();
    }
  });

  it('redoes the last rewind, and refuses when files changed since or nothing was rewound', async () => {
    const h = await harness();
    const file = join(h.project, 'proof.txt');
    try {
      expect((await h.call('session.redo')).payload).toMatchObject({ success: false });
      await h.writer.writeCheckpoint(0, 'First prompt');
      await h.writer.writeCheckpoint(1, 'Second prompt');
      await h.writer.writeFileSnapshot(1, [
        { path: file, action: 'modified', before: 'before', after: 'after' },
      ]);
      await writeFile(file, 'after');
      await h.writer.flush();
      expect((await h.call('session.rewind', { checkpointIndex: 1 })).payload.success).toBe(true);
      expect(await readFile(file, 'utf8')).toBe('before');

      // An edit after the rewind is not overwritten.
      await writeFile(file, 'edited meanwhile');
      const conflict = await h.call('session.redo');
      expect(conflict.payload).toMatchObject({ success: false });
      expect((conflict.payload.redo as { conflicts: string[] }).conflicts[0]).toMatch(/changed/);
      expect(await readFile(file, 'utf8')).toBe('edited meanwhile');

      await writeFile(file, 'before');
      h.setActive(true);
      expect((await h.call('session.redo')).payload.message).toMatch(/active/);
      h.setActive(false);
      h.broadcast.length = 0;
      const redone = await h.call('session.redo');
      expect(redone.payload).toMatchObject({
        success: true,
        requestId: 'reviewed-request',
        redo: { toPromptIndex: 1, reappliedFiles: [file] },
      });
      expect(await readFile(file, 'utf8')).toBe('after');
      expect(h.broadcast[0]?.payload).toMatchObject({ reset: true });
    } finally {
      await h.writer.close();
    }
  });
});
