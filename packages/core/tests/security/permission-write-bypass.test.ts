import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import type { Tool } from '../../src/types/index.js';

/**
 * P1 #1 (before-release.md): the permission policy's write-smart-bypass
 * (step 7 in `evaluate()`) auto-approved `write` for any file `ctx.hasRead()`
 * returned true on. Since `edit`/`write` both called `recordRead()` after
 * mutating a file, the model could repeatedly overwrite a file whose content
 * the user never approved — the bypass treated a tool-only write as "user
 * already saw the content".
 *
 * Fix: `recordRead()` now takes a `source` discriminator. `'user'` (read tool,
 * edit auto-read) populates `readFiles` and qualifies for the bypass; `'write'`
 * (edit/write mutations) populates `writtenFiles` only and does NOT qualify.
 *
 * These tests pin both the Context-level split and the permission-policy
 * behavior that depends on it.
 */

function writeTool(): Tool {
  return {
    name: 'write',
    description: 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'confirm',
    mutating: true,
    capabilities: ['fs.write'],
    async execute() {
      return 'ok';
    },
  };
}

function mkCtx(): Context {
  // Minimal Context — only the fields the permission policy touches.
  return {
    hasRead: (_p: string) => false,
    hasWritten: (_p: string) => false,
  } as unknown as Context;
}

function ctxWith(reads: string[] = [], writes: string[] = []): Context {
  const readSet = new Set(reads);
  const writeSet = new Set(writes);
  return {
    hasRead: (p: string) => readSet.has(p),
    hasWritten: (p: string) => writeSet.has(p),
  } as unknown as Context;
}

/** Subject the policy actually passes to hasRead() for a write to `path`. */
const subj = (p: string) => p;

describe('Context — readFiles / writtenFiles separation (P1 #1)', () => {
  it('recordRead(user) populates readFiles; hasRead() returns true', () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/src/a.ts', 1000);
    expect(ctx.hasRead('/p/src/a.ts')).toBe(true);
    expect(ctx.hasWritten('/p/src/a.ts')).toBe(false);
  });

  it('recordRead(write) does NOT populate readFiles — hasRead() returns false', () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/src/b.ts', 2000, 'write');
    // mtime is tracked for staleness checks…
    expect(ctx.lastReadMtime('/p/src/b.ts')).toBe(2000);
    // …but the permission bypass must NOT see it.
    expect(ctx.hasRead('/p/src/b.ts')).toBe(false);
    expect(ctx.hasWritten('/p/src/b.ts')).toBe(true);
  });

  it('default source is "user" (backward-compatible with existing callers)', () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/src/c.ts', 3000);
    expect(ctx.hasRead('/p/src/c.ts')).toBe(true);
  });

  it('clearFileTracking clears both readFiles and writtenFiles', () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/a', 1);
    ctx.recordRead('/p/b', 2, 'write');
    ctx.clearFileTracking();
    expect(ctx.hasRead('/p/a')).toBe(false);
    expect(ctx.hasWritten('/p/b')).toBe(false);
    expect(ctx.lastReadMtime('/p/a')).toBeUndefined();
  });
});

describe('DefaultPermissionPolicy — write smart-bypass (step 7, P1 #1)', () => {
  let trustFile: string;
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-write-'));
    trustFile = path.join(dir, 'trust.json');
  });
  afterEach(async () => {
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  });

  const t = writeTool();

  it('auto-approves write to a file the user explicitly read (bypass still works)', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // User ran `read` on src/a.ts → hasRead() returns true for the subject.
    const decision = await p.evaluate(t, { path: 'src/a.ts' }, ctxWith([subj('src/a.ts')]));
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('context');
  });

  it('does NOT auto-approve write to a file only touched by edit/write (P1 #1 regression)', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // edit/write recorded the file, but with source 'write'. The bypass must
    // fall through to the normal confirm flow.
    const decision = await p.evaluate(
      t,
      { path: 'src/secret.ts' },
      ctxWith([], [subj('src/secret.ts')]),
    );
    expect(decision.permission).toBe('confirm');
  });

  it('does NOT auto-approve when neither read nor write touched the file', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: 'src/new.ts' }, mkCtx());
    expect(decision.permission).toBe('confirm');
  });

  it('a prior user read still bypasses even if the file was later written', async () => {
    // Common flow: read → edit → write. The user saw the original content, so
    // the bypass should apply. Both readFiles and writtenFiles contain the path,
    // but hasRead() (the bypass source of truth) returns true.
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(
      t,
      { path: 'src/iter.ts' },
      ctxWith([subj('src/iter.ts')], [subj('src/iter.ts')]),
    );
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('context');
  });
});

