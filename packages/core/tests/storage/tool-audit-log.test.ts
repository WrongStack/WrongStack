import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolAuditLog } from '../../src/storage/tool-audit-log.js';

// vi.mock is hoisted above imports.  The factory uses vi.importActual to lazily
// get the real module, avoiding TDZ issues.  The returned plain object replaces
// 'node:fs/promises' before the second import runs.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  // In-memory store for entries written via record().  readFile falls back to
  // the real filesystem so tamper tests (which write real files then verify
  // on a fresh instance) work correctly.
  const store: Record<string, string> = {};

  const mockFs = {
    readFile: vi.fn(async (filepath: string | Buffer | URL) => {
      const k = String(filepath);
      if (store[k] !== undefined) return store[k];
      return await real.readFile(k, 'utf8');
    }),
    appendFile: vi.fn(async (filepath: string | Buffer | URL, data: string) => {
      const k = String(filepath);
      store[k] = (store[k] ?? '') + data;
      await real.appendFile(k, data, 'utf8');
    }),
    writeFile: vi.fn(async (filepath: string | Buffer | URL, data: string) => {
      const k = String(filepath);
      store[k] = data;
      await real.writeFile(k, data, 'utf8');
    }),
    open: real.open,
    close: real.close,
    fsync: real.fsync,
    rename: real.rename,
    access: real.access,
    unlink: real.unlink,
    mkdir: real.mkdir,
    readdir: real.readdir,
    rm: real.rm,
    mkdtemp: real.mkdtemp,
    chmod: real.chmod,
    copyFile: real.copyFile,
    stat: real.stat,
  };
  return mockFs;
});

import * as fsp from 'node:fs/promises';

