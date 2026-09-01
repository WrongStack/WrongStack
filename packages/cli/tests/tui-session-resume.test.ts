import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registryList: vi.fn(),
  loadTodosCheckpoint: vi.fn(),
  attachTodosCheckpoint: vi.fn(),
  replaySessionMessages: vi.fn(),
  reserveResume: vi.fn(),
}));

vi.mock('@wrongstack/core/storage', async (original) => {
  const actual = await original<typeof import('@wrongstack/core/storage')>();
  return {
    ...actual,
    SessionRegistry: class {
      list = mocks.registryList;
    },
    loadTodosCheckpoint: mocks.loadTodosCheckpoint,
    attachTodosCheckpoint: mocks.attachTodosCheckpoint,
    getSessionRegistry: () => ({ reserveResume: mocks.reserveResume }),
  };
});

vi.mock('@wrongstack/tui', () => ({
  replaySessionMessages: mocks.replaySessionMessages,
}));

import { resumeSession, type SessionResumeFailure } from '../src/boot/tui-session-resume.js';

function writer(id: string) {
  return {
    id,
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function harness() {
  const oldWriter = writer('2026-07-27/sess_old');
  const resumedWriter = writer('2026-07-26/sess_resumed');
  const oldMessages = [{ role: 'user', content: 'old' }];
  // `content` is deliberately `unknown`: a real transcript carries both bare
  // strings and content-block arrays, and the last-assistant-turn tests push
  // block arrays (text blocks, and a tool_use-only turn) through here.
  const resumedMessages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'resumed' },
  ];
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
  // Journal events the resumed session replays. Empty by default ("never
  // reached the model"); the contextSnapshot tests push an llm_response into
  // this array to exercise the journal-based token source.
  const resumedEvents: Array<Record<string, unknown>> = [];
  const context = {
    session: oldWriter,
    messages: oldMessages,
    model: 'old-model',
    // Set by resumeSession from the journal's last llm_response
    // (projectLastRequestTokens); asserted in the snapshot-contract tests.
    lastRequestTokens: undefined as number | undefined,
    provider: {
      id: 'old-provider',
      capabilities: { maxContext: 200_000 },
    },
    traceId: 'trace-test',
    state: {
      replaceMessages: vi.fn((messages: typeof oldMessages) => {
        context.messages = messages;
      }),
      replaceTodos: vi.fn(),
      setMeta: vi.fn(),
    },
    flushConversationJournal: vi.fn(async () => undefined),
  };
  const resumeStore = vi.fn(async () => ({
    writer: resumedWriter,
    data: {
      metadata: {
        id: resumedWriter.id,
        provider: 'resumed-provider',
        model: 'resumed-model',
      },
      messages: resumedMessages,
      events: resumedEvents,
      usage,
    },
  }));
  const loadStore = vi.fn(async () => ({
    metadata: {
      id: resumedWriter.id,
      provider: 'resumed-provider',
      model: 'resumed-model',
    },
    messages: resumedMessages,
    events: resumedEvents,
    usage,
  }));
  const activateSessionIdentity = vi.fn(async (_sessionId: string) => undefined);
  // The byte-progress sink the TUI hands to onResumeSession; resumeSession
  // must forward it verbatim to the store's JSONL loader.
  const onLoadProgress = vi.fn();
  // Snapshot of the pre-resume todos-detach handle. The rollback test
  // asserts the outer catch restores `state.detachActiveTodosCheckpoint`
  // to THIS exact reference — without exposing it, the assertion compares
  // against `undefined` and the field's shared-mock identity is invisible.
  const priorDetachFn = vi.fn(async () => undefined);
  const tokenCounter = {
    total: vi.fn(() => ({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 })),
    reset: vi.fn(),
    account: vi.fn(),
    // Part of the TokenCounter shape; the resume path no longer reads it —
    // the contextSnapshot estimate now comes from the journal's last
    // llm_response via core's projectLastRequestTokens. Kept so the mock
    // satisfies the interface other hosts still rely on.
    currentRequestTokens: vi.fn(() => ({ input: 7, cacheRead: 3, cacheWrite: 2 })),
    // The statusline's fill ladder reads this snapshot. `account()` leaves the
    // CUMULATIVE figure in it, so the resume has to overwrite it with a real
    // per-request number or the bar draws the session's lifetime spend as its
    // context fill.
    setCurrentRequestTokens: vi.fn(),
  };
  const state = {
    projectRoot: '/project',
    wpaths: {
      globalConfig: '/global/config.json',
      projectSessions: '/global/projects/project/sessions',
    },
    activeSessionStore: {
      resolveId: vi.fn(async (id: string) => id),
      resume: resumeStore,
      // Read-only path: `resumeSession` falls back to `load()` when it cannot
      // take ownership, so the transcript is still shown instead of the screen
      // going blank. Returns the same journal shape `resume` does, minus the
      // writer — the fallback never opens one.
      load: loadStore,
    },
    sessionRef: undefined as { current: ReturnType<typeof writer> | undefined } | undefined,
    activateSessionIdentity,
    detachActiveTodosCheckpoint: priorDetachFn,
    pendingProjectSwitch: null,
    autonomousCoordinator: null,
    coordinatorRun: null,
    coordinatorEvents: new Set(),
  };

  return {
    ctx: {
      state,
      agent: { ctx: context },
      tokenCounter,
      switchProviderAndModel: vi.fn(async () => undefined),
      onLoadProgress,
    },
    state,
    context,
    priorDetachFn,
    oldWriter,
    resumedWriter,
    oldMessages,
    resumedMessages,
    resumedEvents,
    usage,
    resumeStore,
    loadStore,
    activateSessionIdentity,
    onLoadProgress,
    tokenCounter,
  };
}

