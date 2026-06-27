import { describe, expect, it, vi } from 'vitest';
import {
  buildSaveCommand,
  buildLoadCommand,
  buildExitCommand,
  isSafeSessionKillPid,
} from '../src/slash-commands/session.js';
import type { Context } from '@wrongstack/core';

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
  it('lists incomplete sessions with their crash context', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'resume-incomplete-'));
    try {
      // Stale session — last event is in_flight_start with no end.
      const log = [
        JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's-crash', model: 'm', provider: 'p' }),
        JSON.stringify({ type: 'in_flight_start', ts: '2026-01-01T00:00:01Z', context: 'iteration 7 / tool: read' }),
        '',
      ].join('\n');
      await writeFile(join(dir, 's-crash.jsonl'), log, 'utf8');

      const cmd = buildLoadCommand({ paths: { projectSessions: dir } } as never);
      const res = await cmd.run('--incomplete', fakeCtx());
      expect(res?.message).toContain('1 incomplete session');
      expect(res?.message).toContain('s-crash');
      expect(res?.message).toContain('iteration 7 / tool: read');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a "no incomplete sessions" message when the dir has no stale logs', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'resume-clean-'));
    try {
      // Clean shutdown.
      const log = [
        JSON.stringify({ type: 'in_flight_start', ts: '2026-01-01T00:00:00Z', context: 'x' }),
        JSON.stringify({ type: 'in_flight_end', ts: '2026-01-01T00:00:01Z', reason: 'clean' }),
        '',
      ].join('\n');
      await writeFile(join(dir, 's-clean.jsonl'), log, 'utf8');
      const cmd = buildLoadCommand({ paths: { projectSessions: dir } } as never);
      const res = await cmd.run('--incomplete', fakeCtx());
      expect(res?.message).toMatch(/no incomplete/i);
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
        JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's-recover', model: 'm', provider: 'p' }),
        JSON.stringify({ type: 'checkpoint', ts: '2026-01-01T00:00:01Z', promptIndex: 0, promptPreview: 'before the crash' }),
        JSON.stringify({ type: 'in_flight_start', ts: '2026-01-01T00:00:02Z', context: 'iteration 7 / tool: bash' }),
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
        JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's-clean', model: 'm', provider: 'p' }),
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

  it('returns exit even when no onExit registered', async () => {
    const cmd = buildExitCommand({} as never);
    const res = await cmd.run('', fakeCtx());
    expect(res?.exit).toBe(true);
  });
});
