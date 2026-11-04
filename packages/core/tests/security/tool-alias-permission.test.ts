import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { setSessionPermissionOverrides } from '../../src/security/session-permission-overrides.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-alias-policy-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const fixture: Tool = {
  name: 'canonical',
  aliases: ['old_name'],
  description: 'Read the fixture.',
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  subjectKey: 'path',
  async execute() {
    return 'fixture';
  },
};
function context(): AgentContext {
  return { cwd: dir, projectRoot: dir, meta: {} } as AgentContext;
}

describe('alias permission identity', () => {
  it.each([
    { yolo: false, yoloPlus: false },
    { yolo: true, yoloPlus: false },
    { yolo: true, yoloPlus: true },
  ])('keeps a tool default deny above a queued one-shot grant ($yolo/$yoloPlus)', async (mode) => {
    const policy = new DefaultPermissionPolicy({
      trustFile: path.join(dir, 'trust.json'),
      ...mode,
    });
    const ctx = context();
    const confirm = { ...fixture, permission: 'confirm' as const };
    await policy.evaluate(confirm, { path: 'warmup.txt' }, ctx);
    policy.allowOnce({ tool: fixture.name, pattern: 'control.txt' });
    expect((await policy.evaluate(confirm, { path: 'control.txt' }, ctx)).permission).toBe('auto');
    policy.allowOnce({ tool: fixture.name, pattern: 'blocked.txt' });
    const denied = { ...fixture, permission: 'deny' as const };
    expect((await policy.evaluate(denied, { path: 'blocked.txt' }, ctx)).permission).toBe('deny');
    expect((await policy.explain(denied, { path: 'blocked.txt' }, ctx)).decision.permission).toBe(
      'deny',
    );
  });
  it.each(['old_name', 'old_*'])(
    'retains persistent refusals for %s and explains the same decision',
    async (name) => {
      const trustFile = path.join(dir, 'trust.json');
      await fs.writeFile(
        trustFile,
        JSON.stringify({ [name]: { deny: ['*'] }, canonical: { allow: ['*'] } }),
      );
      const policy = new DefaultPermissionPolicy({ trustFile });
      const ctx = context();
      expect((await policy.evaluate(fixture, { path: 'file.txt' }, ctx)).permission).toBe('deny');
      expect((await policy.explain(fixture, { path: 'file.txt' }, ctx)).decision.permission).toBe(
        'deny',
      );
    },
  );

  it('invalidates a cached approval when an alias adds a refusal', async () => {
    const trustFile = path.join(dir, 'trust.json');
    await fs.writeFile(trustFile, JSON.stringify({ old_name: { deny: ['*'] } }));
    const policy = new DefaultPermissionPolicy({ trustFile });
    const ctx = context();
    expect(
      (await policy.evaluate({ ...fixture, aliases: undefined }, { path: 'file.txt' }, ctx))
        .permission,
    ).toBe('auto');
    expect((await policy.evaluate(fixture, { path: 'file.txt' }, ctx)).permission).toBe('deny');
  });

  it('retains session refusals under the old name without transferring old grants', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile: path.join(dir, 'trust.json') });
    const ctx = context();
    const sessionContext = { ...ctx, session: { append: async () => {} } } as never;
    await setSessionPermissionOverrides(sessionContext, [{ effect: 'deny', tool: 'old_name' }]);
    expect((await policy.evaluate(fixture, { path: 'file.txt' }, ctx)).permission).toBe('deny');
    await setSessionPermissionOverrides(sessionContext, [{ effect: 'allow', tool: 'old_name' }]);
    expect(
      (await policy.evaluate({ ...fixture, permission: 'confirm' }, { path: 'file.txt' }, ctx))
        .permission,
    ).toBe('confirm');
  });

  it('enforces leader deny rules across tool aliases and subjectless calls in AutoApprovePermissionPolicy', async () => {
    const { AutoApprovePermissionPolicy } = await import(
      '../../src/security/auto-approve-policy.js'
    );
    const trustFile = path.join(dir, 'trust.json');
    await fs.writeFile(
      trustFile,
      JSON.stringify({
        canonical: { allow: [], deny: ['secret*'] },
      }),
    );
    const policy = new AutoApprovePermissionPolicy(['fs.read'], { trustFile });
    const aliasTool: Tool = {
      ...fixture,
      name: 'old_name',
      aliases: ['canonical'],
      capabilities: ['fs.read'],
    };
    const aliasDec = await policy.evaluate(aliasTool, { path: 'secret-doc.txt' });
    expect(aliasDec.permission).toBe('deny');

    const subjectlessDec = await policy.evaluate({ ...fixture, capabilities: ['fs.read'] }, {});
    expect(subjectlessDec.permission).toBe('deny');
  });
});