beforeEach(() => {
  mocks.registryList.mockReset().mockResolvedValue([]);
  mocks.loadTodosCheckpoint.mockReset().mockResolvedValue([]);
  mocks.attachTodosCheckpoint.mockReset().mockReturnValue(vi.fn());
  mocks.replaySessionMessages.mockReset().mockReturnValue([{ id: 1, kind: 'user' }]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('TUI session resume ownership', () => {
  it('shows the transcript read-only when the ownership claim fails', async () => {
    // "Someone else owns this session" is a reason to refuse the WRITER, not a
    // reason to refuse to display the conversation. The journal is read
    // through `load()` (no writer, nothing to corrupt) and returned with
    // `attached: false` so the surface can say so plainly. Before this, every
    // such resume blanked to "Failed to resume session <id>".
    const h = harness();
    h.activateSessionIdentity.mockRejectedValue(new Error('already open in pid 4242'));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).not.toBeNull();
    expect(result?.attached).toBe(false);
    expect(result?.entries).toEqual([{ id: 1, kind: 'user' }]);
    expect(result?.warnings.join(' ')).toContain('already open in pid 4242');
    // The chip reports the LIVE window, and the live session is the one we
    // stayed on — a read-only view must not paint over it.
    expect(result?.contextSnapshot).toBeUndefined();
    expect(h.resumeStore).not.toHaveBeenCalled();
    expect(h.context.session).toBe(h.oldWriter);
  });

  it('refuses outright when another process holds the session, with no read-only fallback', async () => {
    // A live session is the one case where the read-only hand-back is the
    // WRONG answer: it blanks the user's screen and replaces it with a
    // snapshot of a conversation that is still moving in the other process,
    // which reads as a resume that has silently stopped updating.
    //
    // The picker already refuses these up front from `entry.live`; this is the
    // race where a session goes live between the listing and Enter.
    const h = harness();
    const conflict = new Error('Session is already open in another running wstack (pid 4242).');
    conflict.name = 'SessionOwnershipConflictError';
    h.activateSessionIdentity.mockRejectedValue(conflict);

    const failures: unknown[] = [];
    const result = await resumeSession(
      { ...h.ctx, onFailure: (f: unknown) => failures.push(f) } as never,
      h.resumedWriter.id,
    );

    expect(result).toBeNull();
    // The expensive half never runs: no journal read for a session we are not
    // going to show.
    expect(h.loadStore).not.toHaveBeenCalled();
    expect(h.resumeStore).not.toHaveBeenCalled();
    // The agent stays exactly where it was.
    expect(h.context.session).toBe(h.oldWriter);
    expect(h.context.messages).toBe(h.oldMessages);
    // And the caller gets the reason, not a bare "failed".
    expect(JSON.stringify(failures)).toContain('4242');
  });

  it('still hands back a read-only transcript for an ordinary claim failure', async () => {
    // The refusal above keys on the ownership-conflict error NAME (which the
    // catalog daemon preserves across IPC), not on "the claim failed" — a
    // corrupt registry or a permissions error must keep the read-only path.
    const h = harness();
    h.activateSessionIdentity.mockRejectedValue(new Error('registry file is unreadable'));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.attached).toBe(false);
    expect(result?.entries).toEqual([{ id: 1, kind: 'user' }]);
  });

  it('repoints the host sessionRef to the resumed writer on success', async () => {
    // Regression for the CLI chimera HIGH finding: before the fix, the
    // forward-declared `sessionRef.current` was only assigned once at
    // boot (cli-main.ts:317). An in-process `/resume` swapped the
    // agent's active writer, but provider-side
    // `getSessionId: () => sessionRef.current?.id` callbacks and the
    // record-mode `bindReplayToContainer` binding kept referring to the
    // boot session — so every prompt after `/resume` wrote to the
    // wrong JSONL. The fix repoints `state.sessionRef.current` after
    // the writer swap commits.
    const h = harness();
    h.state.sessionRef = { current: h.oldWriter };

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).not.toBeNull();
    expect(h.state.sessionRef.current).toBe(h.resumedWriter);
  });

  it('skips sessionRef repointing when the host did not provide one', async () => {
    // Hosts/older tests that predate the resume-refactor can omit
    // `state.sessionRef`; the resume handler must then silently skip
    // the repoint instead of crashing. Pre-fix behavior (provider
    // calls stay pinned to the boot session) is preserved.
    const h = harness();
    h.state.sessionRef = undefined;

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.not.toBeNull();
  });

  it('restores the old sessionRef when hydration fails after the writer swap', async () => {
    // The repoint must happen only after the writer swap is durable
    // (i.e. after replaceMessages succeeds). If hydration throws and
    // the old writer is rolled back, the sessionRef must point back
    // at the old writer so the next provider call doesn't transiently
    // append to a writer we just rolled away from.
    const h = harness();
    h.state.sessionRef = { current: h.oldWriter };
    h.context.state.replaceMessages
      .mockImplementationOnce(() => {
        throw new Error('invalid recovered messages');
      })
      .mockImplementationOnce((messages: typeof h.oldMessages) => {
        h.context.messages = messages;
      });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.attached).toBe(false);
    expect(h.state.sessionRef.current).toBe(h.oldWriter);
  });

  it('rolls ownership back when opening the selected writer fails', async () => {
    const h = harness();
    h.resumeStore.mockRejectedValue(new Error('invalid session journal'));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    // Ownership rolled all the way back; the transcript still rendered from
    // the read-only `load()` because opening for APPEND is what failed.
    expect(result?.attached).toBe(false);
    expect(h.loadStore).toHaveBeenCalledOnce();
    expect(h.activateSessionIdentity.mock.calls.map(([id]) => id)).toEqual([
      h.resumedWriter.id,
      h.oldWriter.id,
    ]);
    expect(h.context.session).toBe(h.oldWriter);
  });

  it('restores the old writer and closes the opened writer when hydration fails', async () => {
    const h = harness();
    h.context.state.replaceMessages
      .mockImplementationOnce(() => {
        throw new Error('invalid recovered messages');
      })
      .mockImplementationOnce((messages: typeof h.oldMessages) => {
        h.context.messages = messages;
      });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.attached).toBe(false);
    expect(h.context.session).toBe(h.oldWriter);
    expect(h.context.messages).toEqual(h.oldMessages);
    expect(h.resumedWriter.close).toHaveBeenCalledOnce();
    expect(h.activateSessionIdentity).toHaveBeenLastCalledWith(h.oldWriter.id);
    // The journal was already in hand from the failed `resume()`; re-reading a
    // 100 MB file to render what we just parsed would be the expensive way to
    // reach the same screen.
    expect(h.loadStore).not.toHaveBeenCalled();
  });

  it('keeps the resume when the journal snapshot cannot flush, and says so', async () => {
    // This used to fail closed: a flush error rolled the whole resume back and
    // the user got a blank screen. The flush matters for the NEXT turn's
    // durability, and the writer is already swapped by the time it runs — so
    // the honest outcome is an attached session plus a warning, not the loss
    // of a transcript that loaded fine.
    const h = harness();
    h.state.sessionRef = { current: h.oldWriter };
    h.context.flushConversationJournal.mockRejectedValue(new Error('journal unavailable'));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.attached).toBe(true);
    expect(result?.warnings.join(' ')).toContain('journal unavailable');
    expect(h.context.session).toBe(h.resumedWriter);
    expect(h.state.sessionRef.current).toBe(h.resumedWriter);
    expect(h.resumedWriter.close).not.toHaveBeenCalled();
    // The steps AFTER the flush still ran — that is the point of not aborting.
    expect(h.tokenCounter.reset).toHaveBeenCalled();
    expect(mocks.attachTodosCheckpoint).toHaveBeenCalledOnce();
  });

  it('keeps the resume when token accounting throws, and says so', async () => {
    // Cost chips are cosmetic. A malformed `usage` block on an old journal
    // used to throw here — after the writer swap — and unwind a working resume.
    const h = harness();
    h.tokenCounter.account.mockImplementationOnce(() => {
      throw new Error('malformed usage');
    });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.attached).toBe(true);
    expect(result?.warnings.join(' ')).toContain('malformed usage');
    expect(h.context.session).toBe(h.resumedWriter);
  });

  it('keeps the resume when the todo sidecars cannot be re-pointed', async () => {
    const h = harness();
    h.context.state.setMeta.mockImplementationOnce(() => {
      throw new Error('meta store is read-only');
    });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.attached).toBe(true);
    expect(result?.warnings.join(' ')).toContain('meta store is read-only');
    expect(h.context.session).toBe(h.resumedWriter);
    // The PREVIOUS session's todo write handle is put back, so its edits keep
    // persisting instead of vanishing into a detached checkpoint.
    expect(h.state.detachActiveTodosCheckpoint).toBe(h.priorDetachFn);
  });

  it('rolls back the writer + messages + identity when a post-swap step throws', async () => {
    // Regression guard for the latent invariant-break between the writer
    // swap and the return: any unguarded throw in that window would
    // leave `agent.ctx` bound to the resumed session while the caller
    // received `null`, silently corrupting the next user prompt.
    //
    // The throw is injected where the OLD session's closing usage is read
    // (`tokenCounter.total()`), which runs AFTER the todos sidecar has been
    // detached, re-pointed, and re-attached to the resumed session. That
    // ordering is load-bearing: firing the throw before the re-attach would
    // make the detach-restore assertion below pass vacuously — the field
    // would still hold the original handle whether or not the rollback
    // restored it. It is also deliberately NOT one of the best-effort steps
    // (flush / sidecars / model / token accounting), which now warn instead
    // of aborting — this test exists to pin the rollback arm itself.
    //
    // Note: line citations against `tui-session-resume.ts` are deliberately
    // omitted. The source is actively churning; code-anchored
    // descriptions stay correct under source drift.
    const h = harness();
    h.tokenCounter.total.mockImplementationOnce(() => {
      throw new Error('post-swap failure');
    });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    // Caller observes a NON-attached resume: the writer is rolled back, but
    // the transcript that already parsed is still handed back for display.
    expect(result?.attached).toBe(false);
    expect(result?.warnings.join(' ')).toContain('post-swap failure');

    // Writer + messages restored to the pre-swap values.
    expect(h.context.session).toBe(h.oldWriter);
    expect(h.context.messages).toEqual(h.oldMessages);
    expect(h.oldWriter.close).not.toHaveBeenCalled();
    expect(h.resumedWriter.close).toHaveBeenCalledOnce();

    // Identity rolled back to the previous session: claim first
    // (resume path), then rollback (post-swap arm of the outer catch).
    expect(h.activateSessionIdentity.mock.calls.map(([id]) => id)).toEqual([
      h.resumedWriter.id,
      h.oldWriter.id,
    ]);
    // Hydration put the resumed messages in place; the rollback undid
    // it. Call-count, not reference identity — the source spreads the
    // original messages into a fresh array before the rollback.
    expect(h.context.state.replaceMessages).toHaveBeenCalledTimes(2);
    // Todos sidecar: `replaceTodos(restoredTodos)` applied, then the
    // original list restored — even when the original is empty. The
    // rollback must not skip an empty list, or a late throw (like this
    // one) would leave the resumed session's board visible.
    expect(h.context.state.replaceTodos).toHaveBeenCalledTimes(2);

    // The sidecar rollback: the re-attach replaced
    // `state.detachActiveTodosCheckpoint` with the resumed session's
    // handle, so the rollback restoring the original handle is now a
    // load-bearing assertion — without it, every todo edit after a
    // failed resume would persist to the wrong (or no) file.
    expect(h.state.detachActiveTodosCheckpoint).toBe(h.priorDetachFn);
  });
});

