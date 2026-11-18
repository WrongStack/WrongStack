import type { PermissionRequest } from '@wrongstack/acp';
import type { PermissionDecision, Tool } from '@wrongstack/contracts/types';
import { AutoApprovePermissionPolicy, ToolCapabilities } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { wrongstackAcpPermissionPolicy } from '../src/acp-permission-bridge.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeRequest(
  kind: string,
  rawInput: unknown,
  extra: Record<string, unknown> = {},
  signal = new AbortController().signal,
): PermissionRequest {
  return {
    toolCall: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-f529',
      kind,
      rawInput,
      ...extra,
    },
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    signal,
  } as unknown as PermissionRequest;
}

const ROOT = 'D:/proj';

describe('wrongstackAcpPermissionPolicy multi-location & abort hardening (F529)', () => {
  it('evaluates every path in locations/rawInput, rejects malformed rawInput, and cancels on mid-evaluate abort', async () => {
    const worker = new AutoApprovePermissionPolicy(Object.values(ToolCapabilities));
    const readTool = { name: 'read', capabilities: [ToolCapabilities.FS_READ] } as unknown as Tool;
    const writeTool = {
      name: 'write',
      capabilities: [ToolCapabilities.FS_WRITE],
    } as unknown as Tool;
    const bashTool = { name: 'bash', capabilities: [ToolCapabilities.EXEC] } as unknown as Tool;

    const policy = wrongstackAcpPermissionPolicy({
      evaluate: (tool, input, scope) => worker.evaluate(tool, input, scope as never),
      getTool: (name) =>
        name === 'read'
          ? readTool
          : name === 'write'
            ? writeTool
            : name === 'bash'
              ? bashTool
              : undefined,
      projectRoot: ROOT,
    });

    // Benign single location still passes; secondary credential location is refused.
    await expect(
      policy(makeRequest('read', {}, { locations: [{ path: '/tmp/claude-plan.md' }] })),
    ).resolves.toEqual({ outcome: 'selected', optionId: 'allow-once' });

    await expect(
      policy(
        makeRequest(
          'read',
          {},
          { locations: [{ path: '/tmp/claude-plan.md' }, { path: '/home/u/.ssh/id_rsa' }] },
        ),
      ),
    ).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });

    // Multi-location delete and edit check every target path.
    const deletePolicy = wrongstackAcpPermissionPolicy({
      evaluate: async (_tool, input): Promise<PermissionDecision> => {
        const cmd = String((input as { command?: unknown }).command ?? '');
        return cmd.includes('id_rsa')
          ? { permission: 'deny', source: 'trust', reason: 'protected key' }
          : { permission: 'auto', source: 'default' };
      },
      getTool: (name) => (name === 'bash' ? bashTool : name === 'write' ? writeTool : undefined),
      projectRoot: ROOT,
    });

    await expect(
      deletePolicy(
        makeRequest(
          'delete',
          { path: `${ROOT}/scratch.txt` },
          { locations: [{ path: `${ROOT}/scratch.txt` }, { path: '/home/u/.ssh/id_rsa' }] },
        ),
      ),
    ).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });

    // Ambiguous move locations and non-object rawInput are refused.
    await expect(
      deletePolicy(
        makeRequest(
          'move',
          { path: `${ROOT}/a.ts`, destination: `${ROOT}/b.ts` },
          { locations: [{ path: `${ROOT}/a.ts` }, { path: '/etc/passwd' }] },
        ),
      ),
    ).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });

    await expect(deletePolicy(makeRequest('execute', ['not-an-object']))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'reject',
    });

    // Abort while evaluate() is suspended returns cancelled instead of allow-once.
    const evalStarted = deferred<void>();
    const evalGate = deferred<PermissionDecision>();
    const abortCtrl = new AbortController();
    const gatedPolicy = wrongstackAcpPermissionPolicy({
      evaluate: async () => {
        evalStarted.resolve();
        return evalGate.promise;
      },
      getTool: (name) => (name === 'bash' ? bashTool : undefined),
      projectRoot: ROOT,
    });

    const inflight = gatedPolicy(makeRequest('execute', { command: 'ls' }, {}, abortCtrl.signal));
    await evalStarted.promise;
    abortCtrl.abort();
    evalGate.resolve({ permission: 'auto', source: 'default' });
    await expect(inflight).resolves.toEqual({ outcome: 'cancelled' });
  });
});