/**
 * Security scan 2026-08-04, finding C1.
 *
 * The `source` discriminator above separates "the read tool touched this" from
 * "the write tool touched this" — but NOT "the user approved this". `read` is
 * `permission: 'auto'`, so a model-initiated read populates `readFiles` without
 * the user ever seeing it. Chained with the bypass, `read X` → `write X` ran
 * with zero user interaction on any path.
 *
 * That is fine for project content — it is what the bypass is for. It is not
 * fine for `~/.wrongstack`, which the file tools may always reach (an allowed
 * root even in restricted mode) and which is executable state:
 *
 *   - `config.local.json` merges as a FULLY TRUSTED config layer — unlike
 *     in-project config it is not passed through `stripUnsafeInProjectFields`,
 *     so `hooks` survives and runs as a shell command at next boot.
 *   - `trust.json` holds the persisted permission globs; a write there can
 *     disable every future prompt.
 *   - `skills/` and `instructions/` re-enter the model's own prompt.
 *
 * So the bypass now stops at the wstack global root, and YOLO's destructive
 * carve-out — which previously only considered shell tools — treats a write
 * landing there as destructive too.
 */
describe('write smart-bypass — wstack global root is never silently writable (C1)', () => {
  let trustFile: string;
  let fakeHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-c1-'));
    trustFile = path.join(dir, 'trust.json');
    fakeHome = path.join(dir, 'dot-wrongstack');
    prevHome = process.env['WRONGSTACK_HOME'];
    process.env['WRONGSTACK_HOME'] = fakeHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = prevHome;
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  });

  const t = writeTool();
  /** The policy normalizes path subjects to forward slashes before `hasRead`. */
  const asSubject = (p: string) => p.replace(/\\/g, '/');

  const agentStateCtx = (target: string): Context =>
    ({
      hasRead: (p: string) => p === asSubject(target),
      hasWritten: () => false,
      cwd: '/p',
      workingDir: '/p',
      projectRoot: '/p',
    }) as unknown as Context;

  it('does NOT auto-approve a write to config.local.json even after a read', async () => {
    const target = path.join(fakeHome, 'projects', 'abc123', 'config.local.json');
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: target }, agentStateCtx(target));
    expect(decision.permission).toBe('confirm');
    expect(decision.source).not.toBe('context');
  });

  it('does NOT auto-approve a write to trust.json even after a read', async () => {
    const target = path.join(fakeHome, 'trust.json');
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: target }, agentStateCtx(target));
    expect(decision.permission).toBe('confirm');
  });

  it('covers the whole global-root tree, not just config files', async () => {
    // `skills/` and `instructions/` feed straight back into the prompt, so a
    // silent write there is a prompt-injection persistence primitive too.
    const target = path.join(fakeHome, 'profiles', 'default', 'skills', 'evil.md');
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: target }, agentStateCtx(target));
    expect(decision.permission).toBe('confirm');
  });

  it('still auto-approves an ordinary project file (no regression)', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: 'src/app.ts' }, agentStateCtx('src/app.ts'));
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('context');
  });

  it('explain() reports the same verdict as evaluate() (no drift)', async () => {
    const target = path.join(fakeHome, 'projects', 'abc123', 'config.local.json');
    const p = new DefaultPermissionPolicy({ trustFile });
    const trace = await p.explain(t, { path: target }, agentStateCtx(target));
    expect(trace.decision.permission).toBe('confirm');
    // The bypass must never be the winning step. It may also be absent
    // entirely — an earlier gate (sensitive read) can claim the decision first,
    // which is still a confirm.
    const bypassStep = trace.steps.find((s) => s.rule === 'write smart bypass');
    expect(bypassStep?.matched ?? false).toBe(false);
  });

  it('YOLO still asks before writing into the global root', async () => {
    const target = path.join(fakeHome, 'projects', 'abc123', 'config.local.json');
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(t, { path: target }, agentStateCtx(target));
    expect(decision.permission).toBe('confirm');
    expect(decision.source).toBe('yolo_destructive');
  });

  it('YOLO still auto-approves ordinary project writes', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(t, { path: 'src/app.ts' }, agentStateCtx('src/app.ts'));
    expect(decision.permission).toBe('auto');
  });

  it('yoloDestructive:true opts back in, as it does for shell tools', async () => {
    const target = path.join(fakeHome, 'trust.json');
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloDestructive: true });
    const decision = await p.evaluate(t, { path: target }, agentStateCtx(target));
    expect(decision.permission).toBe('auto');
  });
});

