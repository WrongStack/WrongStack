/**
 * YOLO+ — the user has allowed everything: no call ever asks. What the user
 * wrote down as a refusal still refuses; everything that would only have
 * asked — the destructive kinds, the locked ones, sensitive reads — runs.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { AutoApprovePermissionPolicy } from '../../src/security/auto-approve-policy.js';
import { DirectoryPermissionPolicy } from '../../src/security/directory-permission-policy.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import {
  __resetProcessLockdownForTests,
  lockYoloOff,
} from '../../src/security/process-lockdown.js';
import { userRuleAnswer } from '../../src/security/scoped-approval.js';
import { wstackGlobalRoot } from '../../src/utils/wstack-paths.js';

function tool(
  name: string,
  permission: 'auto' | 'confirm' | 'deny' = 'confirm',
  extra: Partial<Tool> = {},
): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating: true,
    async execute() {
      return 'ok';
    },
    ...extra,
  } as Tool;
}

const bash = () =>
  tool('bash', 'confirm', { capabilities: ['shell.arbitrary'], subjectKey: 'command' });
const write = () => tool('write', 'confirm', { capabilities: ['fs.write'] });
const read = () => tool('read', 'auto', { capabilities: ['fs.read'], mutating: false });

const ctx = (meta: Record<string, unknown> = {}): Context =>
  ({ hasRead: () => false, projectRoot: '/proj', cwd: '/proj', meta }) as never as Context;

/** One example per call that YOLO alone still asks about. */
const askedUnderYolo: Array<[string, () => Tool, unknown]> = [
  ['a disk wipe', bash, { command: 'rm -rf /' }],
  ['a history rewrite', bash, { command: 'git push --force origin main' }],
  ['an agent-state write (locked)', write, { path: path.join(wstackGlobalRoot(), 'trust.json') }],
  ['a sensitive read', read, { path: path.join(os.homedir(), '.aws', 'credentials') }],
];

let dir: string;
let trustFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-plus-'));
  trustFile = path.join(dir, 'trust.json');
});
afterEach(async () => {
  __resetProcessLockdownForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('leader policy under YOLO+', () => {
  it.each(askedUnderYolo.filter(([name]) => name !== 'a sensitive read'))(
    'YOLO alone does not run %s unattended',
    async (_n, mk, input) => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      expect((await p.evaluate(mk(), input, ctx())).permission).not.toBe('auto');
    },
  );

  it.each(askedUnderYolo)('YOLO+ runs %s without asking', async (_n, mk, input) => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
    const decision = await p.evaluate(mk(), input, ctx());
    expect(decision).toMatchObject({ permission: 'auto', source: 'yolo', allowAll: true });
  });

  it('turning YOLO+ on turns YOLO on', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    p.setYoloPlus(true);
    expect(p.getYolo()).toBe(true);
    expect(p.getYoloPlus()).toBe(true);
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, ctx())).permission).toBe('auto');
  });

  it('never outlives YOLO: YOLO off asks again, whatever the flag says', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
    p.setYolo(false);
    expect(p.getYoloPlus()).toBe(false);
    const decision = await p.evaluate(bash(), { command: 'rm -rf /' }, ctx());
    expect(decision.permission).toBe('confirm');
  });

  it('is per conversation: one tab’s YOLO+ does not reach another', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const input = { command: 'rm -rf /' };
    expect((await p.evaluate(bash(), input, ctx({ yolo: true, yoloPlus: true }))).permission).toBe(
      'auto',
    );
    // Same call, other tab: the cached YOLO+ answer must not be replayed.
    expect((await p.evaluate(bash(), input, ctx({ yolo: true }))).permission).toBe('confirm');
    // A tab with YOLO off and a stale YOLO+ flag still asks.
    expect((await p.evaluate(bash(), input, ctx({ yolo: false, yoloPlus: true }))).permission).toBe(
      'confirm',
    );
  });

  it('--restricted locks it off like YOLO', async () => {
    lockYoloOff();
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
    expect(p.getYoloPlus()).toBe(false);
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, ctx())).permission).not.toBe('auto');
  });

  describe('what the user wrote as a refusal still refuses', () => {
    it('a trust-file deny rule', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['rm -rf /'] } }));
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
      const decision = await p.evaluate(bash(), { command: 'rm -rf /' }, ctx());
      expect(decision).toMatchObject({ permission: 'deny', source: 'deny' });
    });

    it('a "no" given earlier this session', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
      await p.reload(); // the first evaluate would otherwise reload and clear the soft set
      p.denyOnce({ tool: 'bash', pattern: 'rm -rf /' });
      expect((await p.evaluate(bash(), { command: 'rm -rf /' }, ctx())).permission).toBe('deny');
    });

    it('a deny list it cannot check for this call (no subject) refuses instead of allowing', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['rm -rf /'] } }));
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
      // No `command`, so there is no subject to match the deny list against.
      const decision = await p.evaluate(bash(), { script: 'rm -rf /' }, ctx());
      expect(decision).toMatchObject({ permission: 'deny', source: 'deny' });
      const trace = await p.explain(bash(), { script: 'rm -rf /' }, ctx());
      expect(trace.decision.permission).toBe('deny');
      expect(trace.steps[trace.winnerIndex]?.rule).toBe('yolo+');
      // Without a deny list for the tool there is nothing to honour: it runs.
      const free = new DefaultPermissionPolicy({
        trustFile: path.join(dir, 'empty.json'),
        yolo: true,
        yoloPlus: true,
      });
      expect((await free.evaluate(bash(), { script: 'x' }, ctx())).permission).toBe('auto');
    });

    it('a tool that is deny by default', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
      expect((await p.evaluate(tool('nuke', 'deny'), {}, ctx())).permission).toBe('deny');
    });
  });

  it('explain() reports the same verdict as evaluate()', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloPlus: true });
    const trace = await p.explain(bash(), { command: 'rm -rf /' }, ctx());
    expect(trace.decision).toMatchObject({ permission: 'auto', allowAll: true });
    expect(trace.steps[trace.winnerIndex]?.rule).toBe('yolo+');
  });
});