let dir: string;
let log: ToolAuditLog;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tool-audit-'));
  log = new ToolAuditLog({ dir });
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('ToolAuditLog', () => {
  it('starts empty and verifies cleanly', async () => {
    expect(await log.verify('s1')).toEqual({ ok: true, entries: 0 });
    expect(await log.load('s1')).toEqual([]);
  });

  it('appends entries with monotonically increasing indices', async () => {
    const e0 = await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: { path: '/a' },
      output: 'hello',
      isError: false,
    });
    const e1 = await log.record({
      sessionId: 's1',
      toolName: 'write',
      toolUseId: 'tu-2',
      input: { path: '/b', content: 'x' },
      output: 'ok',
      isError: false,
    });
    expect(e0.index).toBe(0);
    expect(e1.index).toBe(1);
    expect(e0.hash).not.toBe(e1.hash);
    expect(e1.prevHash).toBe(e0.hash);
  });

  it('the first entry has the all-zeros genesis prevHash', async () => {
    const e0 = await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'x',
      isError: false,
    });
    expect(e0.prevHash).toBe('0'.repeat(64));
  });

  it('verify passes for an unmodified chain', async () => {
    for (let i = 0; i < 5; i++) {
      await log.record({
        sessionId: 's1',
        toolName: 'read',
        toolUseId: `tu-${i}`,
        input: { i },
        output: `result ${i}`,
        isError: false,
      });
    }
    const result = await log.verify('s1');
    expect(result).toEqual({ ok: true, entries: 5 });
  });

  it('verify fails when an entry is tampered (content changed)', async () => {
    await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: { path: '/a' },
      output: 'original',
      isError: false,
    });
    await log.record({
      sessionId: 's1',
      toolName: 'write',
      toolUseId: 'tu-2',
      input: { path: '/b' },
      output: 'ok',
      isError: false,
    });
    // Tamper: rewrite the file with the second entry's output changed.
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fsp.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const second = JSON.parse(lines[1]!);
    second.output = 'TAMPERED';
    lines[1] = JSON.stringify(second);
    await fsp.writeFile(fp, lines.join('\n') + '\n', 'utf8');
    // Wipe the in-memory cache so verify re-reads from disk.
    const fresh = new ToolAuditLog({ dir });
    const result = await fresh.verify('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toMatch(/hash mismatch at entry 1/);
    }
  });

  it('verify fails when an entry is deleted (chain breaks)', async () => {
    for (let i = 0; i < 3; i++) {
      await log.record({
        sessionId: 's1',
        toolName: 'read',
        toolUseId: `tu-${i}`,
        input: {},
        output: `r${i}`,
        isError: false,
      });
    }
    // Delete the middle entry.
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fsp.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    lines.splice(1, 1);
    await fsp.writeFile(fp, lines.join('\n') + '\n', 'utf8');
    const fresh = new ToolAuditLog({ dir });
    const result = await fresh.verify('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
    }
  });

  it('verify fails when the genesis prevHash is corrupted', async () => {
    await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'x',
      isError: false,
    });
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fsp.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]!);
    first.prevHash = 'f'.repeat(64);
    lines[0] = JSON.stringify(first);
    await fsp.writeFile(fp, lines.join('\n') + '\n', 'utf8');
    const fresh = new ToolAuditLog({ dir });
    const result = await fresh.verify('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(0);
      expect(result.reason).toMatch(/genesis/);
    }
  });

  it('serializes concurrent records without losing entries', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        log.record({
          sessionId: 's1',
          toolName: 'read',
          toolUseId: `tu-${i}`,
          input: { i },
          output: `r${i}`,
          isError: false,
        }),
      ),
    );
    const result = await log.verify('s1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toBe(N);
  });

  it('survives a fresh store instance and re-verifies cleanly', async () => {
    for (let i = 0; i < 4; i++) {
      await log.record({
        sessionId: 's1',
        toolName: 'read',
        toolUseId: `tu-${i}`,
        input: {},
        output: `r${i}`,
        isError: false,
      });
    }
    const fresh = new ToolAuditLog({ dir });
    expect(await fresh.verify('s1')).toEqual({ ok: true, entries: 4 });
  });

  it('isolates sessions — corrupting one does not affect the other', async () => {
    await log.record({ sessionId: 's1', toolName: 'a', toolUseId: 'tu', input: {}, output: 1, isError: false });
    await log.record({ sessionId: 's2', toolName: 'b', toolUseId: 'tu', input: {}, output: 2, isError: false });
    // Corrupt s2.
    const fp = path.join(dir, 's2.audit.jsonl');
    await fsp.writeFile(fp, '{not json\n', 'utf8');
    const fresh = new ToolAuditLog({ dir });
    expect(await fresh.verify('s1')).toEqual({ ok: true, entries: 1 });
    expect(await fresh.verify('s2')).toEqual({ ok: true, entries: 0 });
  });

  it('rejects path-traversal session ids', async () => {
    await expect(
      log.record({
        sessionId: '../escape',
        toolName: 'x',
        toolUseId: 'tu',
        input: {},
        output: 'x',
        isError: false,
      }),
    ).rejects.toThrow(/invalid sessionid/i);
  });

  it('records and verifies under a date-sharded session id', async () => {
    const shardedId = '2026-06-11/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
    await log.record({
      sessionId: shardedId,
      toolName: 'read',
      toolUseId: 'tu-1',
      input: { path: 'a.ts' },
      output: 'ok',
      isError: false,
    });
    expect(await log.verify(shardedId)).toEqual({ ok: true, entries: 1 });
    await expect(
      fsp.access(path.join(dir, '2026-06-11', 'sess_01JX2S9V7T5M6N7P8Q9R0STXVW.audit.jsonl')),
    ).resolves.toBeUndefined();
  });

  // ── storage.* event emissions ───────────────────────────────────────────

  it('emits storage.read with outcome success when verify() finds a clean chain', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedLog = new ToolAuditLog({ dir, events });
    await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'ok',
      isError: false,
    });
    const fresh = new ToolAuditLog({ dir, events });
    const result = await fresh.verify('s1');
    expect(result).toEqual({ ok: true, entries: 1 });
    expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'audit',
      operation: 'verify',
      outcome: 'success',
      sessionId: 's1',
    }));
  });

  it('emits storage.read with outcome failure when verify() finds a broken chain', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedLog = new ToolAuditLog({ dir, events });
    await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'ok',
      isError: false,
    });
    // Tamper with the audit file to break the hash chain.
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fsp.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]!);
    first.output = 'TAMPERED';
    lines[0] = JSON.stringify(first);
    await fsp.writeFile(fp, lines.join('\n') + '\n', 'utf8');
    const fresh = new ToolAuditLog({ dir, events });
    const result = await fresh.verify('s1');
    expect(result.ok).toBe(false);
    expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'audit',
      operation: 'verify',
      outcome: 'failure',
      sessionId: 's1',
    }));
  });

  it('emits storage.read with outcome failure when verify() encounters an unreadable file', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedLog = new ToolAuditLog({ dir, events });
    // Write a real audit file so readAll finds it.
    await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'x',
      isError: false,
    });
    // Now make readFile fail for this session's file.
    fsp.readFile.mockImplementation(async (p: string | Buffer | URL) => {
      if (String(p).endsWith('s1.audit.jsonl')) {
        throw Object.assign(new Error('EACCES permission denied'), { code: 'EACCES' });
      }
      const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return real.readFile(String(p), 'utf8');
    });
    try {
      const fresh = new ToolAuditLog({ dir, events });
      const result = await fresh.verify('s1');
      expect(result).toEqual({ ok: true, entries: 0 }); // graceful degradation
      expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'audit',
        operation: 'verify',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      fsp.readFile.mockReset();
    }
  });

  it('emits storage.write with operation record on successful record()', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedLog = new ToolAuditLog({ dir, events });
    const entry = await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'hi',
      isError: false,
    });
    expect(entry.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(events.emit).toHaveBeenCalledWith('storage.write', expect.objectContaining({
      store: 'audit',
      operation: 'record',
      outcome: 'success',
      sessionId: 's1',
    }));
  });

  it('emits storage.error when record() encounters a write failure', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedLog = new ToolAuditLog({ dir, events });
    fsp.appendFile.mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }),
    );
    try {
      await expect(
        loggedLog.record({
          sessionId: 's1',
          toolName: 'read',
          toolUseId: 'tu-1',
          input: {},
          output: 'hi',
          isError: false,
        }),
      ).rejects.toThrow('ENOSPC');
      expect(events.emit).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'audit',
        operation: 'record',
        outcome: 'failure',
        error: expect.stringContaining('ENOSPC'),
      }));
    } finally {
      fsp.writeFile.mockReset();
    }
  });
});