/**
 * Snapshot-contract tests. The TUI reducer at
 * `packages/tui/src/reducers/composer.ts:561-577` reads
 * `action.contextSnapshot.tokens` as a flat `number` and gates on
 * `snap.tokens > 0`. The host sources that number from the journal:
 * `projectLastRequestTokens` scans for the LAST `llm_response` and flattens
 * its `{ input, cacheRead, cacheWrite }` usage into one number, because the
 * token counter only holds the session's CUMULATIVE usage at resume time.
 * If the host ever forwards a raw usage object (NaN coercion), the
 * cumulative figure, or a counter reading instead of the journal
 * measurement, these tests fail so the statusline chip and `/context`
 * panel keep refreshing after `/resume`.
 */
describe('TUI session resume — contextSnapshot contract', () => {
  it('flattens the last journal llm_response usage into contextSnapshot.tokens', async () => {
    const h = harness();
    // Deliberately distinct from the tokenCounter mock's {7,3,2}=12 and from
    // the cumulative data.usage (10+2+1=13): if the host regressed to
    // counter-summing or cumulative accounting, the snapshot would read 12 or
    // 13 instead of 65 and this test would catch the wrong SOURCE, not just a
    // wrong sum.
    h.resumedEvents.push({
      type: 'llm_response',
      ts: '2026-08-29T10:00:00.000Z',
      usage: { input: 40, cacheRead: 20, cacheWrite: 5 },
    });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).not.toBeNull();
    const snap = result!.contextSnapshot;
    expect(snap).toBeDefined();
    expect(typeof snap?.tokens).toBe('number');
    expect(Number.isFinite(snap!.tokens)).toBe(true);
    expect(snap!.tokens).toBeGreaterThan(0);
    // Flat sum of the LAST llm_response usage: input(40) + cacheRead(20) +
    // cacheWrite(5) = 65.
    expect(snap!.tokens).toBe(65);
    // The same journal measurement seeds the agent's per-request estimate.
    expect(h.context.lastRequestTokens).toBe(65);
    // The progress sink threads through verbatim to the store's JSONL loader.
    expect(h.resumeStore).toHaveBeenCalledWith('2026-07-26/sess_resumed', h.onLoadProgress);
    // The counter is no longer a token source on this path.
    expect(h.tokenCounter.currentRequestTokens).not.toHaveBeenCalled();
  });

  it('returns contextSnapshot.maxContext from agent.ctx.provider.capabilities.maxContext', async () => {
    const h = harness();
    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).not.toBeNull();
    const snap = result!.contextSnapshot;
    expect(snap).toBeDefined();
    expect(typeof snap?.maxContext).toBe('number');
    expect(snap!.maxContext).toBe(200_000);
  });

  it('reports tokens=0 for a session whose journal never reached the model (no NaN)', async () => {
    // The harness fixture ships `events: []` — no llm_response anywhere, the
    // on-disk equivalent of a session that never reached the model.
    // projectLastRequestTokens returns undefined for it and the snapshot must
    // publish a flat 0 (never NaN, never the cumulative data.usage figure).
    // The previous version modeled "no request yet" by zeroing
    // tokenCounter.currentRequestTokens, but the resume path no longer reads
    // the counter for this estimate.
    const h = harness();

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).not.toBeNull();
    const snap = result!.contextSnapshot;
    expect(snap).toBeDefined();
    expect(snap!.tokens).toBe(0);
    expect(Number.isFinite(snap!.tokens)).toBe(true);
    expect(snap!.maxContext).toBe(200_000);
    // An undefined journal measurement must not seed the agent estimate.
    expect(h.context.lastRequestTokens).toBeUndefined();
  });
});