describe('subagent policy under YOLO+', () => {
  const subCtx = { projectRoot: '/proj', cwd: '/proj' } as never;
  const caps = ['fs.read', 'fs.write', 'shell.arbitrary'];

  it('refuses what the leader would ask about, without YOLO+', async () => {
    const p = new AutoApprovePermissionPolicy(caps, { trustFile: '' });
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, subCtx)).permission).toBe('deny');
  });

  it('runs it with YOLO+, read live on every call', async () => {
    let on = true;
    const p = new AutoApprovePermissionPolicy(caps, { trustFile: '', yoloPlus: () => on });
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, subCtx)).permission).toBe('auto');
    const target = path.join(wstackGlobalRoot(), 'trust.json');
    expect((await p.evaluate(write(), { path: target }, subCtx)).permission).toBe('auto');
    on = false;
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, subCtx)).permission).toBe('deny');
  });

  it('keeps the role tool allowlist and the user deny rules', async () => {
    const readOnly = new AutoApprovePermissionPolicy(['fs.read'], {
      trustFile: '',
      yoloPlus: () => true,
    });
    expect((await readOnly.evaluate(bash(), { command: 'ls' }, subCtx)).permission).toBe('deny');

    await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['rm -rf /'] } }));
    const denied = new AutoApprovePermissionPolicy(caps, { trustFile, yoloPlus: () => true });
    expect((await denied.evaluate(bash(), { command: 'rm -rf /' }, subCtx)).permission).toBe(
      'deny',
    );
  });

  it('--restricted locks it off for subagents too', async () => {
    lockYoloOff();
    const p = new AutoApprovePermissionPolicy(caps, { trustFile: '', yoloPlus: () => true });
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, subCtx)).permission).toBe('deny');
  });
});

/**
 * YOLO runs without interrupting, but stops on what the user forbade — and
 * stopping means ASKING, so the user decides that one call. YOLO+ asks
 * nothing: the user's own refusals refuse. With YOLO off they refuse too.
 */
