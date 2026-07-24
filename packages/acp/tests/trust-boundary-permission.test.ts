import type { TrustBoundary, TrustBoundaryDecision } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../src/client/permission.js';
import {
  makeTrustBoundaryPermissionPolicy,
  toTrustBoundaryRequest,
  trustBoundaryPermissionCoverage,
} from '../src/client/trust-boundary-permission.js';

function request(
  rawInput: Record<string, unknown>,
  kind: 'edit' | 'execute' = 'edit',
): PermissionRequest {
  return {
    toolCall: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1' as never,
      title: 'Privileged callback',
      kind,
      status: 'pending',
      rawInput,
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    signal: new AbortController().signal,
  };
}

describe('ACP TrustBoundary adapter', () => {
  it('maps filesystem callbacks to a scoped semantic request', () => {
    expect(
      toTrustBoundaryRequest(request({ path: '/project/file.ts', sessionId: 'session-1' }), {
        actor: { kind: 'subagent', id: 'agent-1' },
        scope: { projectId: 'project-1', cwd: '/project' },
      }),
    ).toEqual({
      version: 1,
      requestId: 'call-1',
      actor: { kind: 'subagent', id: 'agent-1', sessionId: 'session-1' },
      surface: 'acp',
      capability: 'filesystem.write',
      subject: { kind: 'path', id: '/project/file.ts', attributes: { toolKind: 'edit' } },
      risk: 'elevated',
      scope: { projectId: 'project-1', cwd: '/project', sessionId: 'session-1' },
      metadata: { title: 'Privileged callback', toolKind: 'edit' },
    });
  });

  it.each([
    [{ kind: 'allow', reason: 'policy allow' }, 'allow'],
    [{ kind: 'deny', reason: 'policy deny' }, 'reject'],
    [{ kind: 'confirm', reason: 'needs consent', prompt: 'Allow?' }, 'reject'],
    [
      {
        kind: 'scoped-token',
        reason: 'delegated',
        token: 'opaque',
        tokenId: 'token-1',
        expiresAt: '2026-07-21T16:00:00.000Z',
        capabilities: ['process.spawn'],
        scope: { cwd: '/project' },
      },
      'allow',
    ],
  ] satisfies Array<[TrustBoundaryDecision, string]>)(
    'maps $kind decisions to ACP option $1',
    async (decision, optionId) => {
      const boundary: TrustBoundary = { evaluate: vi.fn(async () => decision) };
      const policy = makeTrustBoundaryPermissionPolicy({ boundary });
      await expect(policy(request({ command: 'node' }, 'execute'))).resolves.toEqual({
        outcome: 'selected',
        optionId,
      });
    },
  );

  it('does not call the boundary after cancellation', async () => {
    const boundary: TrustBoundary = { evaluate: vi.fn() };
    const policy = makeTrustBoundaryPermissionPolicy({ boundary });
    const cancelled = request({ command: 'node' }, 'execute');
    const controller = new AbortController();
    controller.abort();
    cancelled.signal = controller.signal;
    await expect(policy(cancelled)).resolves.toEqual({ outcome: 'cancelled' });
    expect(boundary.evaluate).not.toHaveBeenCalled();
  });

  it('maps all risk, capability, subject, and option fallbacks', () => {
    const coverage = trustBoundaryPermissionCoverage;
    for (const kind of ['read', 'search', 'fetch', 'think'] as const) {
      expect(coverage.riskFor(kind)).toBe('low');
    }
    expect(coverage.riskFor('move')).toBe('elevated');
    expect(coverage.riskFor('delete')).toBe('high');
    expect(coverage.riskFor(undefined)).toBe('elevated');

    expect(coverage.capabilityFor(request({ path: '/x' }, 'edit'))).toBe('filesystem.write');
    expect(coverage.capabilityFor(request({ path: '/x' }, 'execute'))).toBe('filesystem.write');
    const read = request({ path: '/x' });
    read.toolCall.kind = 'read';
    expect(coverage.capabilityFor(read)).toBe('filesystem.read');
    const fetchRequest = request({});
    fetchRequest.toolCall.kind = 'fetch';
    expect(coverage.capabilityFor(fetchRequest)).toBe('network.fetch');
    const unknown = request({});
    unknown.toolCall.kind = undefined;
    unknown.toolCall.title = undefined;
    expect(coverage.capabilityFor(unknown)).toBe('tool.unknown');
    expect(coverage.subjectFor(unknown)).toMatchObject({
      kind: 'resource',
      id: 'ACP tool call call-1',
    });
    expect(toTrustBoundaryRequest(unknown, {})).toMatchObject({
      actor: { kind: 'agent' },
      scope: {},
      metadata: { toolKind: null },
    });
    const pathUnknown = request({ path: '/unknown' });
    pathUnknown.toolCall.kind = undefined;
    expect(coverage.subjectFor(pathUnknown).attributes).toEqual({ toolKind: null });
    expect(coverage.subjectFor(request({ command: 'node' }, 'edit'))).toMatchObject({
      kind: 'command',
      id: 'node',
    });
    const commandUnknown = request({ command: 'node' });
    commandUnknown.toolCall.kind = undefined;
    expect(coverage.subjectFor(commandUnknown).attributes).toEqual({ toolKind: null });

    expect(
      coverage.pickOption([{ optionId: 'always', name: 'Always', kind: 'allow_always' }], true),
    ).toEqual({ outcome: 'selected', optionId: 'always' });
    expect(
      coverage.pickOption([{ optionId: 'never', name: 'Never', kind: 'reject_always' }], false),
    ).toEqual({ outcome: 'selected', optionId: 'never' });
    expect(coverage.pickOption([], true)).toEqual({ outcome: 'cancelled' });
  });

  it('uses actor session fallback, auth context, and detects cancellation after evaluation', async () => {
    const mapped = toTrustBoundaryRequest(request({}, 'edit'), {
      actor: { kind: 'agent', sessionId: 'actor-session' },
      authContext: { method: 'bearer-token' },
    });
    expect(mapped.actor.sessionId).toBe('actor-session');
    expect(mapped.scope.sessionId).toBe('actor-session');
    expect(mapped.authContext).toEqual({ method: 'bearer-token' });

    const controller = new AbortController();
    const pending = request({}, 'edit');
    pending.signal = controller.signal;
    const boundary: TrustBoundary = {
      evaluate: vi.fn(async (): Promise<TrustBoundaryDecision> => {
        controller.abort();
        return { kind: 'allow', reason: 'allowed' };
      }),
    };
    await expect(makeTrustBoundaryPermissionPolicy({ boundary })(pending)).resolves.toEqual({
      outcome: 'cancelled',
    });
  });
});
