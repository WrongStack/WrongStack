import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  createGovernanceEvidenceCandidate,
  decodeGovernanceIpcEnvelope,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceProjectClient,
  GovernanceProjectServer,
  governanceProjectDatabasePath,
  governanceProjectServerEndpoint,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskContractV1,
  type TransitionFacts,
} from '../src/index.js';

const facts: TransitionFacts = {
  contractApproved: true,
  planApproved: true,
  withinAutonomyEnvelope: true,
  authorization: 'automatic',
  executionGrantValid: true,
  snapshotCurrent: true,
  requiredEvidenceSatisfied: true,
  blockingFindings: 0,
  rollbackVerified: true,
};

function contract(): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Exercise project-scoped governance IPC without runtime integration.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repo-hash', baselinePolicy: 'required' },
    requirements: [
      { id: 'req-1', text: 'Serialize canonical revisions.', acceptanceCriteriaIds: ['ac-1'] },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'Only one concurrent command wins.', evidenceKinds: ['test'] },
    ],
    autonomy: {
      tier: 'A2',
      allowedOperations: ['repository_read', 'file_edit', 'focused_check'],
      humanApprovalRequiredFor: [],
      allowedPaths: ['packages/governance/**'],
      deniedPaths: [],
      budget: {
        maxChangedFiles: 10,
        maxChangedLines: 1_000,
        maxNewDependencies: 0,
        maxRetries: 3,
        maxReplans: 2,
        maxSubagents: 2,
        maxWallClockMs: 900_000,
      },
      autoAuthorizePlan: true,
      autoReplanLimit: 2,
      autoResolveReviewFixes: true,
    },
    requiredChecks: [{ id: 'check-1', kind: 'test', required: true, requirementIds: ['req-1'] }],
    requiredReviewDimensions: ['correctness'],
    rollbackClass: 'git_revert',
    assumptions: [],
    sources: {
      requirements: 'explicit_user',
      scope: 'project_policy',
      checks: 'deterministic_inference',
      autonomy: 'project_policy',
    },
  };
}

function request(
  type: 'health' | 'read_observations' | 'read_audit_observations',
  requestId: string,
) {
  return { protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION, requestId, type };
}

const temporaryDirectories: string[] = [];
const servers: GovernanceProjectServer[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wrongstack-governance-ipc-'));
  temporaryDirectories.push(root);
  return root;
}

function server(root: string): GovernanceProjectServer {
  const instance = new GovernanceProjectServer({
    projectRoot: root,
    projectId: 'project-1',
    resolveDecisionContext: () => ({ transitionFacts: facts }),
  });
  servers.push(instance);
  return instance;
}

function client(
  root: string,
  issued: { readonly token: string },
  clientId: string,
): GovernanceProjectClient {
  return new GovernanceProjectClient(root, {
    token: issued.token,
    projectId: 'project-1',
    clientId,
  });
}