/**
 * The C1 carve-out above only inspected `path`/`file_path`. FS_WRITE tools
 * disagree on where the target path lives — replace/format/git use `files`
 * (string OR array), design uses `out`, patch uses `directory` — so a
 * state-root write could dodge the carve-out by switching tools. These pin
 * the extended key coverage.
 */
describe('YOLO carve-out — path keys beyond `path`/`file_path` (C1 follow-up)', () => {
  let trustFile: string;
  let fakeHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-keys-'));
    trustFile = path.join(dir, 'trust.json');
    fakeHome = path.join(dir, 'dot-wrongstack');
    prevHome = process.env['WRONGSTACK_HOME'];
    process.env['WRONGSTACK_HOME'] = fakeHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = prevHome;
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  });

  /** A minimal FS_WRITE tool carrying the given name (write's schema/caps). */
  const fsWriteTool = (name: string): Tool => ({
    ...writeTool(),
    name,
  });

  it('`files` (string) targeting the global root still confirms under YOLO', async () => {
    const target = path.join(fakeHome, 'trust.json');
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(fsWriteTool('replace'), { files: target }, mkCtx());
    expect(decision.permission).toBe('confirm');
    expect(decision.source).toBe('yolo_destructive');
  });

  it('`files` (array) targeting the global root still confirms under YOLO', async () => {
    const target = path.join(fakeHome, 'config.local.json');
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(fsWriteTool('replace'), { files: [target] }, mkCtx());
    expect(decision.permission).toBe('confirm');
    expect(decision.source).toBe('yolo_destructive');
  });

  it('`out` (design) and `directory` (patch) targeting the root confirm under YOLO', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const outDecision = await p.evaluate(
      fsWriteTool('design'),
      { action: 'materialize', out: path.join(fakeHome, 'theme.css') },
      mkCtx(),
    );
    expect(outDecision.permission).toBe('confirm');
    expect(outDecision.source).toBe('yolo_destructive');
    const dirDecision = await p.evaluate(
      fsWriteTool('patch'),
      { directory: path.join(fakeHome, 'projects', 'abc') },
      mkCtx(),
    );
    expect(dirDecision.permission).toBe('confirm');
    expect(dirDecision.source).toBe('yolo_destructive');
  });

  it('a cached `auto` for a project subject is not replayed for a state-root secondary key', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    // Call 1: `files` is the subject key, so cacheKey === "replace::src/app.ts".
    // A project path, so the carve-out does not fire and `auto` is cached.
    const first = await p.evaluate(fsWriteTool('replace'), { files: 'src/app.ts' }, mkCtx());
    expect(first.permission).toBe('auto');

    // Call 2: same tool + same subject, so the same cache key — but a SECOND
    // path-bearing key now targets the agent state root. The carve-out scans
    // every key in `fsWriteTargetPaths`, yet it runs after the cache lookup,
    // so a replayed `auto` would grant an unprompted state-root write.
    const decision = await p.evaluate(
      fsWriteTool('replace'),
      { files: 'src/app.ts', out: path.join(fakeHome, 'trust.json') },
      mkCtx(),
    );
    expect(decision.permission).toBe('confirm');
    expect(decision.source).toBe('yolo_destructive');
  });

  it('project files via those keys still auto-approve (no regression)', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    expect(
      (await p.evaluate(fsWriteTool('replace'), { files: 'src/app.ts' }, mkCtx())).permission,
    ).toBe('auto');
    expect(
      (
        await p.evaluate(
          fsWriteTool('design'),
          { action: 'materialize', out: 'src/theme.css' },
          mkCtx(),
        )
      ).permission,
    ).toBe('auto');
    expect((await p.evaluate(fsWriteTool('patch'), { directory: 'src' }, mkCtx())).permission).toBe(
      'auto',
    );
  });
});