describe('what the user forbade, at each YOLO level', () => {
  type Level = 'off' | 'yolo' | 'plus';
  const make = (level: Level, file = trustFile) =>
    new DefaultPermissionPolicy({
      trustFile: file,
      yolo: level !== 'off',
      yoloPlus: level === 'plus',
    });
  const expected: Record<Level, 'deny' | 'confirm'> = {
    off: 'deny',
    yolo: 'confirm',
    plus: 'deny',
  };

  async function verdicts(
    setup: (p: DefaultPermissionPolicy) => Promise<void> | void,
    t: Tool,
    input: unknown,
    c: () => Context = () => ctx(),
  ) {
    for (const level of ['off', 'yolo', 'plus'] as const) {
      const p = make(level);
      await p.reload();
      await setup(p);
      const decision = await p.evaluate(t, input, c());
      expect(decision.permission, level).toBe(expected[level]);
      if (level === 'yolo') {
        // Destructive tier: a host auto-answering prompts when YOLO turns on
        // must leave this one for the user.
        expect(decision).toMatchObject({ source: 'yolo_user_rule', riskTier: 'destructive' });
      }
      // explain() gives the same verdict, from the same step.
      const trace = await p.explain(t, input, c());
      expect(trace.decision.permission, `explain ${level}`).toBe(decision.permission);
      expect(trace.steps[trace.winnerIndex]?.decision, `explain step ${level}`).toBe(
        decision.permission,
      );
    }
  }

  it('a trust-file deny rule', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['rm -rf /'] } }));
    await verdicts(() => {}, bash(), { command: 'rm -rf /' });
  });

  it('a "no" given earlier this session', async () => {
    await verdicts((p) => p.denyOnce({ tool: 'bash', pattern: 'ls' }), bash(), { command: 'ls' });
  });

  it('a /permissions deny rule', async () => {
    await verdicts(
      () => {},
      bash(),
      { command: 'git push' },
      () => ctx({ permissionOverrides: [{ effect: 'deny', tool: 'bash', pattern: 'git push*' }] }),
    );
  });

  it('a deny list it cannot check for this call', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['rm -rf /'] } }));
    for (const level of ['yolo', 'plus'] as const) {
      const p = make(level);
      const decision = await p.evaluate(bash(), { script: 'rm -rf /' }, ctx());
      expect(decision.permission, level).toBe(expected[level]);
      expect((await p.explain(bash(), { script: 'rm -rf /' }, ctx())).decision.permission).toBe(
        expected[level],
      );
    }
  });

  it('a "yes" to the YOLO question does not stick: the next call asks again', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['rm -rf /'] } }));
    const p = make('yolo');
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, ctx())).permission).toBe('confirm');
    expect((await p.evaluate(bash(), { command: 'rm -rf /' }, ctx())).permission).toBe('confirm');
  });

  it('a tool that is deny by default still refuses under YOLO — it is not the user’s rule', async () => {
    expect((await make('yolo').evaluate(tool('nuke', 'deny'), {}, ctx())).permission).toBe('deny');
  });

  it('per conversation: one tab in YOLO asks, another with YOLO off refuses', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['rm -rf /'] } }));
    const p = make('off');
    const input = { command: 'rm -rf /' };
    expect((await p.evaluate(bash(), input, ctx({ yolo: true }))).permission).toBe('confirm');
    expect((await p.evaluate(bash(), input, ctx({ yolo: false }))).permission).toBe('deny');
    expect((await p.evaluate(bash(), input, ctx({ yolo: true, yoloPlus: true }))).permission).toBe(
      'deny',
    );
  });
});

describe('directory rules, at each YOLO level', () => {
  const rules = {
    schemaVersion: 1 as const,
    rules: [{ directory: 'secret', denyTools: ['write'] }],
  };
  const dctx = (): Context =>
    ({ meta: {}, projectRoot: dir, workingDir: dir, cwd: dir, hasRead: () => false }) as never;
  const make = (yolo: boolean, yoloPlus: boolean) =>
    new DirectoryPermissionPolicy(new DefaultPermissionPolicy({ trustFile, yolo, yoloPlus }), {
      policy: rules,
    });
  const input = () => ({ path: path.join(dir, 'secret', 'a.txt'), content: 'x' });

  it('off and YOLO+ refuse, YOLO asks — and explain() agrees', async () => {
    for (const [yolo, plus, want] of [
      [false, false, 'deny'],
      [true, false, 'confirm'],
      [true, true, 'deny'],
    ] as const) {
      const p = make(yolo, plus);
      const decision = await p.evaluate(write(), input(), dctx());
      expect(decision.permission, `${yolo}/${plus}`).toBe(want);
      expect((await p.explain(write(), input(), dctx())).decision.permission).toBe(want);
    }
  });

  it('YOLO never turns a directory refusal into a question for a call the inner policy refuses', async () => {
    const p = new DirectoryPermissionPolicy(
      new DefaultPermissionPolicy({ trustFile, yolo: true }),
      { policy: { schemaVersion: 1, rules: [{ directory: 'secret', denyTools: ['nuke'] }] } },
    );
    const decision = await p.evaluate(
      tool('nuke', 'deny', { capabilities: ['fs.write'] }),
      input(),
      dctx(),
    );
    expect(decision.permission).toBe('deny');
  });
});

describe('answering a YOLO question about the user’s own rule', () => {
  it('"always" runs once (yes) there, and only there', () => {
    for (const always of ['always', 'always-exact', 'always-command', 'always-tool'] as const) {
      expect(userRuleAnswer(always, 'yolo_user_rule')).toBe('yes');
      expect(userRuleAnswer(always, 'yolo_destructive')).toBe(always);
      expect(userRuleAnswer(always, undefined)).toBe(always);
    }
    for (const other of ['yes', 'no', 'deny', 'abort'] as const) {
      expect(userRuleAnswer(other, 'yolo_user_rule')).toBe(other);
    }
  });
});
