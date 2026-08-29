import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registryList: vi.fn(),
  loadTodosCheckpoint: vi.fn(),
  attachTodosCheckpoint: vi.fn(),
  replaySessionMessages: vi.fn(),
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
  };
});

vi.mock('@wrongstack/tui', () => ({
  replaySessionMessages: mocks.replaySessionMessages,
}));

import { resumeSession } from '../src/boot/tui-session-resume.js';

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
  const resumedMessages = [{ role: 'user', content: 'resumed' }];
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
  const context = {
    session: oldWriter,
    messages: oldMessages,
    model: 'old-model',
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
      events: [],
      usage,
    },
  }));
  const activateSessionIdentity = vi.fn(async (_sessionId: string) => undefined);
  // Snapshot of the pre-resume todos-detach handle. The rollback test
  // asserts the outer catch restores `state.detachActiveTodosCheckpoint`
  // to THIS exact reference — without exposing it, the assertion compares
  // against `undefined` and the field's shared-mock identity is invisible.
  const priorDetachFn = vi.fn(async () => undefined);
  const tokenCounter = {
    total: vi.fn(() => ({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 })),
    reset: vi.fn(),
    account: vi.fn(),
    // `currentRequestTokens()` returns the prompt-cache-aware per-request
    // shape `{ input, cacheRead, cacheWrite }`. The host sums these into a
    // flat `tokens` field for the TUI snapshot — see the snapshot contract
    // tests at the bottom of this file. Tests that want to exercise the
    // "no request yet" path can override this via `h.tokenCounter.currentRequestTokens`.
    currentRequestTokens: vi.fn(() => ({ input: 7, cacheRead: 3, cacheWrite: 2 })),
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
    },
    state,
    context,
    priorDetachFn,
    oldWriter,
    resumedWriter,
    oldMessages,
    resumedMessages,
    usage,
    resumeStore,
    activateSessionIdentity,
    tokenCounter,
  };
}

beforeEach(() => {
  mocks.registryList.mockReset().mockResolvedValue([]);
  mocks.loadTodosCheckpoint.mockReset().mockResolvedValue([]);
  mocks.attachTodosCheckpoint.mockReset().mockReturnValue(vi.fn());
  mocks.replaySessionMessages.mockReset().mockReturnValue([{ id: 1, kind: 'user' }]);
});

