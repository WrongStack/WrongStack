import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  buildExitCommand,
  buildLoadCommand,
  buildSaveCommand,
  isSafeSessionKillPid,
} from '../src/slash-commands/session.js';

function fakeCtx(): Context {
  return {
    session: {
      id: 'sess-1',
      append: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    },
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    model: 'test',
    cwd: '/tmp',
    projectRoot: '/tmp',
    meta: {},
    state: {
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn(),
      deleteMeta: vi.fn(),
    },
  } as never as Context;
}

// ── /save ────────────────────────────────────────────────────────────────────

describe('buildSaveCommand', () => {
  it('flushes buffered events without writing a mid-stream session_end', async () => {
    const ctx = fakeCtx();
    const cmd = buildSaveCommand({
      tokenCounter: { total: () => ({ input: 100, output: 50 }) },
    } as never);
    const res = await cmd.run('', ctx);
    expect(res?.message).toContain('sess-1 flushed');
    expect(ctx.session.flush).toHaveBeenCalled();
    // A running session must never get a session_end marker from /save —
    // it corrupts outcome/endedAt derivation for recovery and summaries.
    expect(ctx.session.append).not.toHaveBeenCalled();
  });
});

// ── /sessions (resume/load) ──────────────────────────────────────────────────

describe('buildLoadCommand', () => {
  it('exposes name "sessions" with backward-compat aliases', () => {
    const cmd = buildLoadCommand({} as never);
    expect(cmd.name).toBe('sessions');
    expect(cmd.aliases).toEqual(expect.arrayContaining(['resume', 'load']));
  });

  it('returns "no session store" when undefined', async () => {
    const cmd = buildLoadCommand({} as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.message).toContain('No session store');
  });

  it('returns "no saved sessions" when list is empty', async () => {
    const cmd = buildLoadCommand({
      sessionStore: { list: vi.fn().mockResolvedValue([]) },
    } as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.message).toContain('No saved sessions');
  });

  it('renders a list and also writes to renderer', async () => {
    const write = vi.fn();
    const cmd = buildLoadCommand({
      sessionStore: {
        list: vi.fn().mockResolvedValue([
          { id: 'a', startedAt: '2026-01-01', tokenTotal: 5000, title: 'first task' },
          { id: 'b', startedAt: '2026-02-01', tokenTotal: 12000, title: 'second task' },
        ]),
      },
      renderer: { write },
    } as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.message).toContain('Recent sessions');
    expect(res?.message).toContain('first task');
    expect(res?.message).toContain('second task');
    expect(res?.message).toContain('/resume to open interactive picker, or wstack resume a');
    expect(write).toHaveBeenCalled();
  });
});

describe('isSafeSessionKillPid', () => {
  it('rejects host-sensitive PIDs', () => {
    expect(isSafeSessionKillPid(0)).toBe(false);
    expect(isSafeSessionKillPid(1)).toBe(false);
    expect(isSafeSessionKillPid(-1)).toBe(false);
    expect(isSafeSessionKillPid(process.pid)).toBe(false);
    expect(isSafeSessionKillPid(process.ppid)).toBe(false);
  });

  it('allows ordinary positive integer PIDs', () => {
    const pid = Math.max(process.pid, process.ppid, 10_000) + 1;
    expect(isSafeSessionKillPid(pid)).toBe(true);
  });
});

// ── /resume --incomplete (recovery) ──────────────────────────────────────────

