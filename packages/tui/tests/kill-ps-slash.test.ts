import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the process registry — exercise every branch of /kill and /ps
// against a synthetic registry state.
const registryState = {
  procs: [] as Array<{
    pid: number;
    name: string;
    command: string;
    startedAt: number;
    killed: boolean;
  }>,
  breaker: {
    state: 'closed' as 'closed' | 'half-open' | 'open',
    consecutiveFailures: 0,
    slowCallsInWindow: 0,
    callsInWindow: 0,
    cooldownRemainingMs: null as number | null,
  },
};

const fakeRegistry = {
  list: vi.fn(() => registryState.procs),
  stats: vi.fn(() => ({ breaker: registryState.breaker })),
  killAll: vi.fn((_opts?: { force?: boolean }) => {
    const pids = registryState.procs.map((p) => p.pid);
    registryState.procs = [];
    return pids;
  }),
  kill: vi.fn((pid: number) => {
    const idx = registryState.procs.findIndex((p) => p.pid === pid);
    if (idx === -1) return false;
    registryState.procs.splice(idx, 1);
    return true;
  }),
  forceBreakerOpen: vi.fn(() => {
    registryState.breaker.state = 'open';
    registryState.breaker.cooldownRemainingMs = 30000;
  }),
  forceBreakerReset: vi.fn(() => {
    registryState.breaker = {
      state: 'closed',
      consecutiveFailures: 0,
      slowCallsInWindow: 0,
      callsInWindow: 0,
      cooldownRemainingMs: null,
    };
  }),
};

vi.mock('@wrongstack/tools', () => ({
  getProcessRegistry: () => fakeRegistry,
}));

const { createKillSlashCommand } = await import('../src/kill-slash.js');
const { createPsSlashCommand } = await import('../src/ps-slash.js');

