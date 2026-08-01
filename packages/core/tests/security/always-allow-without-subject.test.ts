/**
 * WS-046 — "always allow" was a permanent silent no-op for subject-less tools.
 *
 * A stored trust pattern is only ever consulted as
 *
 *     entry.allow && subject && matchesTrust(entry.allow, subject)
 *
 * When a tool produces no subject — no `subjectKey`, and no `path`/`url`/`name`
 * in its input, which describes `exec`, `git`, `install`, `patch` and most
 * other mutating tools — that condition can never be true. The prompt path
 * nonetheless called `trust({ pattern: subject ?? tool.name })`, writing an
 * entry that was dead the moment it was saved.
 *
 * The damage is behavioural rather than a direct bypass. The user picks "always
 * allow", is asked again on the very next identical call, concludes trust rules
 * do not work, and reaches for the one thing that does: a blanket
 * `{"exec": {"auto": true}}`. A silent no-op does not merely fail to help — it
 * trains people into the widest grant the system offers.
 *
 * The real cure is giving these tools a subject (WS-046b). This is the safety
 * net for whatever still has none: refuse the option and say why.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alwaysAllowUnavailableReason,
  DefaultPermissionPolicy,
} from '../../src/security/permission-policy.js';
import type { Context, Tool } from '../../src/types/index.js';

function tool(name: string, subjectKey?: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission: 'confirm',
    mutating: true,
    ...(subjectKey ? { subjectKey } : {}),
    async execute() {
      return 'ok';
    },
  };
}

let trustFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-always-'));
  trustFile = path.join(dir, 'trust.json');
});
afterEach(async () => {
  await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
});

async function storedTrust(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(trustFile, 'utf8'));
  } catch {
    return {};
  }
}

describe('alwaysAllowUnavailableReason (WS-046)', () => {
  it('reports a reason exactly when the call carries no subject', () => {
    // `exec` is the finding's named example: `command` is not picked up
    // (only `bash` gets that fallback) and there is no path/url/name.
    expect(alwaysAllowUnavailableReason(tool('exec'), { command: 'ls', cwd: '.' })).toBeDefined();
    expect(alwaysAllowUnavailableReason(tool('git'), { command: 'status' })).toBeDefined();
    // Tools that do produce a subject are unaffected.
    expect(alwaysAllowUnavailableReason(tool('edit'), { path: 'a.ts' })).toBeUndefined();
    expect(alwaysAllowUnavailableReason(tool('bash'), { command: 'ls' })).toBeUndefined();
    expect(
      alwaysAllowUnavailableReason(tool('exec', 'command'), { command: 'ls' }),
    ).toBeUndefined();
  });

  it('names the tool and explains the remedy, not just the refusal', () => {
    const reason = alwaysAllowUnavailableReason(tool('exec'), { command: 'ls' })!;
    expect(reason).toContain('exec');
    expect(reason).toContain('never match');
  });
});

describe('policy refuses to store an unmatched always-rule (WS-046)', () => {
  it('does not write a trust entry when there is no subject', async () => {
    const promptDelegate = vi.fn().mockResolvedValue('always');
    const p = new DefaultPermissionPolicy({ trustFile, promptDelegate });

    const decision = await p.evaluate(tool('exec'), { command: 'ls', cwd: '.' }, {} as Context);

    // The call is approved — the user did say yes.
    expect(decision.permission).toBe('auto');
    // …but nothing was persisted, and the decision says why.
    expect(await storedTrust()).toEqual({});
    expect(decision.reason).toContain('approved once');
  });

  it('the pre-fix entry would have been unmatchable — prove it', async () => {
    // Write by hand exactly what the old code stored (`pattern: tool.name`)
    // and confirm the next identical call is NOT auto-approved. This is the
    // assertion that makes the no-op concrete rather than asserted.
    await fs.writeFile(trustFile, JSON.stringify({ exec: { allow: ['exec'] } }), 'utf8');
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('exec'), { command: 'ls' }, {} as Context);
    expect(decision.permission).not.toBe('auto');
  });

  it('still stores a real rule when a subject exists', async () => {
    const promptDelegate = vi.fn().mockResolvedValue('always');
    const p = new DefaultPermissionPolicy({ trustFile, promptDelegate });

    const decision = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);

    expect(decision.permission).toBe('auto');
    expect(await storedTrust()).toEqual({ edit: { allow: ['src/a.ts'] } });
  });

  it('a stored subject rule actually re-matches on the next call', async () => {
    // The other half: "always" must genuinely stop the prompting it promises.
    const promptDelegate = vi.fn().mockResolvedValue('always');
    const p = new DefaultPermissionPolicy({ trustFile, promptDelegate });
    await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);

    const fresh = new DefaultPermissionPolicy({ trustFile });
    const again = await fresh.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(again.permission).toBe('auto');
    expect(again.source).toBe('trust');
  });

  it('leaves "yes" and "deny" behaviour unchanged for subject-less tools', async () => {
    const yes = new DefaultPermissionPolicy({
      trustFile,
      promptDelegate: vi.fn().mockResolvedValue('yes'),
    });
    expect((await yes.evaluate(tool('exec'), { command: 'ls' }, {} as Context)).permission).toBe(
      'auto',
    );

    const denied = new DefaultPermissionPolicy({
      trustFile,
      promptDelegate: vi.fn().mockResolvedValue('deny'),
    });
    expect((await denied.evaluate(tool('exec'), { command: 'ls' }, {} as Context)).permission).toBe(
      'deny',
    );
  });
});