describe('TUI session resume — next steps and context numbers', () => {
  it('returns the FINAL assistant turn so next steps come from the end of the session', async () => {
    const h = harness();
    h.resumedMessages.length = 0;
    h.resumedMessages.push(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '<nextsteps><step>early one</step></nextsteps>' },
      { role: 'user', content: 'more' },
      // Text blocks, not a bare string: the shape a modern provider writes.
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done\n<nextsteps><step>the real one</step></nextsteps>' }],
      },
    );

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    // Not "whichever assistant message the renderer mounted last" — the last
    // one in the transcript.
    expect(result?.lastAssistantText).toContain('the real one');
    expect(result?.lastAssistantText).not.toContain('early one');
  });

  it('skips trailing assistant turns that carry no text', async () => {
    const h = harness();
    h.resumedMessages.length = 0;
    h.resumedMessages.push(
      { role: 'assistant', content: 'the last thing actually said' },
      // A tool-calling turn with no prose is extremely common as the final
      // message; it must not mask the last real answer.
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
    );

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.lastAssistantText).toBe('the last thing actually said');
  });

  it('omits the field entirely for a session with no assistant turn', async () => {
    const h = harness();
    h.resumedMessages.length = 0;
    h.resumedMessages.push({ role: 'user', content: 'never answered' });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.lastAssistantText).toBeUndefined();
  });

  it('overwrites the per-request snapshot with a per-request number', async () => {
    const h = harness();
    // The journal's last request: this is a context FILL. `usage` on the
    // session (10+5+2+1) is lifetime SPEND and must not be mistaken for it.
    h.resumedEvents.push({
      type: 'llm_response',
      ts: '2026-08-29T10:00:00.000Z',
      usage: { input: 900, output: 40, cacheRead: 90, cacheWrite: 10 },
    });

    await resumeSession(h.ctx as never, h.resumedWriter.id);

    // Cumulative still feeds the cost chips…
    expect(h.tokenCounter.account).toHaveBeenCalledWith(
      h.usage,
      expect.anything(),
      expect.anything(),
    );
    // …but the fill snapshot is the per-request prompt size.
    expect(h.tokenCounter.setCurrentRequestTokens).toHaveBeenCalledWith(1000);
    expect(h.context.lastRequestTokens).toBe(1000);
  });

  it('clears a stale measurement when the resumed session never reached the model', async () => {
    const h = harness();
    h.context.lastRequestTokens = 380_000; // left over from the session being left

    await resumeSession(h.ctx as never, h.resumedWriter.id);

    // No journal measurement exists, so every fill surface must fall through to
    // its own estimate rather than keep quoting a conversation that is gone.
    expect(h.context.lastRequestTokens).toBeUndefined();
    expect(h.tokenCounter.setCurrentRequestTokens).toHaveBeenCalledWith(0);
  });
});

