/**
 * The seam the unit tests do not cover: a click in the WebUI settings menu has
 * to reach the LIVE permission policy AND the persisted config, and the two
 * must agree. Each half was covered on its own; nothing checked that the wire
 * format the browser sends survives validation, lands on the policy, and comes
 * back in the snapshot the next page load reads.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_DESTRUCTIVE_KINDS,
  DefaultPermissionPolicy,
  LOCKED_DESTRUCTIVE_KINDS,
  resolveYoloConfirmKinds,
} from '@wrongstack/core/security';
import type { Config } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { seedContextMeta } from '../src/server/context-meta.js';
import { handlePrefsUpdate, type PrefsHandlerContext } from '../src/server/prefs-handlers.js';
import { validatePrefsUpdatePayload } from '../src/server/ws-payload-preferences.js';

const ws = {} as WebSocket;
let trustFile: string;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-yolo-confirm-'));
  trustFile = path.join(tmpDir, 'trust.json');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** The exact payload the settings list sends: the whole map, never one key. */
function menuPayload(off: string[]): Record<string, boolean> {
  return Object.fromEntries(ALL_DESTRUCTIVE_KINDS.map((k) => [k, !off.includes(k)]));
}

function makeContext(policy: DefaultPermissionPolicy) {
  const meta: Record<string, unknown> = {};
  const context: PrefsHandlerContext = {
    meta,
    snapshot: () => ({ ...meta }),
    persist: vi.fn(async () => {}),
    pendingConfirms: new Map(),
    setYoloConfirm: (preference: Record<string, boolean>) =>
      policy.setYoloConfirmKinds(resolveYoloConfirmKinds(preference)),
    send: () => {},
    broadcast: () => {},
  } as unknown as PrefsHandlerContext;
  return context;
}

const shellTool = {
  name: 'bash',
  permission: 'confirm',
  capabilities: ['shell.arbitrary'],
} as never;

const ctx = { projectRoot: tmpDirRef(), cwd: tmpDirRef(), workingDir: tmpDirRef() } as never;
function tmpDirRef(): string {
  return process.cwd();
}

describe('WebUI yoloConfirm — click to enforced decision', () => {
  it('accepts the menu payload through validation', () => {
    const result = validatePrefsUpdatePayload({ yoloConfirm: menuPayload(['git-history']) });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-boolean map rather than half-applying it', () => {
    const result = validatePrefsUpdatePayload({ yoloConfirm: { 'git-history': 'off' } });
    expect(result.ok).toBe(false);
  });

  it('turning a kind off in the menu makes the very next call run unattended', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });
    // Before: gated.
    const before = await policy.evaluate(shellTool, { command: 'git reset --hard' }, ctx);
    expect(before.permission).toBe('confirm');
    expect(before.reason).toContain('git-history');

    await handlePrefsUpdate(makeContext(policy), ws, {
      yoloConfirm: menuPayload(['git-history']),
    });

    // After: the SAME policy instance decides differently — no restart.
    const after = await policy.evaluate(shellTool, { command: 'git reset --hard' }, ctx);
    expect(after.permission).toBe('auto');
    // And only that kind moved.
    expect((await policy.evaluate(shellTool, { command: 'rm -rf /' }, ctx)).permission).toBe(
      'confirm',
    );
  });

  it('a menu payload that tries to un-gate a locked kind does not', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });
    await handlePrefsUpdate(makeContext(policy), ws, {
      yoloConfirm: menuPayload([...ALL_DESTRUCTIVE_KINDS]),
    });
    for (const locked of LOCKED_DESTRUCTIVE_KINDS) {
      expect(policy.getYoloConfirmKinds().has(locked)).toBe(true);
    }
  });

  it('the next page load reads back the RESOLVED map, not the raw config', () => {
    // A config that names only some kinds, plus a false against a locked one.
    const config = {
      autonomy: { yoloConfirm: { 'git-history': false, 'agent-state': false } },
    } as unknown as Config;
    const context = { meta: {} as Record<string, unknown> };
    seedContextMeta(config, context);

    const published = context.meta['yoloConfirm'] as Record<string, boolean>;
    expect(published['git-history']).toBe(false);
    // Locked kind: the menu must show it as asking, because the policy gates it.
    expect(published['agent-state']).toBe(true);
    // Unmentioned kind: fail-closed.
    expect(published['publish']).toBe(true);
    // Every kind is present, so the menu never renders a blank row.
    expect(Object.keys(published).sort()).toEqual([...ALL_DESTRUCTIVE_KINDS].sort());
  });
});
