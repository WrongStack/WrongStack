import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PermissionDecision, PermissionPolicy, Tool } from '@wrongstack/contracts/types';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { ACPClientPermissionPolicy } from '../src/acp-session-modes.js';

/**
 * F104: the "always allow" permission memory keys grants by
 * `tool.name + stableJson(input)`. stableJson sorted object keys with
 * localeCompare, which returns 0 for DISTINCT canonically-equivalent keys
 * ('é' vs 'e\u0301' — proven on this en-US host). The tie leaves the sort
 * insertion-order-dependent, so the same logical input built with a different
 * property order serializes differently, the grant key misses, and the user
 * is re-prompted for an action they already always-allowed. A stable
 * canonicalizer must use code-unit order.
 */
const ROOT = mkdtempSync(path.join(tmpdir(), 'ws-f104-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const ctx = {
  meta: {},
  session: { id: 's1' },
  cwd: ROOT,
  projectRoot: ROOT,
} as unknown as AgentContext;

const bash = {
  name: 'bash',
  description: 'run',
  inputSchema: { type: 'object', properties: {} },
  capabilities: ['shell.arbitrary'],
  execute: async () => ({ content: '' }),
} as unknown as Tool;

function arbiterSaying(decision: PermissionDecision): PermissionPolicy {
  return { evaluate: vi.fn(async () => decision) } as unknown as PermissionPolicy;
}
function client(...answers: string[]) {
  const fn = vi.fn();
  for (const optionId of answers) fn.mockResolvedValueOnce({ outcome: 'selected', optionId });
  return fn;
}

describe('always-allow memory is stable under canonical-equivalent key order (F104)', () => {
  it('honors the grant when the same logical input is rebuilt in another property order', async () => {
    const arbiter = arbiterSaying({ permission: 'confirm' } as PermissionDecision);
    const ask = client('allow_always');
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => 'default', arbiter });
    const first = { é: 1, 'e\u0301': 2 };
    const second = { 'e\u0301': 2, é: 1 };
    await policy.evaluate(bash, first, ctx);
    const verdict = await policy.evaluate(bash, second, ctx);
    expect(ask, 'the grant must not re-prompt').toHaveBeenCalledTimes(1);
    expect(verdict.permission).toBe('auto');
  });

  it('still honors the grant for identical-order input (control)', async () => {
    const arbiter = arbiterSaying({ permission: 'confirm' } as PermissionDecision);
    const ask = client('allow_always');
    const policy = new ACPClientPermissionPolicy(ask, { mode: () => 'default', arbiter });
    const input = { command: 'ls', flag: true };
    await policy.evaluate(bash, input, ctx);
    const verdict = await policy.evaluate(bash, { ...input }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(verdict.permission).toBe('auto');
  });
});
