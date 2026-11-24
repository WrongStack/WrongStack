import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F84: branch-guard captured process.cwd() at SETUP and judged every call
 * against that repo. HookInput carries the session's `cwd` and `workingDir`,
 * and the contract says: "A hook that reasons about where a tool acted starts
 * here [workingDir], not at cwd." On a worktree session or a multi-project
 * host (server launched elsewhere), a commit onto the session repo's protected
 * branch was judged against the HOST's repo — and allowed.
 *
 * Git mocked faithfully: `branch --show-current` answers for the repo at
 * opts.cwd (the plugin passes cwd to execFile). The session repo (workingDir)
 * is on protected main; the host process cwd's repo is on feat.
 */
const HOST_CWD = process.cwd();
const SESSION_DIR = 'D:\\projects\\session-repo';
const OTHER_DIR = 'D:\\projects\\other-repo';

const mockExecFile = vi.fn(
  (
    _cmd: string,
    args: string[],
    opts: { cwd?: string },
    cb: (error: Error | null, stdout: string) => void,
  ) => {
    const command = args.join(' ');
    let stdout = '';
    if (command.includes('branch --show-current')) {
      // The session repo is on protected main; everywhere else on feat.
      stdout = opts?.cwd === SESSION_DIR ? 'main\n' : 'feat\n';
    }
    queueMicrotask(() => cb(null, stdout));
  },
);

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const branchGuardPlugin = (await import('../src/branch-guard/index.js')).default;

function makeApi() {
  return {
    tools: { register: vi.fn() },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onConfigChange: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getHook(api: ReturnType<typeof makeApi>) {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return call[2] as (input: unknown) => Promise<{ decision?: string; reason?: string } | void>;
}

async function run(input: Record<string, unknown>) {
  const api = makeApi();
  branchGuardPlugin.setup(api as never);
  return getHook(api)(input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('branch-guard session working directory (F84)', () => {
  it('judges the session workingDir, not the host process cwd', async () => {
    const result = await run({
      toolName: 'bash',
      toolInput: { command: 'git commit -am x' },
      cwd: HOST_CWD,
      workingDir: SESSION_DIR,
    });
    expect(result?.decision, 'session repo is on protected main').toBe('block');
    expect(result?.reason).toContain('main');
  });

  it('judges the session cwd when workingDir is absent', async () => {
    const result = await run({
      toolName: 'bash',
      toolInput: { command: 'git commit -am x' },
      cwd: SESSION_DIR,
    });
    expect(result?.decision).toBe('block');
  });

  it('prefers workingDir over cwd (set_working_dir / worktrees)', async () => {
    const result = await run({
      toolName: 'bash',
      toolInput: { command: 'git commit -am x' },
      cwd: OTHER_DIR,
      workingDir: SESSION_DIR,
    });
    expect(result?.decision).toBe('block');
  });

  it('still allows a commit when the session repo is unprotected (control)', async () => {
    const result = await run({
      toolName: 'bash',
      toolInput: { command: 'git commit -am x' },
      cwd: HOST_CWD,
      workingDir: OTHER_DIR,
    });
    expect(result?.decision ?? 'allow').not.toBe('block');
  });

  it('falls back to process.cwd() when the input carries no directories (control)', async () => {
    const result = await run({
      toolName: 'bash',
      toolInput: { command: 'git commit -am x' },
    });
    // Host cwd repo answers feat → allow (legacy behavior preserved).
    expect(result?.decision ?? 'allow').not.toBe('block');
  });
});
