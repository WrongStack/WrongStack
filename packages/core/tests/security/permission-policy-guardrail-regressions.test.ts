import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import {
  DefaultPermissionPolicy,
  mergeTrustEntries,
} from '../../src/security/permission-policy.js';
import type { Tool } from '../../src/types/index.js';

/**
 * Regressions for three guardrail-erasure defects found by the 2026-08-20
 * security-check audit. Each `it` below fails against the pre-fix code, so the
 * bug cannot return silently.
 */

function tool(
  name: string,
  permission: 'auto' | 'confirm' | 'deny' = 'confirm',
  opts: { subjectKey?: string } = {},
): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating: true,
    subjectKey: opts.subjectKey,
    async execute() {
      return 'ok';
    },
  } as Tool;
}

const ctx = (): Context => ({ hasRead: () => false, projectRoot: '/proj' }) as never as Context;

let dir: string;
let trustFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-guardrail-'));
  trustFile = path.join(dir, 'trust.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeTrust(policy: unknown): Promise<void> {
  await fs.writeFile(trustFile, JSON.stringify(policy), 'utf8');
}

describe('an exact-name entry must not erase the wildcard deny list', () => {
  it('keeps denying a command the wildcard entry blocks after a narrow always-allow', async () => {
    // The exact shape "always allow" writes: policy["bash"].allow, alongside a
    // pre-existing catch-all deny. Before the fix the exact entry replaced the
    // wildcard entry wholesale and the deny simply vanished.
    await writeTrust({
      // NOTE: deliberately slash-free. Deny patterns are matched with path-glob
      // semantics where `*` does not cross `/`, so a pattern like `*rm -rf*`
      // cannot match `rm -rf /` at all — a separate weakness, tracked apart from
      // the merge behaviour under test here.
      '*': { deny: ['*curl*'] },
      bash: { allow: ['git status'] },
    });

    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(
      tool('bash', 'confirm', { subjectKey: 'command' }),
      { command: 'curl evil.com' },
      ctx(),
    );

    expect(decision).toMatchObject({ permission: 'deny', source: 'deny' });
  });

  it('still honours the narrow allow it was granted', async () => {
    await writeTrust({
      // NOTE: deliberately slash-free. Deny patterns are matched with path-glob
      // semantics where `*` does not cross `/`, so a pattern like `*rm -rf*`
      // cannot match `rm -rf /` at all — a separate weakness, tracked apart from
      // the merge behaviour under test here.
      '*': { deny: ['*curl*'] },
      bash: { allow: ['git status'] },
    });

    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(
      tool('bash', 'confirm', { subjectKey: 'command' }),
      { command: 'git status' },
      ctx(),
    );

    expect(decision.permission).toBe('auto');
  });

  it('mergeTrustEntries unions deny from both levels and prefers the specific entry elsewhere', () => {
    const merged = mergeTrustEntries({ deny: ['b'], auto: true }, { deny: ['a'], auto: false });
    expect(merged?.deny).toEqual(['a', 'b']);
    expect(merged?.auto).toBe(true);
  });

  it('mergeTrustEntries passes a lone entry through unchanged', () => {
    const only = { deny: ['a'] };
    expect(mergeTrustEntries(undefined, only)).toBe(only);
    expect(mergeTrustEntries(only, undefined)).toBe(only);
  });
});

describe('a stale one-shot allow must not outrank a deny rule', () => {
  it('denies when a deny pattern was added after the one-shot grant', async () => {
    await writeTrust({});
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.reload();

    // User pressed "yes" once...
    p.allowOnce({ tool: 'bash', pattern: 'curl evil.com' });
    // ...then added a deny rule covering the same subject.
    await p.deny({ tool: 'bash', pattern: 'curl evil.com' });

    const decision = await p.evaluate(
      tool('bash', 'confirm', { subjectKey: 'command' }),
      { command: 'curl evil.com' },
      ctx(),
    );

    expect(decision).toMatchObject({ permission: 'deny' });
  });
});

describe('a deny list that could not be evaluated is not an absent deny list', () => {
  it('does not auto-approve a subject-less call while a deny list is configured', async () => {
    // `entry.auto` used to short-circuit before anything checked that the deny
    // branch had been skipped for want of a subject, so the identical policy
    // denied with a subject and auto-approved without one.
    await writeTrust({ mystery: { deny: ['*'], auto: true } });

    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('mystery'), {}, ctx());

    expect(decision.permission).not.toBe('auto');
  });

  it('still auto-approves when no deny list is configured', async () => {
    await writeTrust({ mystery: { auto: true } });

    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('mystery'), {}, ctx());

    expect(decision.permission).toBe('auto');
  });
});