beforeEach(() => {
  registryState.procs = [];
  registryState.breaker = {
    state: 'closed',
    consecutiveFailures: 0,
    slowCallsInWindow: 0,
    callsInWindow: 0,
    cooldownRemainingMs: null,
  };
  for (const fn of Object.values(fakeRegistry)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
});

function messageOf(
  res: Awaited<ReturnType<ReturnType<typeof createKillSlashCommand>['run']>>,
): string {
  expect(res).toBeTruthy();
  expect(res && typeof res === 'object' && typeof res.message === 'string').toBe(true);
  return (res as { message: string }).message;
}

// ── /kill ────────────────────────────────────────────────────────────────────

describe('createKillSlashCommand', () => {
  it('exposes name "kill"', () => {
    expect(createKillSlashCommand().name).toBe('kill');
  });

  it('list (no args) renders breaker + "no processes" when empty', async () => {
    const cmd = createKillSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('No active processes');
    expect(messageOf(res)).toContain('Circuit breaker');
  });

  it('list with active processes renders pid/name/cmd lines', async () => {
    registryState.procs = [
      { pid: 1234, name: 'bash', command: 'ls -l', startedAt: Date.now() - 1500, killed: false },
    ];
    const cmd = createKillSlashCommand();
    const res = await cmd.run('list');
    expect(messageOf(res)).toContain('1234');
    expect(messageOf(res)).toContain('bash');
  });

  it('list truncates very long commands', async () => {
    registryState.procs = [
      { pid: 42, name: 'long', command: 'x'.repeat(200), startedAt: Date.now(), killed: false },
    ];
    const cmd = createKillSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('…');
  });

  it('list shows [killed] tag for killed entries', async () => {
    registryState.procs = [
      { pid: 99, name: 'zombie', command: 'sleep', startedAt: Date.now(), killed: true },
    ];
    const cmd = createKillSlashCommand();
    const res = await cmd.run('list');
    expect(messageOf(res)).toContain('[killed]');
  });

  it('breaker half-open state shown in renderList', async () => {
    registryState.breaker.state = 'half-open';
    const cmd = createKillSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('half-open');
  });

  it('breaker open state with cooldown shown', async () => {
    registryState.breaker.state = 'open';
    registryState.breaker.cooldownRemainingMs = 15000;
    const cmd = createKillSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toMatch(/open \(cooldown 15s/);
  });

  it('breaker open with null cooldown shows em-dash', async () => {
    registryState.breaker.state = 'open';
    registryState.breaker.cooldownRemainingMs = null;
    const cmd = createKillSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toMatch(/open \(cooldown —/);
  });

  it('all reports "no processes" when registry empty', async () => {
    const cmd = createKillSlashCommand();
    const res = await cmd.run('all');
    expect(messageOf(res)).toContain('No processes to kill');
  });

  it('all kills tracked processes and lists pids', async () => {
    registryState.procs = [
      { pid: 11, name: 'a', command: 'a', startedAt: 0, killed: false },
      { pid: 22, name: 'b', command: 'b', startedAt: 0, killed: false },
    ];
    const cmd = createKillSlashCommand();
    const res = await cmd.run('all');
    expect(messageOf(res)).toMatch(/Killed 2 processes: 11, 22/);
  });

  it('force opens breaker and force-kills (empty case)', async () => {
    const cmd = createKillSlashCommand();
    const res = await cmd.run('force');
    expect(fakeRegistry.forceBreakerOpen).toHaveBeenCalled();
    expect(messageOf(res)).toContain('Circuit breaker forced open');
  });

  it('force opens breaker and force-kills (one process)', async () => {
    registryState.procs = [{ pid: 7, name: 'x', command: 'x', startedAt: 0, killed: false }];
    const cmd = createKillSlashCommand();
    const res = await cmd.run('force');
    expect(messageOf(res)).toContain('Force-killed 1 process');
    expect(messageOf(res)).toContain('7');
  });

  it('reset re-closes the breaker', async () => {
    registryState.breaker.state = 'open';
    const cmd = createKillSlashCommand();
    const res = await cmd.run('reset');
    expect(fakeRegistry.forceBreakerReset).toHaveBeenCalled();
    expect(messageOf(res)).toContain('reset to closed');
  });

  it('kill by pid reports success on hit', async () => {
    registryState.procs = [{ pid: 42, name: 'a', command: '', startedAt: 0, killed: false }];
    const cmd = createKillSlashCommand();
    const res = await cmd.run('42');
    expect(messageOf(res)).toBe('Killed process 42.');
  });

  it('kill by pid reports not found on miss', async () => {
    const cmd = createKillSlashCommand();
    const res = await cmd.run('9999');
    expect(messageOf(res)).toContain('not found');
  });

  it('unknown sub returns usage', async () => {
    const cmd = createKillSlashCommand();
    const res = await cmd.run('wat');
    expect(messageOf(res)).toContain('Unknown subcommand');
    expect(messageOf(res)).toContain('Usage');
  });
});

// ── /ps ──────────────────────────────────────────────────────────────────────

describe('createPsSlashCommand', () => {
  it('exposes name "ps"', () => {
    expect(createPsSlashCommand().name).toBe('ps');
  });

  it('reports "No active processes" on empty list', async () => {
    const cmd = createPsSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toBe('No active processes.');
  });

  it('renders process table when entries exist', async () => {
    registryState.procs = [
      { pid: 1, name: 'sh', command: 'echo hi', startedAt: Date.now() - 500, killed: false },
    ];
    const cmd = createPsSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('Active processes (1)');
    expect(messageOf(res)).toContain('echo hi');
    expect(messageOf(res)).toContain('🟢 closed');
  });

  it('shows half-open breaker label', async () => {
    registryState.breaker.state = 'half-open';
    registryState.procs = [{ pid: 1, name: 's', command: 'c', startedAt: 0, killed: false }];
    const cmd = createPsSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('🟡 half-open');
  });

  it('shows open breaker label', async () => {
    registryState.breaker.state = 'open';
    registryState.procs = [{ pid: 1, name: 's', command: 'c', startedAt: 0, killed: false }];
    const cmd = createPsSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('🔴 open');
  });

  it('truncates command longer than 80 chars', async () => {
    registryState.procs = [
      { pid: 1, name: 's', command: 'x'.repeat(200), startedAt: 0, killed: false },
    ];
    const cmd = createPsSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('…');
  });

  it('marks killed entries', async () => {
    registryState.procs = [{ pid: 1, name: 's', command: 'c', startedAt: 0, killed: true }];
    const cmd = createPsSlashCommand();
    const res = await cmd.run('');
    expect(messageOf(res)).toContain('[killed]');
  });
});