describe('TUI session resume failure reporting', () => {
  it('names the stage and the reason when a post-swap step throws', async () => {
    const h = harness();
    const failures: Array<{ stage: string; message: string }> = [];
    h.tokenCounter.total.mockImplementation(() => {
      throw new Error('post-swap failure');
    });

    const result = await resumeSession(
      { ...h.ctx, onFailure: (info: SessionResumeFailure) => failures.push(info) } as never,
      h.resumedWriter.id,
    );

    // The reason must escape even now that the transcript survives, or the
    // user only ever sees a bare "Failed to resume session".
    expect(result?.attached).toBe(false);
    expect(failures).toEqual([
      { stage: 'finalize_previous_session', message: 'post-swap failure' },
    ]);
  });

  it('reports the id-resolution failure rather than an anonymous null', async () => {
    const h = harness();
    const failures: Array<{ stage: string; message: string }> = [];
    h.state.activeSessionStore.resolveId.mockRejectedValue(new Error('Session not found: nope'));

    const result = await resumeSession(
      { ...h.ctx, onFailure: (info: SessionResumeFailure) => failures.push(info) } as never,
      'nope',
    );

    expect(result).toBeNull();
    expect(failures).toEqual([{ stage: 'resolve_id', message: 'Session not found: nope' }]);
  });

  it('reports a missing session store instead of failing silently', async () => {
    const h = harness();
    const failures: Array<{ stage: string; message: string }> = [];
    (h.state as { activeSessionStore: unknown }).activeSessionStore = undefined;

    const result = await resumeSession(
      { ...h.ctx, onFailure: (info: SessionResumeFailure) => failures.push(info) } as never,
      h.resumedWriter.id,
    );

    expect(result).toBeNull();
    expect(failures[0]?.stage).toBe('no_session_store');
  });

  it('survives a throwing failure sink — reporting must never break the rollback', async () => {
    const h = harness();
    h.tokenCounter.total.mockImplementation(() => {
      throw new Error('post-swap failure');
    });

    const result = await resumeSession(
      {
        ...h.ctx,
        onFailure: () => {
          throw new Error('sink exploded');
        },
      } as never,
      h.resumedWriter.id,
    );

    // The sink threw on BOTH call sites (the rollback report and the
    // read-only hand-back); neither may turn into the caller's error.
    expect(result?.attached).toBe(false);
    // The rollback still ran: the agent speaks for the session it was in.
    expect(h.context.session).toBe(h.oldWriter);
  });
});

