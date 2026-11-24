import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F79: branch-guard's in-command switch parser only recognized the create
 * flags as EXACT tokens (-b/-B/-c/-C/--orphan). Git accepts attached short
 * values — empirically verified: `git checkout -Bmain` switches to (force-
 * recreates) main, `git switch -Cfeat2` likewise. So
 * `git checkout -Bmain && git commit -am x` from a feature branch committed
 * onto the PROTECTED main while the guard, seeing no switch, judged the commit
 * against the feature branch and allowed it. Same for `switch -Cmain`,
 * `checkout -bmain` (creates the protected name when absent) and
 * `switch --orphan=main`.
 *
 * Git is mocked (external dependency); the parser under test is the real
 * production code. The mock faithfully returns the session branch for
 * `branch --show-current` — the hook fires BEFORE the command runs.
 */
const mockExecFile = vi.fn(
  (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, stdout: string) => void,
  ) => {
    const command = args.join(' ');
    const stdout = command.includes('branch --show-current') ? 'feat\n' : '';
    queueMicrotask(() => cb(null, stdout));
  },
);

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const branchGuardPlugin = (await import('../src/branch-guard/index.js')).default;

type BranchGuardHook = (input: unknown) => Promise<{ decision?: string; reason?: string } | void>;

function makeApi(extensions: Record<string, unknown> = {}) {
  return {
    tools: { register: vi.fn() },
    config: { extensions },
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

async function run(command: string, extensions?: Record<string, unknown>) {
  const api = makeApi(extensions);
  branchGuardPlugin.setup(api as never);
  return getHook(api)({ toolName: 'bash', toolInput: { command } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('branch-guard attached create-flag values (F79)', () => {
  it('blocks checkout -Bmain followed by a commit', async () => {
    const result = await run('git checkout -Bmain && git commit -am x');
    expect(result?.decision, 'force-recreated protected branch must block').toBe('block');
    expect(result?.reason).toContain('main');
  });

  it('blocks switch -Cmain followed by a commit', async () => {
    const result = await run('git switch -Cmain && git commit -am x');
    expect(result?.decision).toBe('block');
  });

  it('blocks checkout -bmain (creates the protected name) followed by a commit', async () => {
    const result = await run('git checkout -bmain && git commit -am x');
    expect(result?.decision).toBe('block');
  });

  it('blocks switch --orphan=main followed by a commit', async () => {
    const result = await run('git switch --orphan=main && git commit -am x');
    expect(result?.decision).toBe('block');
  });

  it('still allows an attached create of an UNPROTECTED branch (control)', async () => {
    const result = await run('git checkout -Bfeat2 && git commit -am x');
    expect(result?.decision ?? 'allow').not.toBe('block');
  });

  it('still allows a path restore + commit on the feature branch (control)', async () => {
    const result = await run('git checkout -- src/a.ts && git commit -am x');
    expect(result?.decision ?? 'allow').not.toBe('block');
  });
});

/**
 * F80: the same attached-value class for switch's LONG create options.
 * Empirically verified: `git switch --create=main` creates main and
 * `--force-create=main` force-recreates it. The `=value` spelling starts with
 * '-', so the plain-target fallback skipped it and the switch went unseen.
 */
describe('branch-guard long create-option = values (F80)', () => {
  it('blocks switch --create=main followed by a commit', async () => {
    const result = await run('git switch --create=main && git commit -am x');
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('main');
  });

  it('blocks switch --force-create=main followed by a commit', async () => {
    const result = await run('git switch --force-create=main && git commit -am x');
    expect(result?.decision).toBe('block');
  });

  it('still blocks the space form --create main (regression control)', async () => {
    const result = await run('git switch --create main && git commit -am x');
    expect(result?.decision).toBe('block');
  });

  it('still allows --create=feat2 (unprotected, control)', async () => {
    const result = await run('git switch --create=feat2 && git commit -am x');
    expect(result?.decision ?? 'allow').not.toBe('block');
  });
});

/**
 * F81: combined short clusters. Git accepts `-qBmain` (= -q -B main) and
 * `-qcmain` (= -q -c main) — empirically verified. The create detector only
 * knew clusters starting with the create letter, so `-qBmain` went unseen and
 * the commit was judged on the pre-switch branch. Also covers the cluster
 * with a SEPARATE value (`-qb main`) when the branch does not exist yet: the
 * plain-target fallback verified it as a checkout of a non-branch, ignored
 * the switch, and git still created the protected name.
 */
describe('branch-guard short clusters with create flags (F81)', () => {
  it('blocks checkout -qBmain followed by a commit', async () => {
    const result = await run('git checkout -qBmain && git commit -am x');
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('main');
  });

  it('blocks switch -qcmain followed by a commit', async () => {
    const result = await run('git switch -qcmain && git commit -am x');
    expect(result?.decision).toBe('block');
  });

  it('blocks checkout -qb main (separate value, branch absent) followed by a commit', async () => {
    // show-ref fails: main does not exist locally yet; -qb CREATES it.
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const command = args.join(' ');
      if (command.includes('show-ref')) {
        queueMicrotask(() => cb(new Error('not found'), ''));
        return undefined as never;
      }
      const stdout = command.includes('branch --show-current') ? 'feat\n' : '';
      queueMicrotask(() => cb(null, stdout));
      return undefined as never;
    });
    const result = await run('git checkout -qb main && git commit -am x');
    expect(result?.decision).toBe('block');
  });

  it('still allows a plain quiet switch to an unprotected branch (control)', async () => {
    const result = await run('git checkout -q feat && git commit -am x');
    expect(result?.decision ?? 'allow').not.toBe('block');
  });

  it('still allows -qBfeat2 (unprotected create, control)', async () => {
    const result = await run('git checkout -qBfeat2 && git commit -am x');
    expect(result?.decision ?? 'allow').not.toBe('block');
  });
});

/**
 * The cluster's boolean prefix must not hold a create letter: git takes the
 * FIRST b/B/c/C and the rest as its value (`-Bproduction` = -B production).
 * A greedy `[a-zA-Z]*` prefix took the LAST one, read `-Bproduction` as a
 * create of `tion`, and a commit on the protected `production` went through.
 */
describe('branch-guard create letters inside the attached value', () => {
  const extensions = { 'branch-guard': { branches: ['main', 'production', 'stable'] } };

  it('blocks checkout -Bproduction followed by a commit', async () => {
    const result = await run('git checkout -Bproduction && git commit -am x', extensions);
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('production');
  });

  it('blocks switch -qcstable followed by a commit', async () => {
    const result = await run('git switch -qcstable && git commit -am x', extensions);
    expect(result?.decision).toBe('block');
  });

  it('still allows -Bbackup (unprotected name with create letters, control)', async () => {
    const result = await run('git checkout -Bbackup && git commit -am x', extensions);
    expect(result?.decision ?? 'allow').not.toBe('block');
  });
});
