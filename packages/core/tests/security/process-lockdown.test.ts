import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import {
  __resetProcessLockdownForTests,
  lockToProjectRoot,
  lockYoloOff,
} from '../../src/security/process-lockdown.js';

const write: Tool = {
  name: 'write',
  description: '',
  inputSchema: { type: 'object' },
  permission: 'confirm',
  mutating: true,
  async execute() {
    return '';
  },
};

describe('process lockdown', () => {
  afterEach(() => __resetProcessLockdownForTests());

  it('lockYoloOff makes a YOLO policy prompt again, whatever setYolo says', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lockdown-'));
    try {
      const policy = new DefaultPermissionPolicy({
        trustFile: path.join(root, 'trust.json'),
        yolo: true,
      });
      const ctx = { projectRoot: root, cwd: root, hasRead: () => false } as unknown as Context;
      const input = { path: path.join(root, 'a.txt'), content: 'x' };
      expect((await policy.evaluate(write, input, ctx)).permission).toBe('auto');
      lockYoloOff();
      policy.setYolo(true);
      expect(policy.getYolo()).toBe(false);
      expect((await policy.evaluate(write, input, ctx)).permission).toBe('confirm');
      expect(
        (
          await policy.evaluate(write, input, {
            ...ctx,
            meta: { yolo: true },
          } as unknown as Context)
        ).permission,
      ).toBe('confirm');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('lockToProjectRoot pins Context.allowOutsideProjectRoot to false', async () => {
    const { Context: ContextClass } = await import('../../src/core/context.js');
    const ctx = Object.create(ContextClass.prototype) as Context;
    ctx.allowOutsideProjectRoot = true;
    expect(ctx.allowOutsideProjectRoot).toBe(true);
    lockToProjectRoot();
    expect(ctx.allowOutsideProjectRoot).toBe(false);
    ctx.allowOutsideProjectRoot = true;
    expect(ctx.allowOutsideProjectRoot).toBe(false);
  });
});
