/**
 * `wstack acp` session modes: what each mode lets a gated tool call do, how
 * "always" answers are scoped, and how the start flags pick the first mode.
 *
 * The policy reads the mode at every call (a `session/set_mode` mid-turn
 * governs the next call). `yolo` and `auto-edit` take the verdict of the
 * project policy `wstack --yolo` runs under; most cases stub that arbiter, and
 * one runs the real one to prove a destructive command still asks.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { PermissionDecision, PermissionPolicy, Tool } from '@wrongstack/contracts/types';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { ToolCapabilities } from '@wrongstack/core/security';
import { createProjectPermissionPolicy } from '@wrongstack/runtime';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACPClientPermissionPolicy,
  acpSessionModes,
  resolveAcpStartMode,
} from '../src/acp-session-modes.js';

const tool = (name: string, capabilities: string[]): Tool =>
  ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    capabilities,
    execute: async () => ({ content: '' }),
  }) as unknown as Tool;

const write = tool('write', [ToolCapabilities.FS_WRITE]);
const bash = tool('bash', [ToolCapabilities.SHELL_ARBITRARY]);
const read = tool('read', [ToolCapabilities.FS_READ]);
// A real directory: auto-edit follows symlinks, so the root must exist.
const ROOT = mkdtempSync(path.join(tmpdir(), 'acp-modes-project-'));
const OUTSIDE = mkdtempSync(path.join(tmpdir(), 'acp-modes-outside-'));
afterAll(() => {
  for (const dir of [ROOT, OUTSIDE]) rmSync(dir, { recursive: true, force: true });
});
const ctx = {
  meta: {},
  session: { id: 's1' },
  cwd: ROOT,
  projectRoot: ROOT,
} as unknown as AgentContext;

function arbiterSaying(decision: PermissionDecision): PermissionPolicy {
  return { evaluate: vi.fn(async () => decision) } as unknown as PermissionPolicy;
}

function client(...answers: string[]) {
  const fn = vi.fn();
  for (const optionId of answers) fn.mockResolvedValueOnce({ outcome: 'selected', optionId });
  return fn;
}

describe('ACP session modes: start flags and advertised list', () => {
  it('offers default, plan, auto-edit and yolo, the start mode first', () => {
    expect(acpSessionModes().map((m) => m.id)).toEqual(['default', 'plan', 'auto-edit', 'yolo']);
    expect(acpSessionModes('yolo').map((m) => m.id)).toEqual([
      'yolo',
      'default',
      'plan',
      'auto-edit',
    ]);
    // Agora tells "acts without asking" modes from their names.
    const names = Object.fromEntries(acpSessionModes().map((m) => [m.id, m.name]));
    expect(names['auto-edit']).toMatch(/auto/i);
    expect(names['yolo']).toMatch(/yolo/i);
  });

  it('reads --yolo and --mode, and refuses an unknown or conflicting mode', () => {
    expect(resolveAcpStartMode({})).toEqual({ modeId: 'default' });
    expect(resolveAcpStartMode({ yolo: true })).toEqual({ modeId: 'yolo' });
    expect(resolveAcpStartMode({ mode: 'plan' })).toEqual({ modeId: 'plan' });
    expect(resolveAcpStartMode({ mode: 'yolo', yolo: true })).toEqual({ modeId: 'yolo' });
    expect(resolveAcpStartMode({ mode: 'bypass' })).toHaveProperty('error');
    expect(resolveAcpStartMode({ mode: 'plan', yolo: true })).toHaveProperty('error');
  });

  it('offers YOLO+ only after an explicit launch and rejects conflicting flags', () => {
    expect(acpSessionModes('yolo').some((mode) => mode.id === 'yolo-plus')).toBe(false);
    expect(resolveAcpStartMode({ 'yolo-plus': true })).toEqual({ modeId: 'yolo-plus' });
    expect(resolveAcpStartMode({ mode: 'yolo-plus' })).toEqual({ modeId: 'yolo-plus' });
    expect(resolveAcpStartMode({ yolo: true, 'yolo-plus': true })).toHaveProperty('error');
    expect(resolveAcpStartMode({ mode: 'yolo', 'yolo-plus': true })).toHaveProperty('error');
    expect(resolveAcpStartMode({ mode: 'yolo-plus', restricted: true })).toHaveProperty('error');
  });
});

describe('ACP session modes: permission decisions', () => {
  it('gives concurrent calls to the same tool distinct permission cards', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const ask = client('allow_once', 'reject_once');
    const policy = new ACPClientPermissionPolicy(ask);
    try {
      await Promise.all([
        policy.evaluate(write, { path: 'first.txt' }, ctx),
        policy.evaluate(write, { path: 'second.txt' }, ctx),
      ]);
      expect(ask).toHaveBeenCalledTimes(2);
      expect(new Set(ask.mock.calls.map(([request]) => request.toolCall.toolCallId)).size).toBe(2);
    } finally {
      now.mockRestore();
    }
  });
  it('plain YOLO keeps the guard even when the profile has YOLO+ enabled', async () => {
    const arbiter = createProjectPermissionPolicy({
      projectRoot: ROOT,
      trustFile: path.join(ROOT, 'trust.json'),
      config: { autonomy: { yoloPlus: true } } as never,
      permission: { yolo: true },
    })();
    let mode = 'yolo';
    const ask = client('reject_once');
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => mode, arbiter });
    const removal = { command: 'rm -rf /' };
    expect((await policy.evaluate(bash, removal, ctx)).permission).toBe('deny');
    expect(ask).toHaveBeenCalledTimes(1);
    mode = 'yolo-plus';
    expect(await policy.evaluate(bash, removal, ctx)).toMatchObject({
      permission: 'auto',
      allowAll: true,
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('rejects a permission option the server never offered', async () => {
    const policy = new ACPClientPermissionPolicy(client('allow_unknown'));
    expect((await policy.evaluate(write, { path: 'a.ts' }, ctx)).permission).toBe('deny');
  });
  it('plan refuses a write without asking, and still reads', async () => {
    const ask = vi.fn();
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => 'plan' });
    expect((await policy.evaluate(write, { path: 'a.ts' }, ctx)).permission).toBe('deny');
    expect((await policy.evaluate(read, { path: 'a.ts' }, ctx)).permission).toBe('auto');
    expect(
      (await policy.evaluate({ ...read, mutating: true }, { path: 'a.ts' }, ctx)).permission,
    ).toBe('deny');
    expect(ask).not.toHaveBeenCalled();
  });

  it('honors a tool-level refusal even without a project arbiter', async () => {
    const ask = vi.fn();
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => 'yolo-plus' });
    expect(
      await policy.evaluate({ ...read, permission: 'deny' }, { path: 'a.ts' }, ctx),
    ).toMatchObject({ permission: 'deny' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('yolo runs what the project policy approves and asks for what it still guards', async () => {
    let verdict: PermissionDecision = { permission: 'auto', source: 'yolo' };
    const arbiter = { evaluate: vi.fn(async () => verdict) } as unknown as PermissionPolicy;
    const ask = client('allow_once');
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => 'yolo', arbiter });
    expect(await policy.evaluate(bash, { command: 'ls' }, ctx)).toEqual({
      permission: 'auto',
      source: 'yolo',
    });
    expect(ask).not.toHaveBeenCalled();

    verdict = {
      permission: 'confirm',
      source: 'yolo_destructive',
      reason: 'filesystem-destructive needs explicit approval even in YOLO mode',
    };
    expect((await policy.evaluate(bash, { command: 'rm -rf build' }, ctx)).permission).toBe('auto');
    expect(ask).toHaveBeenCalledTimes(1);
    const options = ask.mock.calls[0]?.[0].options as Array<{ kind: string; name: string }>;
    expect(options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
    expect(options[1]?.name).toBe('Always allow this exact call in this session');
  });

  it('auto-edit writes unasked but asks before a shell command', async () => {
    const ask = client('reject_once');
    const policy = new ACPClientPermissionPolicy(ask, {
      mode: () => 'auto-edit',
      arbiter: arbiterSaying({ permission: 'auto', source: 'yolo' }),
    });
    expect((await policy.evaluate(write, { path: 'a.ts' }, ctx)).permission).toBe('auto');
    expect(ask).not.toHaveBeenCalled();
    expect((await policy.evaluate(bash, { command: 'npm test' }, ctx)).permission).toBe('deny');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('auto-edit asks for a write outside the project or without a readable target', async () => {
    const ask = client('reject_once', 'reject_once', 'reject_once');
    const policy = new ACPClientPermissionPolicy(ask, {
      mode: () => 'auto-edit',
      arbiter: arbiterSaying({ permission: 'auto', source: 'yolo' }),
    });
    await policy.evaluate(write, { path: '../elsewhere/a.ts' }, ctx);
    await policy.evaluate(write, { path: path.resolve(tmpdir(), 'other', 'a.ts') }, ctx);
    await policy.evaluate(write, { content: 'no target' }, ctx);
    expect(ask).toHaveBeenCalledTimes(3);
    await policy.evaluate(write, { edits: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }, ctx);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('auto-edit asks for a write through a link that leaves the project', async () => {
    mkdirSync(path.join(ROOT, 'src'), { recursive: true });
    // A junction needs no privilege on Windows; elsewhere it is a plain dir symlink.
    symlinkSync(OUTSIDE, path.join(ROOT, 'escape'), 'junction');
    // A dangling link: its outside target does not exist yet, so realpath fails on it.
    symlinkSync(path.join(OUTSIDE, 'not-yet'), path.join(ROOT, 'dangling'), 'junction');
    const ask = client('reject_once', 'reject_once');
    const policy = new ACPClientPermissionPolicy(ask, {
      mode: () => 'auto-edit',
      arbiter: arbiterSaying({ permission: 'auto', source: 'yolo' }),
    });
    await policy.evaluate(write, { path: 'escape/new/a.ts' }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    await policy.evaluate(write, { path: 'dangling/a.ts' }, ctx);
    expect(ask).toHaveBeenCalledTimes(2);
    expect((await policy.evaluate(write, { path: 'src/new/a.ts' }, ctx)).permission).toBe('auto');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('auto-edit asks for a write the project policy still guards', async () => {
    const ask = client('allow_once');
    const policy = new ACPClientPermissionPolicy(ask, {
      mode: () => 'auto-edit',
      arbiter: arbiterSaying({ permission: 'confirm', source: 'yolo_destructive' }),
    });
    await policy.evaluate(write, { path: '.wrongstack/config.json' }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('default asks and names the scope of "always" in the option', async () => {
    const ask = client('allow_always');
    const policy = new ACPClientPermissionPolicy(ask, {
      mode: () => 'default',
      arbiter: arbiterSaying({ permission: 'auto', source: 'yolo' }),
    });
    await policy.evaluate(write, { path: 'a.ts' }, ctx);
    await policy.evaluate(write, { path: 'b.ts' }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    const options = ask.mock.calls[0]?.[0].options as Array<{ name: string }>;
    expect(options[1]?.name).toBe('Always allow file edits (write) in this session');
    expect(options[3]?.name).toBe('Always reject write calls in this session');
  });

  it('a mode changed between calls governs the next call', async () => {
    let mode = 'default';
    const ask = client('allow_once');
    const policy = new ACPClientPermissionPolicy(ask, {
      mode: () => mode,
      arbiter: arbiterSaying({ permission: 'auto', source: 'yolo' }),
    });
    await policy.evaluate(bash, { command: 'ls' }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    mode = 'yolo';
    expect((await policy.evaluate(bash, { command: 'ls' }, ctx)).permission).toBe('auto');
    mode = 'plan';
    expect((await policy.evaluate(bash, { command: 'ls' }, ctx)).permission).toBe('deny');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('"always allow bash" does not cover a later call the project policy guards', async () => {
    let verdict: PermissionDecision = { permission: 'auto', source: 'yolo' };
    const arbiter = { evaluate: vi.fn(async () => verdict) } as unknown as PermissionPolicy;
    const ask = client('allow_always', 'allow_always');
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => 'default', arbiter });
    await policy.evaluate(bash, { command: 'ls' }, ctx);
    await policy.evaluate(bash, { command: 'pwd' }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);

    verdict = { permission: 'confirm', source: 'yolo_destructive' };
    await policy.evaluate(bash, { command: 'rm -rf build' }, ctx);
    expect(ask).toHaveBeenCalledTimes(2);
    // "Always" on the guarded prompt covers that exact call only.
    await policy.evaluate(bash, { command: 'rm -rf build' }, ctx);
    expect(ask).toHaveBeenCalledTimes(2);
    await policy.evaluate(bash, { command: 'rm -rf dist' }, ctx);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('a refusal by the project policy is final in every mode', async () => {
    const ask = vi.fn();
    const policy = new ACPClientPermissionPolicy(ask, {
      mode: () => 'yolo',
      arbiter: arbiterSaying({
        permission: 'deny',
        source: 'default',
        reason: 'tool default deny',
      }),
    });
    expect((await policy.evaluate(bash, { command: 'ls' }, ctx)).permission).toBe('deny');
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('ACP yolo mode against the real project policy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('runs a harmless command unasked and asks before rm -rf', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acp-yolo-'));
    dirs.push(dir);
    const arbiter = createProjectPermissionPolicy({
      projectRoot: dir,
      trustFile: path.join(dir, 'trust.json'),
      config: {} as never,
      permission: { yolo: true },
    })();
    const ask = client('reject_once');
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => 'yolo', arbiter });
    const realCtx = { meta: {}, cwd: dir, projectRoot: dir, session: { id: 's1' } } as never;
    expect((await policy.evaluate(bash, { command: 'echo hi' }, realCtx)).permission).toBe('auto');
    expect(ask).not.toHaveBeenCalled();
    expect((await policy.evaluate(bash, { command: 'rm -rf /' }, realCtx)).permission).toBe('deny');
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