describe('TUI session resume ownership', () => {
  it('does not open the writer when the ownership claim fails', async () => {
    const h = harness();
    h.activateSessionIdentity.mockRejectedValue(new Error('already open in pid 4242'));

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.toBeNull();

    expect(h.resumeStore).not.toHaveBeenCalled();
    expect(h.context.session).toBe(h.oldWriter);
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

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.toBeNull();

    expect(h.state.sessionRef.current).toBe(h.oldWriter);
  });

  it('rolls ownership back when opening the selected writer fails', async () => {
    const h = harness();
    h.resumeStore.mockRejectedValue(new Error('invalid session journal'));

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.toBeNull();

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

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.toBeNull();

    expect(h.context.session).toBe(h.oldWriter);
    expect(h.context.messages).toEqual(h.oldMessages);
    expect(h.resumedWriter.close).toHaveBeenCalledOnce();
    expect(h.activateSessionIdentity).toHaveBeenLastCalledWith(h.oldWriter.id);
  });

  it('fails closed and rolls back when the resumed journal snapshot cannot flush', async () => {
    const h = harness();
    h.state.sessionRef = { current: h.oldWriter };
    h.context.flushConversationJournal.mockRejectedValue(new Error('journal unavailable'));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).toBeNull();
    expect(h.context.session).toBe(h.oldWriter);
    expect(h.context.messages).toEqual(h.oldMessages);
    expect(h.state.sessionRef.current).toBe(h.oldWriter);
    expect(h.resumedWriter.close).toHaveBeenCalledOnce();
    expect(h.tokenCounter.reset).not.toHaveBeenCalled();
    expect(h.tokenCounter.account).not.toHaveBeenCalled();
    expect(h.context.state.replaceTodos).toHaveBeenCalledOnce();
    expect(h.context.state.replaceTodos).toHaveBeenCalledWith([]);
    expect(mocks.attachTodosCheckpoint).not.toHaveBeenCalled();
    expect(h.activateSessionIdentity.mock.calls.map(([id]) => id)).toEqual([
      h.resumedWriter.id,
      h.oldWriter.id,
    ]);
  });

  it('rolls back the writer + messages + identity when a post-swap step throws', async () => {
    // Regression guard for the latent invariant-break between the writer
    // swap and the return: any unguarded throw in that window would
    // leave `agent.ctx` bound to the resumed session while the caller
    // received `null`, silently corrupting the next user prompt.
    //
    // The throw is injected in the token-accounting section (no inner
    // `.catch`), which runs AFTER the todos sidecar has been detached,
    // re-pointed, and re-attached to the resumed session. That ordering
    // is load-bearing: firing the throw before the re-attach would make
    // the detach-restore assertion below pass vacuously — the field
    // would still hold the original handle whether or not the rollback
    // restored it.
    //
    // Note: line citations against `tui-session-resume.ts` are deliberately
    // omitted. The source is actively churning; code-anchored
    // descriptions stay correct under source drift.
    const h = harness();
    h.tokenCounter.account.mockImplementationOnce(() => {
      throw new Error('post-swap failure');
    });

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    // Caller observes failure.
    expect(result).toBeNull();

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
 * `snap.tokens > 0`. If the host ever forwards the raw
 * `tokenCounter.currentRequestTokens()` object literal instead of the
 * sum of its three fields, the coercion yields NaN, the `> 0` check is
 * silently false, and the statusline chip / `/context` panel never
 * refresh after `/resume`. These tests pin the contract so the bug
 * can't come back.
 */
describe('TUI session resume — contextSnapshot contract', () => {
  it('returns contextSnapshot.tokens as a flat positive number equal to input + cacheRead + cacheWrite', async () => {
    const h = harness();
    // Sanity-check the harness invariant the test relies on.
    expect(typeof h.tokenCounter.currentRequestTokens).toBe('function');

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).not.toBeNull();
    const snap = result!.contextSnapshot;
    expect(snap).toBeDefined();
    expect(typeof snap?.tokens).toBe('number');
    expect(Number.isFinite(snap!.tokens)).toBe(true);
    expect(snap!.tokens).toBeGreaterThan(0);

    // The harness fixture sets input=7, cacheRead=3, cacheWrite=2 so the
    // expected sum is 12. Hardcode it instead of re-reading the mock's
    // `.results[0]` — there's no contract that the harness's beforeEach
    // reset order means the cached `.results` slot is still undefined at
    // the time resumeSession consumes the mock, and the previous version
    // had a typo that read `callResult.input` for cacheRead.
    expect(snap!.tokens).toBe(12);
    expect(h.tokenCounter.currentRequestTokens).toHaveBeenCalledOnce();
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

  it('coerces a zero-input currentRequestTokens to tokens=0 (snapshot drops cleanly, no NaN)', async () => {
    // A counter that has not accounted for any request yet must not
    // produce NaN — the TUI reducer would silently keep the chip at
    // zero forever otherwise. The previous version of this test
    // assigned `currentRequestTokens = undefined` to model a missing
    // implementation, but the `TokenCounter` interface declares the
    // method required; nulling it out violates the contract and the
    // implementation's defensive `?.()` would mask the disagreement.
    // Override the mock to return a zeroed shape instead, which is
    // the legitimate "no request yet" state a real counter reaches.
    const h = harness();
    h.tokenCounter.currentRequestTokens = vi.fn(() => ({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).not.toBeNull();
    const snap = result!.contextSnapshot;
    expect(snap).toBeDefined();
    expect(snap!.tokens).toBe(0);
    expect(Number.isFinite(snap!.tokens)).toBe(true);
    expect(snap!.maxContext).toBe(200_000);
  });
});
