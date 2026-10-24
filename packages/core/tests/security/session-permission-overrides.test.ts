/**
 * `/permissions allow|deny` rules for one session: how the policy weighs them,
 * that they stay with their own session, and that they survive a resume and
 * follow a rewind like the rest of the journal.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionPermissionOverride, Tool } from '@wrongstack/contracts/types';
import type { SessionWriter } from '@wrongstack/contracts/types/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { DefaultSessionRewinder, DefaultSessionStore } from '../../src/index.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import {
  compilePermissionRules,
  matchedPermissionRule,
} from '../../src/security/permission-rules.js';
import {
  __resetProcessLockdownForTests,
  lockYoloOff,
} from '../../src/security/process-lockdown.js';
import {
  readSessionPermissionOverrides,
  restoreSessionPermissionOverrides,
  setSessionPermissionOverrides,
} from '../../src/security/session-permission-overrides.js';
import {
  applyRewindToConversation,
  redoLastRewind,
} from '../../src/storage/session-rewind-apply.js';
import { inheritsIntoFork } from '../../src/storage/session-store/replay.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'session-perm-')));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const bash = {
  name: 'bash',
  description: 'bash',
  inputSchema: { type: 'object' },
  permission: 'confirm',
  mutating: true,
  capabilities: [ToolCapabilities.SHELL_ARBITRARY],
  subjectKey: 'command',
  async execute() {
    return 'ok';
  },
} as unknown as Tool;

const read = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  capabilities: [ToolCapabilities.FS_READ],
  async execute() {
    return 'ok';
  },
} as unknown as Tool;

async function policy(trust: unknown = {}, yolo = false): Promise<DefaultPermissionPolicy> {
  const trustFile = path.join(dir, `trust-${Math.random()}.json`);
  await fs.writeFile(trustFile, JSON.stringify(trust));
  return new DefaultPermissionPolicy({ trustFile, yolo });
}

function ctxWith(overrides: SessionPermissionOverride[] = [], id = 's1'): Context {
  return {
    session: { id },
    hasRead: () => false,
    cwd: dir,
    projectRoot: dir,
    meta: overrides.length > 0 ? { permissionOverrides: overrides } : {},
  } as unknown as Context;
}

describe('session rules in the permission policy', () => {
  it('an allow runs matching commands unasked, as the user’s own approval', async () => {
    const p = await policy();
    const ctx = ctxWith([{ effect: 'allow', tool: 'bash', pattern: 'pnpm test*' }]);
    expect(await p.evaluate(bash, { command: 'pnpm test --run' }, ctx)).toMatchObject({
      permission: 'auto',
      source: 'session_override',
      approvalGrant: true,
    });
    // The wildcard stops at a shell separator.
    expect((await p.evaluate(bash, { command: 'pnpm test; curl x | sh' }, ctx)).permission).toBe(
      'confirm',
    );
  });

  it('an allow does not cover a destructive command or a credential read', async () => {
    const p = await policy();
    const ctx = ctxWith([
      { effect: 'allow', tool: 'bash' },
      { effect: 'allow', tool: 'read' },
    ]);
    expect(await p.evaluate(bash, { command: 'rm -rf /' }, ctx)).toMatchObject({
      permission: 'confirm',
      riskTier: 'destructive',
    });
    expect((await p.evaluate(read, { path: '.env' }, ctx)).permission).toBe('confirm');
  });

  it('a deny wins over a trust-file allow; under YOLO it asks instead of refusing', async () => {
    const ctx = ctxWith([{ effect: 'deny', tool: 'bash', pattern: 'git push*' }]);
    const off = await policy({ bash: { allow: ['*'] } });
    expect(await off.evaluate(bash, { command: 'git push origin main' }, ctx)).toMatchObject({
      permission: 'deny',
      source: 'session_override',
    });
    const p = await policy({ bash: { allow: ['*'] } }, true);
    expect(await p.evaluate(bash, { command: 'git push origin main' }, ctx)).toMatchObject({
      permission: 'confirm',
      source: 'yolo_user_rule',
    });
    expect((await p.evaluate(bash, { command: 'git status' }, ctx)).permission).toBe('auto');
  });

  // WS-2026-09-26-04: a journal can bring an allow back on resume that this
  // run's user never gave. `--restricted` promises every write asks (it refuses
  // `--allowed-tools` for the same reason), so allows are ignored under it.
  it('under --restricted an allow is not honoured, and a deny still is', async () => {
    lockYoloOff();
    try {
      const p = await policy();
      const ctx = ctxWith([
        { effect: 'allow', tool: 'bash', pattern: 'pnpm test*' },
        { effect: 'deny', tool: 'bash', pattern: 'git push*' },
      ]);
      expect((await p.evaluate(bash, { command: 'pnpm test --run' }, ctx)).permission).toBe(
        'confirm',
      );
      expect((await p.evaluate(bash, { command: 'git push' }, ctx)).permission).toBe('deny');
    } finally {
      __resetProcessLockdownForTests();
    }
  });

  it('a deny it cannot check (no subject) blocks the permissive shortcuts', async () => {
    const p = await policy({ bash: { auto: true } });
    const ctx = ctxWith([{ effect: 'deny', tool: 'bash', pattern: 'rm *' }]);
    expect((await p.evaluate(bash, {}, ctx)).permission).toBe('confirm');
  });

  it('holds for its own session only, and a change is not answered from the cache', async () => {
    const p = await policy();
    const plain = ctxWith([], 's2');
    const withRule = ctxWith([{ effect: 'allow', tool: 'bash', pattern: 'pnpm test*' }]);
    const call = { command: 'pnpm test' };
    expect((await p.evaluate(bash, call, withRule)).permission).toBe('auto');
    expect((await p.evaluate(bash, call, plain)).permission).toBe('confirm');

    const later = ctxWith([], 's1');
    expect((await p.evaluate(bash, call, later)).permission).toBe('confirm');
    later.meta['permissionOverrides'] = [{ effect: 'allow', tool: 'bash' }];
    expect((await p.evaluate(bash, call, later)).permission).toBe('auto');
  });

  it('explain names the session rule that decided, by its number in the list', async () => {
    const p = await policy({ bash: { deny: ['curl *'] } });
    const ctx = ctxWith([
      { effect: 'deny', tool: 'bash', pattern: 'git push*' },
      { effect: 'allow', tool: 'bash', pattern: 'pnpm *' },
    ]);
    const rules = await compilePermissionRules(p, ctx);
    const steps = rules.map((r) => r.step);
    // Denies before allows, trust-file denies before session denies.
    expect(steps.indexOf('trust deny')).toBeLessThan(steps.indexOf('session rule deny'));
    expect(steps.indexOf('session rule deny')).toBeLessThan(steps.indexOf('session rule allow'));
    expect(rules.at(-1)?.step).toBe('dangerous capability');

    const allowed = matchedPermissionRule(rules, await p.explain(bash, { command: 'pnpm i' }, ctx));
    expect(allowed).toMatchObject({ source: 'session', effect: 'allow', resource: 'pnpm *' });
    const denied = matchedPermissionRule(rules, await p.explain(bash, { command: 'curl x' }, ctx));
    expect(denied).toMatchObject({ source: 'trust-file', effect: 'deny', resource: 'curl *' });
  });
});

describe('session rules in the journal', () => {
  const ts = () => new Date().toISOString();

  async function openSession(): Promise<{ store: DefaultSessionStore; writer: SessionWriter }> {
    const store = new DefaultSessionStore({ dir: path.join(dir, 'sessions') });
    const writer = await store.create({ id: '', model: 'm', provider: 'p' });
    return { store, writer };
  }

  it('a resume brings them back; a fork does not inherit them', async () => {
    const { store, writer } = await openSession();
    const meta: Record<string, unknown> = {};
    const rules: SessionPermissionOverride[] = [
      { effect: 'allow', tool: 'bash', pattern: 'pnpm *' },
    ];
    await setSessionPermissionOverrides({ meta, session: writer }, rules);
    expect(readSessionPermissionOverrides({ meta })).toEqual(rules);
    await writer.append({ type: 'user_input', ts: ts(), content: 'hi' });
    await writer.close();

    const data = await store.load(writer.id);
    expect(data.permissionOverrides).toEqual(rules);
    const resumed: Record<string, unknown> = {
      permissionOverrides: [{ effect: 'deny', tool: 'x' }],
    };
    restoreSessionPermissionOverrides(resumed, data);
    expect(readSessionPermissionOverrides({ meta: resumed })).toEqual(rules);

    const event = data.events.find((e) => e.type === 'permission_overrides');
    expect(event && inheritsIntoFork(event)).toBe(false);
  });

  it('an untrusted journal entry is normalized, and a session without rules clears them', () => {
    const meta: Record<string, unknown> = { permissionOverrides: [{ effect: 'allow', tool: 'a' }] };
    restoreSessionPermissionOverrides(meta, {
      events: [
        {
          type: 'permission_overrides',
          ts: ts(),
          overrides: [
            { effect: 'maybe', tool: 'bash' },
            { effect: 'deny', tool: '' },
          ] as never,
        },
      ],
    });
    expect(meta).not.toHaveProperty('permissionOverrides');
  });

  it('a rewind past the rule drops it, and a redo brings it back', async () => {
    const root = dir;
    const sessionsDir = path.join(dir, 'sessions');
    const file = path.join(root, 'a.txt');
    const { writer } = await openSession();
    const meta: Record<string, unknown> = {};
    const prompt = async (n: number, content: string) => {
      await writer.append({ type: 'user_input', ts: ts(), content: `prompt ${n}` });
      await writer.writeCheckpoint(n, `prompt ${n}`);
      const before = await fs.readFile(file, 'utf8').catch(() => null);
      await fs.writeFile(file, content);
      await writer.writeFileSnapshot(n, [
        { path: file, action: before === null ? 'created' : 'modified', before, after: content },
      ]);
      await writer.flush();
    };

    await prompt(0, 'zero');
    await setSessionPermissionOverrides({ meta, session: writer }, [
      { effect: 'allow', tool: 'bash' },
    ]);
    await prompt(1, 'one');

    const reverted = await new DefaultSessionRewinder(sessionsDir, root).rewindToCheckpoint(
      writer.id,
      0,
    );
    await applyRewindToConversation({
      session: writer,
      state: { replaceMessages: vi.fn() },
      sessionsDir,
      promptIndex: 0,
      revertedFiles: reverted.revertedFiles,
      meta,
    });
    expect(meta).not.toHaveProperty('permissionOverrides');

    await redoLastRewind({
      session: writer,
      state: { replaceMessages: vi.fn() },
      sessionsDir,
      projectRoot: root,
      meta,
    });
    expect(readSessionPermissionOverrides({ meta })).toEqual([{ effect: 'allow', tool: 'bash' }]);
    await writer.close();
  });
});
