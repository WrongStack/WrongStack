import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F82/F83: branch-guard's guarded op set was commit|push|merge only, but the
 * config contract promises "Block merges into protected branches" and "Block
 * commits on protected branches". Empirically verified against real git:
 *   - `git pull . feat` on main FAST-FORWARDS main (a merge into protected);
 *     the structured git tool also exposes `pull`, undetected.
 *   - `git cherry-pick feat` on main creates `[main …] change`;
 *   - `git revert HEAD` on main creates `[main …] Revert "change"`.
 * All landed on protected main while the guard allowed them. `git am` applies
 * patches as commits — the same blockCommit contract.
 *
 * Git mocked (external dependency); the guard under test is real production
 * code. Controls prove read-only lookalikes (fetch, cherry) stay allowed.
 */
const mockExecFile = vi.fn(
  (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, stdout: string) => void,
  ) => {
    const command = args.join(' ');
    const stdout = command.includes('branch --show-current') ? 'main\n' : '';
    queueMicrotask(() => cb(null, stdout));
  },
);

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const branchGuardPlugin = (await import('../src/branch-guard/index.js')).default;

type BranchGuardHook = (input: unknown) => Promise<{ decision?: string; reason?: string } | void>;

function makeApi() {
  return {
    tools: { register: vi.fn() },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(
      (_event: string, _matcher: string, _hook: BranchGuardHook, _options?: unknown) => vi.fn(),
    ),
    onConfigChange: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getHook(api: ReturnType<typeof makeApi>) {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return call[2];
}

function setBranch(branch: string): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    const command = args.join(' ');
    const stdout = command.includes('branch --show-current') ? `${branch}\n` : '';
    queueMicrotask(() => cb(null, stdout));
    return undefined as never;
  });
}

async function run(toolInput: Record<string, unknown>, toolName = 'bash') {
  const api = makeApi();
  branchGuardPlugin.setup(api as never);
  return getHook(api)({ toolName, toolInput });
}

beforeEach(() => {
  vi.clearAllMocks();
  setBranch('main');
});

describe('branch-guard pull is a merge into protected (F82)', () => {
  it('blocks git pull on a protected branch', async () => {
    const result = await run({ command: 'git pull . feat' });
    expect(result?.decision, 'pull merges into the current branch').toBe('block');
    expect(result?.reason).toContain('main');
  });

  it('blocks git pull --rebase on a protected branch', async () => {
    const result = await run({ command: 'git pull --rebase . feat' });
    expect(result?.decision).toBe('block');
  });

  it('blocks the structured git tool pull command', async () => {
    const result = await run({ command: 'pull' }, 'git');
    expect(result?.decision).toBe('block');
  });

  it('still allows fetch (no local history change, control)', async () => {
    const result = await run({ command: 'git fetch origin' });
    expect(result?.decision ?? 'allow').not.toBe('block');
  });

  it('still allows pull on an unprotected branch (control)', async () => {
    setBranch('feat');
    const result = await run({ command: 'git pull . main' });
    expect(result?.decision ?? 'allow').not.toBe('block');
  });
});

describe('branch-guard commit-creating ops (F83)', () => {
  it('blocks cherry-pick on a protected branch', async () => {
    const result = await run({ command: 'git cherry-pick abc1234' });
    expect(result?.decision, 'cherry-pick creates a commit on the current branch').toBe('block');
  });

  it('blocks revert on a protected branch', async () => {
    const result = await run({ command: 'git revert HEAD' });
    expect(result?.decision).toBe('block');
  });

  it('blocks am on a protected branch', async () => {
    const result = await run({ command: 'git am changes.mbox' });
    expect(result?.decision).toBe('block');
  });

  it('still allows cherry-pick on an unprotected branch (control)', async () => {
    setBranch('feat');
    const result = await run({ command: 'git cherry-pick abc1234' });
    expect(result?.decision ?? 'allow').not.toBe('block');
  });

  it('still allows git cherry (read-only comparison, control)', async () => {
    const result = await run({ command: 'git cherry origin/main' });
    expect(result?.decision ?? 'allow').not.toBe('block');
  });

  it('still blocks a plain commit on protected (regression)', async () => {
    const result = await run({ command: 'git commit -am x' });
    expect(result?.decision).toBe('block');
  });
});
