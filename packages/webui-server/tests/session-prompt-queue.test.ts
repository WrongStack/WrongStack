/**
 * The host-owned prompt queue: prompts queued for a session run one after
 * another as its turns end, on the server — with no page watching — and
 * survive a host restart.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QueueStore } from '@wrongstack/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createConversationOperations } from '../src/server/conversation-operations.js';
import {
  createSessionPromptQueue,
  handlePromptQueueMessage,
  promptQueueDirFor,
  type QueuedPrompt,
} from '../src/server/session-prompt-queue.js';

const commitFailure = vi.hoisted(() => ({ target: undefined as string | undefined }));
const statFailure = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rename: typeof actual.rename = (from, to) => {
    if (String(to) === commitFailure.target) {
      return Promise.reject(
        Object.assign(new Error('Injected filesystem commit failure'), { code: 'EIO' }),
      );
    }
    return actual.rename(from, to);
  };
  const stat = (p: Parameters<typeof actual.stat>[0]) => {
    if (statFailure.on && String(p).endsWith('queue.json')) {
      return Promise.reject(
        Object.assign(new Error('Injected queue read failure'), { code: 'EIO' }),
      );
    }
    return actual.stat(p);
  };
  return { ...actual, default: { ...actual, rename, stat }, rename, stat };
});

type Outbound = { type: string; payload: unknown };

const dirs: string[] = [];
afterEach(async () => {
  commitFailure.target = undefined;
  statFailure.on = false;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'prompt-queue-'));
  dirs.push(dir);
  return dir;
}

const flush = () => new Promise((r) => setImmediate(r));

/** Real session ids are date-scoped, with a `/` in them. */
const SESSION = '2026-09-23/sess_01ABC';
/** A 1x1 PNG, so the image passes the attachment check. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function queueHarness(
  opts: { dir?: string; legacyDir?: string; busy?: boolean; start?: boolean } = {},
) {
  const broadcasts: Outbound[] = [];
  const started: QueuedPrompt[] = [];
  let busy = opts.busy ?? false;
  const queue = createSessionPromptQueue({
    sessionsDir: opts.dir,
    legacyDir: opts.legacyDir,
    isBusy: () => busy,
    startTurn: async (_sid, prompt, onStart) => {
      if (opts.start === false) return false;
      onStart();
      started.push(prompt);
      return true;
    },
    broadcast: (m) => broadcasts.push(m),
  });
  return {
    queue,
    broadcasts,
    started,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

describe('createSessionPromptQueue', () => {
  it('holds prompts while the session is busy and runs the front one when drained', async () => {
    const h = queueHarness({ busy: true });
    await h.queue.add('s1', { text: 'first' });
    await h.queue.add('s1', { text: '  second  ' });
    await flush();
    expect(h.started).toEqual([]);
    expect((await h.queue.list('s1')).map((p) => p.text)).toEqual(['first', 'second']);

    h.setBusy(false);
    await h.queue.drain('s1');

    expect(h.started.map((p) => p.text)).toEqual(['first']);
    expect((await h.queue.list('s1')).map((p) => p.text)).toEqual(['second']);
    // Pages learn which prompt started (to show it as the user's message)
    // before the updated list.
    const tail = h.broadcasts.slice(-2);
    expect(tail[0]).toMatchObject({ type: 'queue.drained', payload: { item: { text: 'first' } } });
    expect(tail[1]).toMatchObject({
      type: 'queue.state',
      payload: { sessionId: 's1', items: [{ text: 'second', imageCount: 0 }] },
    });
  });

  it('places a front prompt ahead of the queued ones so it runs first when the turn ends', async () => {
    const h = queueHarness({ busy: true });
    await h.queue.add('s1', { text: 'first' });
    await h.queue.add('s1', { text: 'second' });
    const replies: Outbound[] = [];
    await handlePromptQueueMessage(h.queue, {
      sessionId: 's1',
      type: 'queue.add',
      payload: { text: 'steer now', front: true, requestId: 'r1' },
      reply: (message) => replies.push(message),
    });
    expect(replies.at(-1)).toMatchObject({
      type: 'queue.state',
      payload: {
        requestId: 'r1',
        items: [{ text: 'steer now' }, { text: 'first' }, { text: 'second' }],
      },
    });
    h.setBusy(false);
    await h.queue.drain('s1');
    expect(h.started.map((p) => p.text)).toEqual(['steer now']);
    expect((await h.queue.list('s1')).map((p) => p.text)).toEqual(['first', 'second']);
  });

  it('starts a prompt queued while idle right away', async () => {
    const h = queueHarness();
    await h.queue.add('s1', { text: 'now' });
    await flush();
    expect(h.started.map((p) => p.text)).toEqual(['now']);
  });

  it('keeps a prompt whose turn could not start at the front of the queue', async () => {
    const h = queueHarness({ start: false });
    await h.queue.add('s1', { text: 'a' });
    await h.queue.add('s1', { text: 'b' });
    await h.queue.drain('s1');
    expect((await h.queue.list('s1')).map((p) => p.text)).toEqual(['a', 'b']);
    expect(h.broadcasts.some((m) => m.type === 'queue.drained')).toBe(false);
  });

  it('a failed drain republishes and repersists the queue with the front prompt back in place', async () => {
    // Regression: drain() shifts the front prompt out before awaiting
    // startTurn; an add() landing in that window published and persisted a
    // snapshot without it, and the failure path put the prompt back in
    // memory only — the file (and pages) lost it until the next drain.
    const dir = await tempDir();
    const broadcasts: Outbound[] = [];
    let busy = true;
    let open: ((ok: boolean) => void) | undefined;
    const gate = new Promise<boolean>((resolve) => {
      open = resolve;
    });
    const queue = createSessionPromptQueue({
      sessionsDir: dir,
      isBusy: () => busy,
      startTurn: async (_sid, _prompt, onStart) => {
        if (!(await gate)) return false;
        onStart();
        return true;
      },
      broadcast: (m) => broadcasts.push(m),
    });
    await queue.add(SESSION, { text: 'front' });
    busy = false;
    const draining = queue.drain(SESSION);
    await flush(); // 'front' is shifted out; startTurn parks on the gate
    await queue.add(SESSION, { text: 'second' });
    open?.(false);
    await draining;

    // In memory the front prompt is back.
    expect((await queue.list(SESSION)).map((p) => p.text)).toEqual(['front', 'second']);
    // The persisted file says the same, or a host restart loses the front prompt.
    const persisted = JSON.parse(
      await readFile(path.join(dir, SESSION, 'queue.json'), 'utf8'),
    ) as Array<{ displayText: string }>;
    expect(persisted.map((i) => i.displayText)).toEqual(['front', 'second']);
    // Pages see the same list the server holds.
    const lastState = broadcasts.filter((m) => m.type === 'queue.state').at(-1);
    expect(
      (lastState?.payload as { items: Array<{ text: string }> } | undefined)?.items.map(
        (i) => i.text,
      ),
    ).toEqual(['front', 'second']);
  });

  it('a queue read failure during a fire-and-forget drain warns instead of rejecting', async () => {
    // Regression: QueueStore.read() throws on a filesystem failure (a failed
    // read must not be mistaken for an empty queue, or the in-memory state
    // persists over it). drain() let that rejection escape, and every real
    // call site is fire-and-forget (after each turn ends, after an add,
    // after queue.get) — the unhandled rejection took the host process down.
    const dir = await tempDir();
    const warns: string[] = [];
    const started: QueuedPrompt[] = [];
    const queue = createSessionPromptQueue({
      sessionsDir: dir,
      isBusy: () => false,
      startTurn: async (_sid, prompt) => {
        started.push(prompt);
        return true;
      },
      broadcast: () => {},
      warn: (m) => warns.push(m),
    });

    statFailure.on = true;
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    void queue.drain(SESSION); // first touch of the file: read fails with EIO
    await flush();
    await flush();
    process.off('unhandledRejection', onUnhandled);

    expect(rejections).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/not drained/);
    expect(started).toEqual([]);

    // The draining slot was released and nothing was cached: once the read
    // recovers, the next add loads from disk and the prompt runs.
    statFailure.on = false;
    await queue.add(SESSION, { text: 'late' });
    await flush();
    expect(started.map((p) => p.text)).toEqual(['late']);
  });

  it('removes and clears, publishing the list each time', async () => {
    const h = queueHarness({ busy: true });
    const a = await h.queue.add('s1', { text: 'a' });
    await h.queue.add('s1', { text: 'b' });
    if (!a.ok) throw new Error('add failed');

    expect(await h.queue.remove('s1', a.item.id)).toBe(true);
    expect(await h.queue.remove('s1', 'nope')).toBe(false);
    expect(h.broadcasts.at(-1)).toMatchObject({ payload: { items: [{ text: 'b' }] } });
    expect(await h.queue.clear('s1')).toBe(1);
    expect(h.broadcasts.at(-1)).toMatchObject({ type: 'queue.state', payload: { items: [] } });
  });

  it('refuses empty prompts and a full queue', async () => {
    const h = queueHarness({ busy: true });
    expect(await h.queue.add('s1', { text: '   ' })).toMatchObject({ ok: false });
    for (let i = 0; i < 100; i++) await h.queue.add('s1', { text: `p${i}` });
    expect(await h.queue.add('s1', { text: 'one too many' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('full'),
    });
  });

  it('survives a host restart and runs what was left once the session is opened', async () => {
    const dir = await tempDir();
    const before = queueHarness({ dir, busy: true });
    await before.queue.add(SESSION, {
      text: 'left over',
      images: [{ data: PNG, mediaType: 'image/png' }],
    });
    // The session's own folder, in the shape the TUI's queue uses.
    const file = path.join(dir, SESSION, 'queue.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([
      expect.objectContaining({
        displayText: 'left over',
        blocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          { type: 'text', text: 'left over' },
        ],
      }),
    ]);

    const after = queueHarness({ dir });
    const replies: Outbound[] = [];
    await handlePromptQueueMessage(after.queue, {
      sessionId: SESSION,
      type: 'queue.get',
      payload: {},
      reply: (m) => replies.push(m),
    });
    expect(replies[0]).toMatchObject({
      type: 'queue.state',
      payload: { items: [{ text: 'left over', imageCount: 1 }] },
    });
    await flush();
    expect(after.started.map((p) => p.text)).toEqual(['left over']);
    // Emptied queue: the file goes away rather than lingering as `[]`.
    await vi.waitFor(() =>
      expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' }),
    );
  });

  it('ignores a corrupt queue file and never lets an id climb out of the directory', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'sess_2'));
    await writeFile(path.join(dir, 'sess_2', 'queue.json'), '{not json', 'utf8');
    const h = queueHarness({ dir, busy: true });
    expect(await h.queue.list('sess_2')).toEqual([]);

    // An id that would leave the sessions directory is queued in memory only.
    await h.queue.add('../escape', { text: 'x' });
    expect((await h.queue.list('../escape')).map((p) => p.text)).toEqual(['x']);
    await expect(
      readFile(path.join(dir, '..', 'escape', 'queue.json'), 'utf8'),
    ).rejects.toBeDefined();
  });

  it('shares the queue file with the TUI, in both directions', async () => {
    const dir = await tempDir();
    const tui = new QueueStore({ dir: path.join(dir, SESSION) });
    await mkdir(path.join(dir, SESSION), { recursive: true });
    // Left queued in the terminal: the TUI writes no id or time.
    await tui.write([
      { displayText: '[Pasted text #1] explain', blocks: [{ type: 'text', text: 'long paste' }] },
    ]);
    const h = queueHarness({ dir, busy: true });
    const listed = await h.queue.list(SESSION);
    expect(listed).toEqual([
      expect.objectContaining({
        text: '[Pasted text #1] explain',
        blocks: [{ type: 'text', text: 'long paste' }],
        id: expect.any(String),
      }),
    ]);

    // Queued in the browser: the terminal reads it back as its own item.
    await h.queue.add(SESSION, { text: 'from the browser' });
    expect(await tui.read()).toEqual([
      expect.objectContaining({ displayText: '[Pasted text #1] explain' }),
      expect.objectContaining({
        displayText: 'from the browser',
        blocks: [{ type: 'text', text: 'from the browser' }],
      }),
    ]);
  });

  it('moves a queue from the old per-project folder into the session, once', async () => {
    const dir = await tempDir();
    const legacyDir = await tempDir();
    const legacyFile = path.join(legacyDir, '2026-09-23%2fsess_01ABC.json');
    await writeFile(
      legacyFile,
      JSON.stringify([
        {
          id: 'q-old',
          text: 'old prompt',
          addedAt: 1,
          images: [{ data: PNG, mediaType: 'image/png' }],
        },
      ]),
      'utf8',
    );
    const h = queueHarness({ dir, legacyDir, busy: true });
    const [item] = await h.queue.list(SESSION);
    expect(item).toMatchObject({ text: 'old prompt' });
    expect(item?.blocks.map((b) => b.type)).toEqual(['image', 'text']);
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path.join(dir, SESSION, 'queue.json'), 'utf8'))).toEqual([
        expect.objectContaining({ displayText: 'old prompt' }),
      ]),
    );
  });

  it.each(['parent', 'rename'])(
    'retains the legacy source across a blocked %s, then migrates once',
    async (blocked) => {
      const dir = await tempDir();
      const legacyDir = await tempDir();
      const legacyFile = path.join(legacyDir, '2026-09-23%2fsess_01ABC.json');
      const original = [{ text: 'recoverable prompt' }];
      await writeFile(legacyFile, JSON.stringify(original), 'utf8');
      const blockingFile = path.join(dir, '2026-09-23');
      if (blocked === 'parent') await writeFile(blockingFile, 'not a directory', 'utf8');
      else commitFailure.target = path.join(dir, SESSION, 'queue.json');
      const h = queueHarness({ dir, legacyDir, busy: true });
      expect((await h.queue.list(SESSION)).map((item) => item.text)).toEqual([
        'recoverable prompt',
      ]);
      expect(JSON.parse(await readFile(legacyFile, 'utf8'))).toEqual(original);

      commitFailure.target = undefined;
      if (blocked === 'parent') await rm(blockingFile);
      await h.queue.add(SESSION, { text: 'new prompt' });
      await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const restarted = queueHarness({ dir, legacyDir, busy: true });
      expect((await restarted.queue.list(SESSION)).map((item) => item.text)).toEqual([
        'recoverable prompt',
        'new prompt',
      ]);
    },
  );

  it('shows a drained prompt with its images', async () => {
    const h = queueHarness();
    await h.queue.add('s1', { text: 'look', images: [{ data: PNG, mediaType: 'image/png' }] });
    await flush();
    expect(h.broadcasts.find((m) => m.type === 'queue.drained')).toMatchObject({
      payload: { item: { text: 'look', images: [{ data: PNG, mediaType: 'image/png' }] } },
    });
  });
  it('retains a persisted PDF attachment and its filename in the drained conversation frame', async () => {
    const dir = await tempDir();
    const store = new QueueStore({ dir: path.join(dir, SESSION) });
    const source = {
      type: 'base64' as const,
      media_type: 'application/pdf' as const,
      data: 'JVBERi0xLjQK',
    };
    await store.write([
      {
        displayText: 'Read the brief',
        blocks: [
          {
            type: 'document',
            source,
            name: 'brief.pdf',
            text: 'Canonical extracted text',
            pages: 1,
          },
        ],
      },
    ]);
    const h = queueHarness({ dir, busy: true });
    expect((await h.queue.list(SESSION))[0]?.blocks).toEqual([
      expect.objectContaining({ name: 'brief.pdf' }),
    ]);
    h.setBusy(false);
    await h.queue.drain(SESSION);
    expect(h.broadcasts.find((m) => m.type === 'queue.drained')).toMatchObject({
      payload: {
        item: {
          text: 'Read the brief',
          images: [{ data: source.data, mediaType: 'application/pdf', name: 'brief.pdf' }],
        },
      },
    });
  });

  it('puts the queue directory next to the sessions directory', () => {
    expect(promptQueueDirFor(path.join('root', 'projects', 'p', 'sessions'))).toBe(
      path.join('root', 'projects', 'p', 'prompt-queue'),
    );
  });

  it('re-drains the next prompt when a turn ends while post-start queue persistence is still in flight', async () => {
    const dir = await tempDir();
    let busy = true;
    const started: QueuedPrompt[] = [];
    const turn1Started = deferred();

    const queue = createSessionPromptQueue({
      sessionsDir: dir,
      isBusy: () => busy,
      startTurn: async (_sid, prompt, onStart) => {
        busy = true;
        onStart();
        started.push(prompt);
        if (prompt.text === 'first') turn1Started.resolve();
        return true;
      },
      broadcast: () => {},
    });

    await queue.add(SESSION, { text: 'first' });
    await queue.add(SESSION, { text: 'second' });

    busy = false;
    const firstDrain = queue.drain(SESSION);
    await turn1Started.promise;

    busy = false;
    const secondDrain = queue.drain(SESSION);
    await Promise.all([firstDrain, secondDrain]);

    expect(started.map((p) => p.text)).toEqual(['first', 'second']);
    expect(await queue.list(SESSION)).toEqual([]);
  });
});

describe('handlePromptQueueMessage', () => {
  it('retains the original refinement text through queue persistence and restart', async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), 'queue-journal-original-'));
    dirs.push(sessionsDir);
    const deps = {
      sessionsDir,
      isBusy: () => true,
      startTurn: async () => false,
      broadcast: () => {},
    };
    const queue = createSessionPromptQueue(deps);
    await queue.add('journal-session', {
      text: 'Approved final prompt',
      journalRaw: 'Original user prompt',
    });
    const restored = createSessionPromptQueue(deps);
    expect((await restored.list('journal-session'))[0]).toMatchObject({
      text: 'Approved final prompt',
      journalRaw: 'Original user prompt',
    });
  });
  it('acknowledges correlated mutations and reads without changing legacy replies', async () => {
    const h = queueHarness({ busy: true });
    const replies: Outbound[] = [];
    const call = (type: string, payload: Record<string, unknown>) =>
      handlePromptQueueMessage(h.queue, {
        sessionId: 's1',
        type,
        payload,
        reply: (message) => replies.push(message),
      });
    await call('queue.add', { text: 'Native pending prompt', requestId: 'add-1' });
    expect(replies.at(-1)).toMatchObject({
      type: 'queue.state',
      payload: {
        sessionId: 's1',
        requestId: 'add-1',
        items: [{ text: 'Native pending prompt' }],
      },
    });
    const item = (await h.queue.list('s1'))[0]!;
    await call('queue.remove', { id: item.id, requestId: 'remove-1' });
    expect(replies.at(-1)).toMatchObject({
      type: 'queue.state',
      payload: {
        requestId: 'remove-1',
        items: [],
      },
    });
    await call('queue.get', { requestId: 'read-1' });
    expect(replies.at(-1)).toMatchObject({ payload: { requestId: 'read-1', items: [] } });
    await call('queue.clear', { requestId: 'clear-1' });
    expect(replies.at(-1)).toMatchObject({ payload: { requestId: 'clear-1', items: [] } });
    await call('queue.get', {});
    expect(replies.at(-1)).toEqual({
      type: 'queue.state',
      payload: { sessionId: 's1', items: [] },
    });
  });
  it('correlates refusals so a rejected prompt stays in its originating composer', async () => {
    const h = queueHarness({ busy: true });
    const replies: Outbound[] = [];
    await handlePromptQueueMessage(h.queue, {
      sessionId: 's1',
      type: 'queue.add',
      payload: { text: '', requestId: 'refused-1' },
      reply: (message) => replies.push(message),
    });
    expect(replies.at(-1)).toMatchObject({
      type: 'error',
      payload: {
        sessionId: 's1',
        requestId: 'refused-1',
        phase: 'queue.add',
      },
    });
    expect(await h.queue.list('s1')).toEqual([]);
  });
  it('refuses a bad image while the user is still there to see why', async () => {
    const h = queueHarness({ busy: true });
    const replies: Outbound[] = [];
    await handlePromptQueueMessage(h.queue, {
      sessionId: 's1',
      type: 'queue.add',
      payload: { text: 'look', images: [{ data: 'not base64 !!', mediaType: 'text/html' }] },
      reply: (m) => replies.push(m),
    });
    expect(replies[0]).toMatchObject({ type: 'error', payload: { phase: 'queue.add' } });
    expect(await h.queue.list('s1')).toEqual([]);
  });
});

// ── Through the host's turn path ───────────────────────────────────────────

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function hostHarness() {
  const broadcasts: Outbound[] = [];
  const sent: Outbound[] = [];
  const locks = new Map<string, AbortController>();
  const gates: Array<ReturnType<typeof deferred>> = [];
  const inputs: unknown[] = [];
  const run = vi.fn(async (input: unknown) => {
    inputs.push(input);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return { status: 'done', iterations: 1, finalText: `answered ${String(input)}` };
  });
  const ops = createConversationOperations({
    getAgent: () =>
      ({
        run,
        ctx: {
          provider: { id: 'p', capabilities: { vision: true } },
          model: 'm',
          messages: [],
          meta: {},
        },
        tools: { list: () => [] },
      }) as never,
    getSessionId: () => 'sess_live',
    runControl: {
      begin: (_ws, sid) => {
        if (locks.has(sid)) return undefined;
        const c = new AbortController();
        locks.set(sid, c);
        return c;
      },
      end: (_ws, sid, c) => {
        if (locks.get(sid) === c) locks.delete(sid);
      },
      abort: (_ws, sid) => locks.get(sid)?.abort(),
    },
    pendingConfirms: new Map(),
    submitUserInput: vi.fn(),
    send: (_ws, m) => sent.push(m),
    notifyAbort: vi.fn(),
    broadcast: (m) => broadcasts.push(m),
  });
  const ws = {} as WebSocket;
  const finishRun = async (index: number) => {
    gates[index]?.resolve();
    for (let i = 0; i < 5; i++) await flush();
  };
  return { ops, ws, run, inputs, broadcasts, sent, finishRun };
}

describe('conversation operations with the prompt queue', () => {
  it('acknowledges a direct human submission after claiming the turn without changing it to a queued runtime input', async () => {
    const h = hostHarness();
    const pending = h.ops.userMessage(h.ws, {
      type: 'user_message',
      payload: {
        id: 'human-message',
        requestId: 'human-request',
        content: 'Direct human instruction',
      },
    } as never);
    await flush();
    try {
      expect(h.sent).toContainEqual({
        type: 'key.operation_result',
        payload: {
          success: true,
          phase: 'user_message',
          requestId: 'human-request',
          message: 'Message accepted by the engine.',
        },
      });
    } finally {
      await h.finishRun(0);
      await pending;
    }
  });
  it('runs queued prompts one after another as each turn ends, with no page involved', async () => {
    const h = hostHarness();
    void h.ops.userMessage(h.ws, { type: 'user_message', payload: { content: 'first' } } as never);
    await flush();
    await h.ops.queue?.(h.ws, { type: 'queue.add', payload: { text: 'second' } } as never);
    await h.ops.queue?.(h.ws, { type: 'queue.add', payload: { text: 'third' } } as never);
    await flush();
    expect(h.inputs).toEqual(['first']);

    await h.finishRun(0);
    expect(h.inputs).toEqual(['first', 'second']);
    const types = h.broadcasts.map((m) => m.type);
    // The drained prompt is announced before its own run reports anything.
    expect(types.indexOf('queue.drained')).toBeGreaterThan(-1);
    expect(h.broadcasts.find((m) => m.type === 'queue.drained')).toMatchObject({
      payload: { sessionId: 'sess_live', item: { text: 'second' } },
    });

    await h.finishRun(1);
    expect(h.inputs).toEqual(['first', 'second', 'third']);
    await h.finishRun(2);
    expect(h.inputs).toHaveLength(3);
    // Every turn reports to the session's pages, the page's own turn included
    // (its socket may have dropped meanwhile); a queued turn never as a refusal.
    expect(h.broadcasts.filter((m) => m.type === 'run.result')).toHaveLength(3);
    expect(h.sent.filter((m) => m.type === 'run.result')).toEqual([]);
    expect(h.sent.filter((m) => m.type === 'error')).toEqual([]);
  });

  it('starts a prompt queued on an idle session immediately', async () => {
    const h = hostHarness();
    await h.ops.queue?.(h.ws, { type: 'queue.add', payload: { text: 'go' } } as never);
    await flush();
    await flush();
    expect(h.inputs).toEqual(['go']);
    await h.finishRun(0);
  });

  it('runs a prompt with an image as its blocks', async () => {
    const h = hostHarness();
    await h.ops.queue?.(h.ws, {
      type: 'queue.add',
      payload: { text: 'what is this', images: [{ data: PNG, mediaType: 'image/png' }] },
    } as never);
    for (let i = 0; i < 5; i++) await flush();
    expect(h.inputs).toEqual([
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        { type: 'text', text: 'what is this' },
      ],
    ]);
    await h.finishRun(0);
  });
});
