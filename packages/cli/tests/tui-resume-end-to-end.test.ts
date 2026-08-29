/**
 * `/resume` → Enter → the conversation is actually on screen.
 *
 * Everything around this seam was covered and the seam itself was not: the
 * picker key test proves Enter calls `onResumeSession`, and the ownership
 * tests prove the writer swap and its rollbacks — but every one of those
 * mocks BOTH the session store and `replaySessionMessages`, so nothing
 * proved that a real journal on disk comes back as real history entries.
 *
 * This test uses the real store, the real journal, and the real TUI replay.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeSession } from '../src/boot/tui-session-resume.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tui-resume-'));
  dirs.push(dir);
  return dir;
}

/** A session with a real two-turn conversation and a clean ending. */
async function seedSession(dir: string, id: string): Promise<void> {
  const store = new DefaultSessionStore({ dir });
  const writer = await store.create({ id, model: 'seeded-model', provider: 'seeded-provider' });
  await writer.append({
    type: 'user_input',
    ts: '2026-01-01T00:00:01.000Z',
    content: 'what does the parser do?',
  });
  await writer.append({
    type: 'llm_response',
    ts: '2026-01-01T00:00:02.000Z',
    content: [{ type: 'text', text: 'It splits the flags from the positionals.' }],
    stopReason: 'end_turn',
    usage: { input: 120, output: 40 },
    model: 'seeded-model',
    provider: 'seeded-provider',
  });
  await writer.append({
    type: 'user_input',
    ts: '2026-01-01T00:00:03.000Z',
    content: 'and the boolean ones?',
  });
  await writer.append({
    type: 'llm_response',
    ts: '2026-01-01T00:00:04.000Z',
    content: [{ type: 'text', text: 'Those come from BOOLEAN_FLAGS.' }],
    stopReason: 'end_turn',
    usage: { input: 200, output: 30 },
    model: 'seeded-model',
    provider: 'seeded-provider',
  });
  await writer.append({
    type: 'session_end',
    ts: '2026-01-01T00:00:05.000Z',
    usage: { input: 320, output: 70 },
  });
  await writer.close();
  await store.dispose?.();
}

function harness(dir: string) {
  const liveWriter = {
    id: 'live-session',
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const context = {
    session: liveWriter,
    messages: [{ role: 'user', content: 'the session we are leaving' }],
    model: 'live-model',
    provider: { id: 'live-provider', capabilities: { maxContext: 200_000 } },
    traceId: 'trace-e2e',
    workingDir: dir,
    state: {
      messages: [] as unknown[],
      todos: [] as unknown[],
      replaceMessages: vi.fn((messages: unknown[]) => {
        context.messages = messages as typeof context.messages;
      }),
      replaceTodos: vi.fn(),
      setMeta: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    },
    flushConversationJournal: vi.fn(async () => undefined),
  };
  return {
    context,
    liveWriter,
    ctx: {
      // No projectSlug/globalRoot: the resume takes the `activateSessionIdentity`
      // branch instead of reserving in the machine-wide registry, so the test
      // cannot collide with a real wstack running on this box.
      state: {
        projectRoot: dir,
        wpaths: { projectSessions: dir, globalConfig: path.join(dir, 'config.json') },
        activeSessionStore: new DefaultSessionStore({ dir }),
        activateSessionIdentity: vi.fn(async () => undefined),
        detachActiveTodosCheckpoint: undefined,
        sessionRef: { current: liveWriter } as { current: unknown },
        pendingProjectSwitch: null,
        autonomousCoordinator: null,
        coordinatorRun: null,
        coordinatorEvents: new Set(),
      },
      agent: { ctx: context },
      tokenCounter: {
        total: vi.fn(() => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })),
        reset: vi.fn(),
        account: vi.fn(),
        currentRequestTokens: vi.fn(() => ({ input: 320, cacheRead: 0, cacheWrite: 0 })),
      },
      switchProviderAndModel: vi.fn(async () => undefined),
    },
  };
}

describe('TUI /resume end to end', () => {
  it('replays a journal on disk into history entries and repoints the agent at it', async () => {
    const dir = await tempDir();
    await seedSession(dir, 'picked-session');
    const h = harness(dir);

    const result = await resumeSession(h.ctx as never, 'picked-session');

    // Enter on the picker dispatches `replaceHistory` with exactly this —
    // a null here is the "Failed to resume session …" the user would see.
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe('picked-session');
    expect(result?.entries.length).toBeGreaterThan(0);
    expect(result?.nextId).toBe((result?.entries.length ?? 0) + 1);

    // Both turns are on screen, in order — not just "something replayed".
    const rendered = JSON.stringify(result?.entries);
    expect(rendered).toContain('what does the parser do?');
    expect(rendered).toContain('It splits the flags from the positionals.');
    expect(rendered).toContain('and the boolean ones?');
    expect(rendered).toContain('Those come from BOOLEAN_FLAGS.');

    // The agent now speaks for the resumed session: the next prompt must append
    // to THAT journal, not to the one the user left.
    expect(h.context.session.id).toBe('picked-session');
    expect((h.ctx.state.sessionRef as { current: { id: string } }).current.id).toBe(
      'picked-session',
    );
    expect(h.context.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);

    // The session being left is ended and closed — otherwise every /resume
    // leaves behind a journal that recovery reads as a crash.
    await vi.waitFor(() => expect(h.liveWriter.close).toHaveBeenCalled());
    expect(h.liveWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_end' }),
    );
  }, 30_000);

  it('reports failure instead of half-resuming when the id does not exist', async () => {
    const dir = await tempDir();
    await seedSession(dir, 'picked-session');
    const h = harness(dir);

    // `null`, not a throw: the picker turns it into "Failed to resume session
    // …" and stays open on the list. A throw here would surface as an
    // unhandled rejection in the Ink tree instead.
    await expect(resumeSession(h.ctx as never, 'no-such-session')).resolves.toBeNull();

    // The pane must still belong to the session the user was in.
    expect(h.context.session.id).toBe('live-session');
    expect(h.liveWriter.close).not.toHaveBeenCalled();
  }, 30_000);
});