afterEach(async () => {
  for (const instance of servers.splice(0).reverse()) await instance.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('governance project IPC', () => {
  it('derives deterministic project-scoped endpoints and database paths', () => {
    const root = projectRoot();
    expect(governanceProjectServerEndpoint(root)).toBe(
      governanceProjectServerEndpoint(join(root, '.')),
    );
    expect(governanceProjectServerEndpoint(root)).not.toBe(
      governanceProjectServerEndpoint(projectRoot()),
    );
    expect(governanceProjectDatabasePath(root)).toBe(
      join(root, '.wrongstack', 'governance', 'governance.sqlite'),
    );
  });

  it('serves authenticated requests and persists grant audit without storing the token', async () => {
    const root = projectRoot();
    const instance = server(root);
    expect(instance.storageOpen).toBe(false);
    await instance.start();
    expect(instance.storageOpen).toBe(true);
    expect(existsSync(instance.databasePath)).toBe(true);

    const issued = instance.issueGrant({
      clientId: 'reader',
      capabilities: ['task_read'],
      ttlMs: 60_000,
    });
    const remote = client(root, issued, 'reader');
    await expect(remote.request(request('health', 'request-health'))).resolves.toMatchObject({
      ok: true,
      result: { type: 'health', projectId: 'project-1', status: 'ready' },
    });
    await expect(
      remote.request(request('read_observations', 'request-ordinary-observations')),
    ).resolves.toMatchObject({
      ok: true,
      result: { type: 'observations', observations: [] },
    });
    await expect(
      remote.request(request('read_audit_observations', 'request-denied-audit')),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });

    const auditGrant = instance.issueGrant({
      clientId: 'auditor',
      capabilities: ['audit_read'],
      ttlMs: 60_000,
    });
    const auditor = client(root, auditGrant, 'auditor');
    const observations = await auditor.request(
      request('read_audit_observations', 'request-grant-audit'),
    );
    expect(observations).toMatchObject({ ok: true, result: { type: 'observations' } });
    if (!observations.ok || observations.result.type !== 'observations') return;
    expect(observations.result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'governance-capability-registry',
          category: 'capability_grant_issued',
          payload: expect.objectContaining({ clientId: 'reader', capabilities: ['task_read'] }),
        }),
      ]),
    );
    expect(JSON.stringify(observations)).not.toContain(issued.token);
  });

  it('reads identity-checked evidence candidates through task-scoped IPC', async () => {
    const root = projectRoot();
    const instance = server(root);
    await instance.start();
    const shadowGrant = instance.issueGrant({
      clientId: 'model-shadow',
      capabilities: ['shadow_observe'],
      ttlMs: 60_000,
    });
    const readerGrant = instance.issueGrant({
      clientId: 'evidence-reader',
      capabilities: ['task_read'],
      ttlMs: 60_000,
    });
    const shadow = client(root, shadowGrant, 'model-shadow');
    const reader = client(root, readerGrant, 'evidence-reader');
    const trace = {
      sessionId: 'session-ipc',
      task: { scope: 'kanban_task' as const, taskId: 'task-ipc', boardId: 'board-ipc' },
      plan: { state: 'available' as const, fingerprint: 'a'.repeat(64) },
      workspace: {
        state: 'captured' as const,
        manifestHash: 'b'.repeat(64),
        baseHead: 'c'.repeat(40),
      },
    };
    const candidate = createGovernanceEvidenceCandidate(trace, {
      toolCallId: 'tool-ipc',
      toolName: 'shell',
      ok: true,
      durationMs: 15,
      outputBytes: 42,
    });

    await expect(
      shadow.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'record-evidence-candidate',
        type: 'record_observation',
        observation: {
          observationId: 'candidate-ipc-1',
          projectId: 'project-1',
          taskId: 'task-ipc',
          source: 'model-shadow',
          category: 'evidence_candidate',
          observedAt: '2026-08-02T12:00:00.000Z',
          payload: { ...candidate, trace },
        },
      }),
    ).resolves.toMatchObject({ ok: true, result: { type: 'observation_result' } });
    const query = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'read-evidence-candidates',
      type: 'read_evidence_candidates',
      taskId: 'task-ipc',
      limit: 10,
    } as const;
    await expect(shadow.request(query)).resolves.toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    await expect(reader.request(query)).resolves.toMatchObject({
      ok: true,
      result: {
        type: 'evidence_candidates',
        taskId: 'task-ipc',
        candidates: [
          {
            source: 'model-shadow',
            candidateId: candidate.candidateId,
            evaluation: { state: 'eligible_for_evaluation', reasons: [] },
          },
        ],
        nextAfterSequence: null,
      },
    });
  });

  it('rejects credential fields inside the inner request over real transport', async () => {
    const root = projectRoot();
    const instance = server(root);
    await instance.start();
    const issued = instance.issueGrant({
      clientId: 'reader',
      capabilities: ['task_read'],
      ttlMs: 60_000,
    });
    const remote = client(root, issued, 'reader');

    await expect(
      remote.request({ ...request('health', 'request-injected'), token: issued.token }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request', details: [{ path: '$.token' }] },
    });
  });

  it('prevents shadow clients from spoofing identity or capability audit records', async () => {
    const root = projectRoot();
    const instance = server(root);
    await instance.start();
    const issued = instance.issueGrant({
      clientId: 'legacy-director',
      capabilities: ['shadow_observe'],
      ttlMs: 60_000,
    });
    const remote = client(root, issued, 'legacy-director');
    const observation = {
      observationId: 'spoofed-event',
      projectId: 'project-1',
      taskId: null,
      source: 'legacy-director',
      category: 'status_changed',
      observedAt: '2026-08-01T15:00:00.000Z',
      payload: { status: 'completed' },
    };

    await expect(
      remote.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-spoofed-source',
        type: 'record_observation',
        observation: { ...observation, source: 'trusted-policy' },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'identity_mismatch' } });
    await expect(
      remote.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-spoofed-audit',
        type: 'record_observation',
        observation: { ...observation, category: 'capability_grant_issued' },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
  });

  it('fails authentication for client rebinding and after server restart', async () => {
    const root = projectRoot();
    const first = server(root);
    await first.start();
    const issued = first.issueGrant({
      clientId: 'reader',
      capabilities: ['task_read'],
      ttlMs: 60_000,
    });
    const rebound = client(root, issued, 'other-client');
    await expect(rebound.request(request('health', 'request-rebound'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });

    const original = client(root, issued, 'reader');
    await first.close();
    const restarted = server(root);
    await restarted.start();
    await expect(original.request(request('health', 'request-restart'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });
  });

  it('keeps shadow observations separate from canonical task state across restart', async () => {
    const root = projectRoot();
    const first = server(root);
    await first.start();
    const shadowGrant = first.issueGrant({
      clientId: 'legacy-director',
      capabilities: ['shadow_observe'],
      ttlMs: 60_000,
    });
    const shadow = client(root, shadowGrant, 'legacy-director');
    await expect(
      shadow.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-shadow',
        type: 'record_observation',
        observation: {
          observationId: 'legacy-event-1',
          projectId: 'project-1',
          taskId: 'legacy-task',
          source: 'legacy-director',
          category: 'completion_claimed',
          observedAt: '2026-08-01T15:00:00.000Z',
          payload: { legacyStatus: 'completed' },
        },
      }),
    ).resolves.toMatchObject({ ok: true, result: { type: 'observation_result' } });
    await first.close();

    const restarted = server(root);
    await restarted.start();
    const readGrant = restarted.issueGrant({
      clientId: 'reader',
      capabilities: ['task_read'],
      ttlMs: 60_000,
    });
    const reader = client(root, readGrant, 'reader');
    await expect(
      reader.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-task',
        type: 'read_task',
        taskId: 'legacy-task',
      }),
    ).resolves.toMatchObject({ ok: true, result: { type: 'task', task: null } });
    const observations = await reader.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'request-observations',
      type: 'read_observations',
      taskId: 'legacy-task',
    });
    expect(observations).toMatchObject({
      ok: true,
      result: {
        observations: [
          {
            observationId: 'legacy-event-1',
            category: 'completion_claimed',
          },
        ],
      },
    });
  });

  it('elects the endpoint owner before opening a second SQLite connection', async () => {
    const root = projectRoot();
    const first = server(root);
    const second = server(root);
    await first.start();

    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(second.storageOpen).toBe(false);
    expect(first.storageOpen).toBe(true);
  });

  it('serializes concurrent clients so only one command wins the expected revision', async () => {
    const root = projectRoot();
    const instance = server(root);
    await instance.start();
    const firstGrant = instance.issueGrant({
      clientId: 'model-a',
      capabilities: ['command_submit'],
      ttlMs: 60_000,
    });
    const secondGrant = instance.issueGrant({
      clientId: 'model-b',
      capabilities: ['command_submit'],
      ttlMs: 60_000,
    });
    const first = client(root, firstGrant, 'model-a');
    const second = client(root, secondGrant, 'model-b');

    await expect(
      first.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-create',
        type: 'submit_command',
        command: {
          type: 'create_task',
          commandId: 'command-create',
          taskId: 'task-1',
          expectedRevision: 0,
          actor: 'model',
          issuedAt: '2026-08-01T15:01:00.000Z',
          projectId: 'project-1',
          contract: contract(),
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { execution: { decision: { accepted: true }, aggregate: { revision: 1 } } },
    });

    const responses = await Promise.all([
      first.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-scope',
        type: 'submit_command',
        command: {
          type: 'transition_task',
          commandId: 'command-scope',
          taskId: 'task-1',
          expectedRevision: 1,
          actor: 'model',
          issuedAt: '2026-08-01T15:02:00.000Z',
          to: 'scoped',
        },
      }),
      second.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-cancel',
        type: 'submit_command',
        command: {
          type: 'transition_task',
          commandId: 'command-cancel',
          taskId: 'task-1',
          expectedRevision: 1,
          actor: 'model',
          issuedAt: '2026-08-01T15:02:00.000Z',
          to: 'cancelled',
        },
      }),
    ]);
    const executions = responses.flatMap((response) =>
      response.ok && response.result.type === 'command_result' ? [response.result.execution] : [],
    );
    const handled = executions.flatMap((execution) => (execution.handled ? [execution] : []));
    expect(handled.filter((execution) => execution.decision.accepted)).toHaveLength(1);
    expect(
      handled.filter(
        (execution) => !execution.decision.accepted && execution.decision.code === 'stale_revision',
      ),
    ).toHaveLength(1);
  });

  it('strictly rejects capability injection in the transport credential envelope', () => {
    expect(
      decodeGovernanceIpcEnvelope({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        credential: {
          token: 'wsg_grant.secret',
          projectId: 'project-1',
          clientId: 'client-1',
          capabilities: ['command_submit'],
        },
        request: request('health', 'request-health'),
      }),
    ).toMatchObject({
      decoded: false,
      issues: [{ path: '$.credential.capabilities' }],
    });
  });
});