describe('buildLoadCommand --incomplete', () => {
  // Minimal fake — we need `paths` to construct a SessionRecovery,
  // and SessionRecovery.listResumable scans the dir. We point the
  // dir at a real tempdir; the helper below creates a stale log
  // and asserts the command surfaces it.
  it('lists incomplete sessions and says how each of them ended', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'resume-incomplete-'));
    try {
      // Stale session — last event is in_flight_start with no end.
      const log = [
        JSON.stringify({
          type: 'session_start',
          ts: '2026-01-01T00:00:00Z',
          id: 's-crash',
          model: 'm',
          provider: 'p',
        }),
        JSON.stringify({
          type: 'in_flight_start',
          ts: '2026-01-01T00:00:01Z',
          context: 'iteration 7 / tool: read',
        }),
        '',
      ].join('\n');
      await writeFile(join(dir, 's-crash.jsonl'), log, 'utf8');

      const cmd = buildLoadCommand({ paths: { projectSessions: dir } } as never);
      const res = await cmd.run('--incomplete', fakeCtx());
      expect(res?.message).toContain('1 incomplete session');
      expect(res?.message).toContain('s-crash');
      expect(res?.message).toContain('died mid-iteration');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a "no incomplete sessions" message only when a log actually ended', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'resume-clean-'));
    try {
      // A clean shutdown is a TRAILING session_end, and nothing weaker.
      // `in_flight_end` only says the last turn finished — a host killed at
      // the prompt leaves exactly that and never closes the log, which is the
      // most common crash there is. Calling that clean is what made recovery
      // report an empty list for a project full of hung sessions.
      const log = [
        JSON.stringify({ type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'x' }),
        JSON.stringify({ type: 'in_flight_end', ts: '2026-01-01T00:00:01Z', reason: 'clean' }),
        JSON.stringify({ type: 'session_end', ts: '2026-01-01T00:00:02Z' }),
        '',
      ].join('\n');
      await writeFile(join(dir, 's-clean.jsonl'), log, 'utf8');
      const cmd = buildLoadCommand({ paths: { projectSessions: dir } } as never);
      const res = await cmd.run('--incomplete', fakeCtx());
      expect(res?.message).toMatch(/no incomplete/i);

      // Drop the terminal marker and the very same log is a hung session.
      await writeFile(
        join(dir, 's-clean.jsonl'),
        log
          .split('\n')
          .filter((line) => !line.includes('session_end'))
          .join('\n'),
        'utf8',
      );
      const hung = await cmd.run('--incomplete', fakeCtx());
      expect(hung?.message).toContain('s-clean');
      expect(hung?.message).toContain('died between turns');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('warns when no paths are configured', async () => {
    const cmd = buildLoadCommand({} as never);
    const res = await cmd.run('--incomplete', fakeCtx());
    expect(res?.message).toMatch(/no paths configured/i);
  });
});

// ── /resume --recover <sessionId> ───────────────────────────────────────────

describe('buildLoadCommand --recover <sessionId>', () => {
  it('returns a recovery plan for a stale session', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'resume-recover-'));
    try {
      const log = [
        JSON.stringify({
          type: 'session_start',
          ts: '2026-01-01T00:00:00Z',
          id: 's-recover',
          model: 'm',
          provider: 'p',
        }),
        JSON.stringify({
          type: 'checkpoint',
          ts: '2026-01-01T00:00:01Z',
          promptIndex: 0,
          promptPreview: 'before the crash',
        }),
        JSON.stringify({
          type: 'in_flight_start',
          ts: '2026-01-01T00:00:02Z',
          context: 'iteration 7 / tool: bash',
        }),
        '',
      ].join('\n');
      await writeFile(join(dir, 's-recover.jsonl'), log, 'utf8');
      const cmd = buildLoadCommand({ paths: { projectSessions: dir } } as never);
      const res = await cmd.run('--recover s-recover', fakeCtx());
      expect(res?.message).toContain('Recovery plan for s-recover');
      expect(res?.message).toContain('Stale: yes');
      expect(res?.message).toContain('iteration 7 / tool: bash');
      expect(res?.message).toContain('before the crash');
      expect(res?.message).toContain('Pending events: 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a "not found" message for a missing session', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'resume-recover-empty-'));
    try {
      const cmd = buildLoadCommand({ paths: { projectSessions: dir } } as never);
      const res = await cmd.run('--recover no-such', fakeCtx());
      expect(res?.message).toMatch(/no session log found/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks plan as not-stale for a clean session', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'resume-recover-clean-'));
    try {
      const log = [
        JSON.stringify({
          type: 'session_start',
          ts: '2026-01-01T00:00:00Z',
          id: 's-clean',
          model: 'm',
          provider: 'p',
        }),
        JSON.stringify({ type: 'in_flight_end', ts: '2026-01-01T00:00:01Z', reason: 'clean' }),
        '',
      ].join('\n');
      await writeFile(join(dir, 's-clean.jsonl'), log, 'utf8');
      const cmd = buildLoadCommand({ paths: { projectSessions: dir } } as never);
      const res = await cmd.run('--recover s-clean', fakeCtx());
      expect(res?.message).toContain('Stale: no');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── /exit ────────────────────────────────────────────────────────────────────

describe('buildExitCommand', () => {
  it('returns { exit: true } when no pre-exit handler set', async () => {
    const onExit = vi.fn();
    const cmd = buildExitCommand({ onExit } as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.exit).toBe(true);
    expect(onExit).toHaveBeenCalled();
  });

  it('runs onBeforeExit; aborts when handler signals abort', async () => {
    const onBeforeExit = vi.fn().mockResolvedValue({ abort: true, message: 'uncommitted changes' });
    const onExit = vi.fn();
    const cmd = buildExitCommand({ onBeforeExit, onExit } as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.exit).toBe(true);
    expect(res?.message).toBe('uncommitted changes');
    expect(onExit).toHaveBeenCalled();
  });

  it('still exits when onBeforeExit resolves without abort', async () => {
    const onBeforeExit = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();
    const cmd = buildExitCommand({ onBeforeExit, onExit } as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.exit).toBe(true);
    expect(onExit).toHaveBeenCalled();
  });

  it('awaits asynchronous onExit cleanup before returning exit', async () => {
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const onExit = vi.fn(() => cleanupGate);
    const cmd = buildExitCommand({ onExit } as never);
    let settled = false;
    const pending = cmd.run('', fakeCtx()).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseCleanup();
    await expect(pending).resolves.toEqual({ exit: true });
  });

  it('returns exit even when no onExit registered', async () => {
    const cmd = buildExitCommand({} as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.exit).toBe(true);
  });
});

// ── /sessions rename ───────────────────────────────────────────────────────

describe('/sessions rename', () => {
  it('errors without a session id', async () => {
    const cmd = buildLoadCommand({} as never);
    const res = await cmd.run('rename', fakeCtx());
    expect(res?.message).toMatch(/Usage:.*rename/);
  });

  it('errors when no session store is configured', async () => {
    const cmd = buildLoadCommand({} as never);
    const res = await cmd.run('rename 2026-07-04/sess_x my name', fakeCtx());
    expect(res?.message).toMatch(/No session store/);
  });

  it('calls sessionStore.rename with the joined name and reports success', async () => {
    const rename = vi.fn().mockResolvedValue({ id: 'x', title: 'auto', name: 'DB refactor' });
    const cmd = buildLoadCommand({
      sessionStore: { rename },
    } as never);
    const res = await cmd.run('rename 2026-07-04/sess_x DB refactor', fakeCtx());
    expect(rename).toHaveBeenCalledWith('2026-07-04/sess_x', 'DB refactor');
    expect(res?.message).toContain('DB refactor');
  });

  it('clears the name when the name argument is empty', async () => {
    const rename = vi.fn().mockResolvedValue({ id: 'x', title: 'auto' });
    const cmd = buildLoadCommand({
      sessionStore: { rename },
    } as never);
    await cmd.run('rename 2026-07-04/sess_x', fakeCtx());
    expect(rename).toHaveBeenCalledWith('2026-07-04/sess_x', '');
  });

  it('surfaces a rename failure as an error message', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('Session not found: x'));
    const cmd = buildLoadCommand({
      sessionStore: { rename },
    } as never);
    const res = await cmd.run('rename 2026-07-04/ghost nope', fakeCtx());
    expect(res?.message).toMatch(/Rename failed.*Session not found/);
  });
});

// ── /sessions delete ───────────────────────────────────────────────────────

describe('/sessions delete', () => {
  it('errors without a session id', async () => {
    const cmd = buildLoadCommand({} as never);
    const res = await cmd.run('delete', fakeCtx());
    expect(res?.message).toMatch(/Usage:.*delete/);
  });

  it('refuses to delete the active session', async () => {
    const ctx = fakeCtx(); // session.id === 'sess-1'
    const del = vi.fn().mockResolvedValue(undefined);
    const cmd = buildLoadCommand({
      sessionStore: { delete: del },
      context: ctx,
    } as never);
    const res = await cmd.run('delete sess-1', ctx);
    expect(res?.message).toMatch(/Cannot delete the active session/);
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes a non-active session with --force (no confirm prompt)', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn();
    const cmd = buildLoadCommand({
      sessionStore: { delete: del },
      confirm,
    } as never);
    const res = await cmd.run('delete 2026-07-04/old --force', fakeCtx());
    expect(del).toHaveBeenCalledWith('2026-07-04/old');
    expect(confirm).not.toHaveBeenCalled();
    expect(res?.message).toContain('Deleted session');
  });

  it('prompts for confirmation without --force', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = buildLoadCommand({
      sessionStore: { delete: del },
      confirm,
    } as never);
    await cmd.run('delete 2026-07-04/old', fakeCtx());
    expect(confirm).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('2026-07-04/old');
  });

  it('cancels when confirmation is declined', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(false);
    const cmd = buildLoadCommand({
      sessionStore: { delete: del },
      confirm,
    } as never);
    const res = await cmd.run('delete 2026-07-04/old', fakeCtx());
    expect(del).not.toHaveBeenCalled();
    expect(res?.message).toMatch(/cancelled/);
  });
});
