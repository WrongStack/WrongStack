import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force the POSIX kill path (process-group signals) on any host.
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, default: actual, platform: () => 'linux' as NodeJS.Platform };
});

import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';

const fakeChild = (): ChildProcess => {
  const c = { killed: false, kill: vi.fn(() => { c.killed = true; return true; }) };
  return c as never as ChildProcess;
};
const makeProc = (pid: number, opts: { processGroupLeader?: boolean; childPid?: number } = {}) => {
  const child = fakeChild();
  Object.assign(child, { pid: opts.childPid ?? pid });
  return {
    pid,
    name: 'bash',
    command: 'sleep 1',
    startedAt: Date.now(),
    child,
    processGroupLeader: opts.processGroupLeader,
  };
};

beforeEach(() => {
  _resetProcessRegistry();
  vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => {
  _resetProcessRegistry();
  vi.restoreAllMocks();
});

describe('ProcessRegistry POSIX kill', () => {
  it('force-kills direct child when process-group leadership is not proven', () => {
    const r = getProcessRegistry();
    const proc = makeProc(987654);
    r.register(proc);
    expect(r.kill(proc.pid, { force: true })).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
    expect((proc.child.kill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('SIGKILL');
    expect(r.get(proc.pid)?.killed).toBe(true);
  });

  it('non-force: falls back to child.kill when the group SIGTERM throws', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const r = getProcessRegistry();
    const proc = makeProc(987658, { processGroupLeader: true });
    r.register(proc);
    expect(r.kill(proc.pid)).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
    expect(proc.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('non-force backup: falls back to child.kill when the group SIGKILL throws', () => {
    // SIGTERM succeeds (child stays "alive"), so the backup timer runs; the
    // group SIGKILL then throws → nested child.kill('SIGKILL') fallback.
    vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 'SIGKILL') throw new Error('ESRCH');
      return true;
    });
    vi.useFakeTimers();
    try {
      const r = getProcessRegistry();
      const proc = makeProc(987659, { processGroupLeader: true });
      r.register(proc);
      expect(r.kill(proc.pid, { graceMs: 50 })).toBe(true);
      vi.advanceTimersByTime(60); // backup timer fires → SIGKILL throws → child.kill
      expect(proc.child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('SIGTERM then schedules a SIGKILL backup (non-force)', () => {
    // Make the process-group signal "succeed" so child.killed stays false and
    // the backup SIGKILL timer actually escalates via process.kill(-pid).
    vi.useFakeTimers();
    try {
      const r = getProcessRegistry();
      const proc = makeProc(987655, { processGroupLeader: true });
      r.register(proc);
      expect(r.kill(proc.pid, { graceMs: 50 })).toBe(true);
      expect(process.kill).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
      vi.advanceTimersByTime(60); // backup timer fires
      expect(process.kill).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses process-group signaling for unsafe PIDs even when opted in', () => {
    const r = getProcessRegistry();
    for (const pid of [0, 1, -123, process.pid]) {
      const proc = makeProc(pid, { processGroupLeader: true });
      r.register(proc);
      expect(r.kill(pid, { force: true })).toBe(true);
      expect(proc.child.kill).toHaveBeenCalledWith('SIGKILL');
      r.unregister(pid);
    }
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('refuses process-group signaling when child.pid does not match the tracked PID', () => {
    const r = getProcessRegistry();
    const proc = makeProc(987660, { processGroupLeader: true, childPid: 987661 });
    r.register(proc);
    expect(r.kill(proc.pid, { force: true })).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
    expect(proc.child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