/**
 * The reservation covers the SLOW half of a resume.
 *
 * `reserveResume` is taken before the transcript is opened, and the daemon's
 * default window is 15s. Hydration — journal parse, summary rebuild,
 * file-observation hashing, opening the append handle, and catalog-daemon
 * round-trips — routinely outruns that on real journals (2.7s for 131 MB on a
 * warm cache, far more cold). `activate_reservation` then failed with
 * "reservation expired" AFTER all the expensive work succeeded, and the caller
 * rolled back to a blank screen. These pin the two halves of the fix: ask for
 * the widest window up front, and keep renewing it while the work runs.
 */
describe('TUI session resume — reservation lifetime', () => {
  function registryHarness() {
    const h = harness();
    // Production WstackPaths always carries both, which is what selects the
    // reservation branch over the legacy activateSessionIdentity branch.
    Object.assign(h.state.wpaths, {
      projectSlug: 'proj-abc123',
      globalRoot: '/global',
    });
    const renew = vi.fn(async () => true);
    const activate = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    mocks.reserveResume.mockReset().mockResolvedValue({
      reservation: { reservationId: 'r1', targetSessionId: h.resumedWriter.id },
      renew,
      activate,
      cancel,
    });
    return { ...h, renew, activate, cancel };
  }

  it('asks for the widest reservation window the daemon allows', async () => {
    const h = registryHarness();

    await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(mocks.reserveResume).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: h.resumedWriter.id,
        projectSlug: 'proj-abc123',
        // 60_000 is MAX_RESERVATION_MS; the daemon clamps anything larger.
        reservationMs: 60_000,
      }),
    );
  });

  it('renews the reservation across a slow hydration and again before activating', async () => {
    const h = registryHarness();
    // A hydration long enough to outlive the default 15s window: the renewal
    // interval must fire during it, not merely before or after.
    h.resumeStore.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
      return {
        writer: h.resumedWriter,
        data: {
          metadata: { id: h.resumedWriter.id, provider: 'p', model: 'm' },
          messages: h.resumedMessages,
          events: h.resumedEvents,
          usage: h.usage,
        },
      };
    });

    vi.useFakeTimers();
    try {
      const result = await resumeSession(h.ctx as never, h.resumedWriter.id);
      expect(result?.attached).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // At least twice during the 45s load (20s interval) plus the pre-activate
    // renewal — the window has to cover the activate round-trip too.
    expect(h.renew.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.activate).toHaveBeenCalledOnce();
  });

  it('does not fail the resume when the daemon cannot renew', async () => {
    // A catalog daemon started before `renew_reservation` existed rejects the
    // op. That must degrade to the old behaviour — activate decides — never
    // turn a resume that would have worked into a failure.
    const h = registryHarness();
    h.renew.mockRejectedValue(new Error('Unknown Session Catalog operation: renew_reservation'));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result?.attached).toBe(true);
    expect(h.activate).toHaveBeenCalledOnce();
  });
});
