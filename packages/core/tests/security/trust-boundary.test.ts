import { describe, expect, it } from 'vitest';
import {
  createCompatibilityTrustBoundary,
  decodeTrustBoundaryDecision,
  decodeTrustBoundaryRequest,
  isTrustDecisionAllowed,
} from '../../src/security/trust-boundary.js';

const requests = [
  {
    version: 1,
    requestId: 'acp-write-1',
    actor: { kind: 'agent', id: 'agent-1', sessionId: 'session-1' },
    surface: 'acp',
    capability: 'filesystem.write',
    subject: { kind: 'path', id: '/project/src/index.ts', attributes: { operation: 'write' } },
    risk: 'high',
    scope: { projectId: 'project-1', sessionId: 'session-1', cwd: '/project' },
  },
  {
    version: 1,
    requestId: 'webui-process-1',
    actor: { kind: 'user', id: 'local-user' },
    surface: 'webui',
    capability: 'process.spawn',
    subject: { kind: 'command', id: 'pnpm test' },
    risk: 'elevated',
    scope: { projectId: 'project-1', cwd: '/project' },
    authContext: { method: 'session', principalId: 'local-user' },
  },
  {
    version: 1,
    requestId: 'hq-control-1',
    actor: { kind: 'remote-client', id: 'hq-browser' },
    surface: 'hq',
    capability: 'hq.control',
    subject: { kind: 'resource', id: 'fleet/agent-1' },
    risk: 'critical',
    scope: { projectId: 'project-1' },
    authContext: { method: 'bearer-token', tokenId: 'hq-token-1' },
  },
  {
    version: 1,
    requestId: 'desktop-external-1',
    actor: { kind: 'user', id: 'desktop-user' },
    surface: 'desktop',
    capability: 'desktop.open-external',
    subject: { kind: 'url', id: 'https://example.test/docs' },
    risk: 'elevated',
    scope: { projectId: 'project-1' },
    authContext: { method: 'local-process', principalId: 'desktop-user' },
  },
] as const;

