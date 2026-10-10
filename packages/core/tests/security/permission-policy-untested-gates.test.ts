import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { compilePermissionRules } from '../../src/security/permission-rules.js';
import {
  __resetProcessLockdownForTests,
  lockYoloOff,
} from '../../src/security/process-lockdown.js';
import type { Tool } from '../../src/types/index.js';

function tool(
  name: string,
  permission: 'auto' | 'confirm' | 'deny' = 'confirm',
  opts: {
    riskTier?: 'safe' | 'standard' | 'destructive';
    mutating?: boolean;
    capabilities?: readonly string[];
  } = {},
): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating: opts.mutating ?? true,
    riskTier: opts.riskTier,
    capabilities: opts.capabilities,
    async execute() {
      return 'ok';
    },
  };
}

const ctx = (root: string): Context =>
  ({ hasRead: () => false, projectRoot: root, cwd: root, workingDir: root }) as never as Context;

describe('permission gates the scoped suite did not pin', () => {
  let dir: string;
  let trustFile: string;
  const previousHome = process.env['WRONGSTACK_HOME'];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-gates-'));
    trustFile = path.join(dir, 'trust.json');
  });

  afterEach(async () => {
    __resetProcessLockdownForTests();
    if (previousHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = previousHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('auto-approves a tool named by an --allowed-tools prefix', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile, launchAllowedTools: ['mcp__*'] });
    const decision = await policy.evaluate(tool('mcp__gh__issue'), {}, ctx(dir));
    expect(decision).toMatchObject({
      permission: 'auto',
      source: 'trust',
      launchGrant: true,
    });
    expect(decision.reason).toContain('--allowed-tools');
  });

  it('a tool-scoped approval still asks for a destructive non-shell tool', async () => {
    await fs.writeFile(
      trustFile,
      JSON.stringify({ nuke: { allow: ['wrongstack-approval:v1:tool'] } }),
    );
    const policy = new DefaultPermissionPolicy({ trustFile });
    const decision = await policy.evaluate(
      tool('nuke', 'confirm', { riskTier: 'destructive' }),
      { target: 'a' },
      ctx(dir),
    );
    expect(decision).toMatchObject({
      permission: 'confirm',
      source: 'trust',
      reason: 'Broad approval does not cover destructive calls',
    });
  });

  it('YOLO still asks before a structured git force-push', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await policy.evaluate(
      tool('git', 'auto', { capabilities: ['shell.restricted'] }),
      { command: 'push', force: true },
      ctx(dir),
    );
    expect(decision).toMatchObject({
      permission: 'confirm',
      source: 'yolo_destructive',
    });
    expect(decision.reason).toContain('git-history');
  });

  it('YOLO still asks before binding a well-known credential', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await policy.evaluate(
      tool('provider_check', 'confirm', { mutating: false, capabilities: ['net.outbound'] }),
      { envVars: ['ANTHROPIC_API_KEY'] },
      ctx(dir),
    );
    expect(decision).toMatchObject({
      permission: 'confirm',
      source: 'yolo_destructive',
    });
    expect(decision.reason).toContain('credential-bind');
  });

  it('YOLO still asks before a config.mutate write into the agent state root', async () => {
    const home = path.join(dir, 'home');
    await fs.mkdir(home);
    process.env['WRONGSTACK_HOME'] = home;
    const policy = new DefaultPermissionPolicy({
      trustFile,
      yolo: true,
      yoloDestructive: true,
    });
    const decision = await policy.evaluate(
      tool('mcp_control', 'confirm', { capabilities: ['config.mutate'] }),
      { path: path.join(home, 'trust.json') },
      ctx(dir),
    );
    expect(decision).toMatchObject({
      permission: 'confirm',
      source: 'yolo_destructive',
    });
    expect(decision.reason).toContain('agent-state');
  });

  it('an allow whose allowUntil equals now is expired for evaluate and for the rule list', async () => {
    const fixed = 1_700_000_000_000;
    await fs.writeFile(
      trustFile,
      JSON.stringify({
        expired: { allow: ['src/a.ts'], allowUntil: fixed },
        live: { allow: ['src/b.ts'], allowUntil: fixed + 1_000 },
      }),
    );
    const realNow = Date.now;
    Date.now = () => fixed;
    try {
      const policy = new DefaultPermissionPolicy({ trustFile });
      const decision = await policy.evaluate(tool('expired'), { path: 'src/a.ts' }, ctx(dir));
      expect(decision.permission).toBe('confirm');
      expect(decision.source).not.toBe('trust');

      const rules = await policy.listRules();
      expect(rules.some((rule) => rule.step === 'trust allow' && rule.action === 'expired')).toBe(
        false,
      );
      expect(rules.some((rule) => rule.step === 'trust allow' && rule.action === 'live')).toBe(
        true,
      );
    } finally {
      Date.now = realNow;
    }
  });

  it('lists the executor dangerous-capability gate only when YOLO is off', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile });
    const rules = await compilePermissionRules(policy);
    expect(rules.some((rule) => rule.step === 'dangerous capability')).toBe(true);
    const yoloRules = await compilePermissionRules(policy, undefined, { yolo: true });
    expect(yoloRules.some((rule) => rule.step === 'dangerous capability')).toBe(false);
  });

  it('denyOnce replaces a decision that was already allowed', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile });
    const read = tool('read', 'auto', { mutating: false, capabilities: ['fs.read'] });
    const first = await policy.evaluate(read, { path: 'src/a.ts' }, ctx(dir));
    expect(first).toMatchObject({ permission: 'auto', source: 'default' });
    policy.denyOnce({ tool: 'read', pattern: 'src/a.ts' });
    const second = await policy.evaluate(read, { path: 'src/a.ts' }, ctx(dir));
    expect(second).toMatchObject({ permission: 'deny', source: 'deny' });
  });

  it('reload drops a session soft deny', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile });
    await policy.reload();
    policy.denyOnce({ tool: 'edit', pattern: 'src/a.ts' });
    await policy.reload();
    const decision = await policy.evaluate(tool('edit'), { path: 'src/a.ts' }, ctx(dir));
    expect(decision.permission).toBe('confirm');
    expect(decision.source).not.toBe('deny');
  });

  it('a ttlMs allow is still in force for a policy that loads the file afterwards', async () => {
    const writer = new DefaultPermissionPolicy({ trustFile });
    const before = Date.now();
    await writer.trust({ tool: 'edit', pattern: 'src/**', ttlMs: 60_000 });
    const stored = JSON.parse(await fs.readFile(trustFile, 'utf8')) as {
      edit?: { allowUntil?: number };
    };
    expect(stored.edit?.allowUntil).toBeGreaterThan(before);

    const fresh = new DefaultPermissionPolicy({ trustFile });
    const decision = await fresh.evaluate(tool('edit'), { path: 'src/a.ts' }, ctx(dir));
    expect(decision).toMatchObject({ permission: 'auto', source: 'trust' });
  });

  it('getYolo stays false while the process lockdown forces YOLO off', () => {
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });
    lockYoloOff();
    policy.setYolo(true);
    expect(policy.getYolo()).toBe(false);
  });
});