/**
 * The file tools canonicalize subjects to realpaths (`safeResolveReal`,
 * WS-048). When `WRONGSTACK_HOME` (or `~/.wrongstack`) is itself a symlink,
 * a lexical containment check against the unresolved root misses those
 * realpath subjects — read→write of `config.local.json`/`trust.json` is
 * auto-approved, the exact C1 attack shape. These pin the realpath-aware
 * comparison. Skipped on platforms that cannot create symlinks.
 */
describe('write smart-bypass — symlinked global root (C1 follow-up)', () => {
  let trustFile: string;
  let realHome: string; // the directory behind the symlink
  let linkHome: string; // the symlink WRONGSTACK_HOME points at
  let prevHome: string | undefined;
  let symlinkOk = false;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-link-'));
    trustFile = path.join(dir, 'trust.json');
    realHome = path.join(dir, 'real-wrongstack');
    await fs.mkdir(realHome, { recursive: true });
    linkHome = path.join(dir, 'linked-wrongstack');
    try {
      await fs.symlink(realHome, linkHome, 'junction');
      symlinkOk = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') symlinkOk = false;
      else throw err;
    }
    prevHome = process.env['WRONGSTACK_HOME'];
    process.env['WRONGSTACK_HOME'] = linkHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = prevHome;
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  });

  const symlinkCtx = (target: string): Context =>
    ({
      hasRead: (p: string) => p === target.replace(/\\/g, '/'),
      hasWritten: () => false,
      cwd: '/p',
      workingDir: '/p',
      projectRoot: '/p',
    }) as unknown as Context;

  const t = writeTool();

  it('bypass does NOT auto-approve a realpath write to config.local.json under a symlinked root', async ({
    skip,
  }) => {
    if (!symlinkOk) return skip('symlink creation is not permitted on this platform');
    const realTarget = path.join(realHome, 'projects', 'abc123', 'config.local.json');
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: realTarget }, symlinkCtx(realTarget));
    expect(decision.permission).toBe('confirm');
    expect(decision.source).not.toBe('context');
  });

  it('YOLO still asks for a realpath write into a symlinked root', async ({ skip }) => {
    if (!symlinkOk) return skip('symlink creation is not permitted on this platform');
    const realTarget = path.join(realHome, 'trust.json');
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(t, { path: realTarget }, symlinkCtx(realTarget));
    expect(decision.permission).toBe('confirm');
    expect(decision.source).toBe('yolo_destructive');
  });

  it('an ordinary project write still bypasses with a symlinked root present (no regression)', async ({
    skip,
  }) => {
    if (!symlinkOk) return skip('symlink creation is not permitted on this platform');
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: 'src/app.ts' }, symlinkCtx('src/app.ts'));
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('context');
  });
});