describe('TrustBoundary contract', () => {
  it('audits trusted-host compatibility decisions through the shared contract', async () => {
    const decoded = decodeTrustBoundaryRequest(requests[0]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const entries: unknown[] = [];
    const boundary = createCompatibilityTrustBoundary({
      audit: (entry) => {
        entries.push(entry);
      },
    });

    const decision = await boundary.evaluate(decoded.value);

    expect(isTrustDecisionAllowed(decision)).toBe(true);
    expect(entries).toMatchObject([
      {
        request: decoded.value,
        decision: { kind: 'allow', policyId: 'trusted-host-compat-v1' },
        evaluatedAt: expect.any(String),
      },
    ]);
    expect(isTrustDecisionAllowed({ kind: 'confirm', reason: 'ask', prompt: 'Continue?' })).toBe(
      false,
    );
  });

  it.each(requests)('decodes $surface authorization requests', (request) => {
    expect(decodeTrustBoundaryRequest(request)).toEqual({ ok: true, value: request });
  });

  it('denies critical risk actions from remote-client actors by default', async () => {
    const boundary = createCompatibilityTrustBoundary();
    // remote-client + critical → denied (host.shutdown)
    const shutdownDecision = await boundary.evaluate({
      version: 1,
      requestId: 'rc-critical',
      actor: { kind: 'remote-client' },
      surface: 'webui',
      capability: 'host.shutdown',
      subject: { kind: 'process', id: '1234' },
      risk: 'critical',
      scope: {},
    });
    expect(shutdownDecision.kind).toBe('deny');
    expect(isTrustDecisionAllowed(shutdownDecision)).toBe(false);

    // remote-client + critical → denied (process.terminate-all)
    const killAllDecision = await boundary.evaluate({
      version: 1,
      requestId: 'rc-critical-2',
      actor: { kind: 'remote-client' },
      surface: 'webui',
      capability: 'process.terminate-all',
      subject: { kind: 'resource', id: 'tracked-process-registry' },
      risk: 'critical',
      scope: {},
    });
    expect(killAllDecision.kind).toBe('deny');
  });

  // E4 (AC-005 / API-003): the previous single-shape boundary
  // (`remote-client + critical`) let every other request through,
  // including `remote-client + high` (terminal spawn, process kill).
  // The fix denies `high` and `critical` for `remote-client` actors by
  // default; the legacy opt-out is preserved for migration paths.
  it('denies high risk from remote-client (terminal spawn, process kill)', async () => {
    const boundary = createCompatibilityTrustBoundary();
    const decision = await boundary.evaluate({
      version: 1,
      requestId: 'rc-high',
      actor: { kind: 'remote-client' },
      surface: 'webui',
      capability: 'process.spawn',
      subject: { kind: 'command', id: 'pnpm test' },
      risk: 'high',
      scope: {},
    });
    expect(isTrustDecisionAllowed(decision)).toBe(false);
  });

  it('allows critical risk from remote-client only when BOTH opt-outs are set', async () => {
    const boundary = createCompatibilityTrustBoundary({
      denyCriticalRiskRemoteClient: false,
      denyHighRiskRemoteClient: false,
    });
    const decision = await boundary.evaluate({
      version: 1,
      requestId: 'rc-critical-allowed',
      actor: { kind: 'remote-client' },
      surface: 'webui',
      capability: 'host.shutdown',
      subject: { kind: 'process', id: '1234' },
      risk: 'critical',
      scope: {},
    });
    expect(isTrustDecisionAllowed(decision)).toBe(true);
  });

  it('allows critical risk from non-remote-client actors (user/agent)', async () => {
    const boundary = createCompatibilityTrustBoundary();
    for (const actorKind of ['user', 'agent', 'system', 'plugin'] as const) {
      const decision = await boundary.evaluate({
        version: 1,
        requestId: `actor-${actorKind}`,
        actor: { kind: actorKind },
        surface: 'webui',
        capability: 'host.shutdown',
        subject: { kind: 'process', id: '1234' },
        risk: 'critical',
        scope: {},
      });
      expect(isTrustDecisionAllowed(decision)).toBe(true);
    }
  });

  it('rejects generic bypass flags at the boundary', () => {
    const result = decodeTrustBoundaryRequest({
      ...requests[0],
      yolo: true,
      metadata: { force: true },
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: '$.yolo', message: 'generic authorization bypass fields are forbidden' },
        { path: '$.metadata.force', message: 'generic authorization bypass fields are forbidden' },
      ],
    });
  });

  it('decodes all decision forms including a constrained scoped token', () => {
    const decisions = [
      { kind: 'allow', reason: 'read-only capability' },
      { kind: 'deny', reason: 'path escapes project' },
      { kind: 'confirm', reason: 'destructive operation', prompt: 'Allow deletion?' },
      {
        kind: 'scoped-token',
        reason: 'approved delegated task',
        token: 'opaque-token',
        tokenId: 'delegation-1',
        expiresAt: '2026-07-21T16:00:00.000Z',
        capabilities: ['filesystem.read', 'filesystem.write'],
        scope: { projectId: 'project-1', cwd: '/project' },
      },
    ];
    for (const decision of decisions) {
      expect(decodeTrustBoundaryDecision(decision)).toEqual({ ok: true, value: decision });
    }
  });

  it('rejects malformed scoped tokens', () => {
    const result = decodeTrustBoundaryDecision({
      kind: 'scoped-token',
      reason: 'missing authority constraints',
      token: '',
      tokenId: '',
      expiresAt: '',
      capabilities: [],
      scope: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((issue) => issue.path)).toEqual([
        '$.token',
        '$.tokenId',
        '$.expiresAt',
        '$.capabilities',
        '$.scope',
      ]);
  });
});
